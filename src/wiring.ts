/**
 * Turns resolved settings into the dependencies a poll cycle needs.
 *
 * Composes discover (Jira REST, the configured credential) and groom (storecode, its own MCP
 * session) so the split holds structurally: discover only learns which issues are new, groom
 * reads and writes one issue by key. `WRITE_BACK` unlocks writes inside groom's own MCP session,
 * not the REST credential, so every grooming mutation is attributable to that session's Jira user.
 *
 * Grooming is itself analyse (`runTriage`, always `--no-write`) → gate (`assertPostable`) → post
 * (`runPost`), composed in that order so a bad verdict costs a retry, not an unreviewable write.
 */

import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { type IssueDetail, JiraClient } from "./jira/client.ts";
import {
  buildInFlightJql,
  buildNewIssuesJql,
  buildReviewQueueJql,
  buildSolveQueueJql,
  jqlValue,
} from "./jira/jql.ts";
import {
  DEFAULT_IMAGE_STAGE_OPTIONS,
  type ImageStageResult,
  describeStagedImages,
  removeStagedImages,
  stageImages,
} from "./attachments/stage.ts";
import type { TicketRef } from "./jira/types.ts";
import { createLogger } from "./logger.ts";
import { FileSink, clearRejection, writeRejection } from "./output/sink.ts";
import type { PollDeps } from "./poller.ts";
import {
  type Settings,
  SettingsError,
  failFirstCheck,
  flag,
  list,
  numeric,
  solveMode,
} from "./settings.ts";
import type { ClaimCapabilities } from "./solve/claim.ts";
import { createCommandRunner } from "./solve/exec.ts";
import { repoFromLabels } from "./solve/labels.ts";
import type { SolveDependencies, SolveOutcome, SolveRequest } from "./solve/orchestrator.ts";
import type { AdvanceRequest, PublishRequest, WorktreeSource } from "./solve/delivery.ts";
import type { BotIdentity, FindPrRequest } from "./solve/pr.ts";
import { createPassRunner } from "./solve/passes.ts";
import { readScope } from "./solve/read-scope.ts";
import { composePullRequest } from "./solve/pr-text.ts";
import type { SolveCandidate, SolveDeps } from "./solve/poller.ts";
import type { ReviewCycleDeps, WatchedTicket } from "./solve/review-cycle.ts";
import { type RenderedTicket, renderTicket } from "./solve/ticket.ts";
import { withFitnessNote } from "./triage/fitness-note.ts";
import { byStatusPriority } from "./triage/order.ts";
import { UnpostableError, assertPostable } from "./triage/gate.ts";
import { createTicketCommenter } from "./solve/commenter.ts";
import type { TicketCommenter } from "./solve/feedback.ts";
import { runPost } from "./triage/poster.ts";
import { type TriagePayload, type TriageRunOptions, runTriage } from "./triage/runner.ts";
import { type RelevanceChecker, createRelevanceChecker } from "./watch/relevance.ts";

const pollLog = createLogger("poll");
const reviewLog = createLogger("review");
const solveLog = createLogger("solve");
const triageLog = createLogger("triage");

/** Skill that reads nothing, so it must not be made to wait on Atlassian. */
const MOCK_SKILL = "mock-triage";

/**
 * Skills that stand in for the real one while the pipeline is exercised: neither consults the
 * vault nor writes a dashboard. Anything else is treated as real, including a fork of it — a
 * fork given a vault it doesn't need loses nothing, but one silently denied one would.
 */
const STAND_IN_SKILLS: ReadonlySet<string> = new Set([MOCK_SKILL, "live-triage-probe"]);

export function createDiscover(
  settings: Settings,
  client: JiraClient,
): (cursor: string | null) => Promise<readonly TicketRef[]> {
  const statuses = list(settings, "TRIAGE_ONLY_STATUS");

  // Rendered here and thrown away: an unquotable status becomes a startup crash instead of a
  // `JqlError` raised inside every poll cycle from now on.
  for (const status of statuses) {
    jqlValue(status, "status");
  }

  // Once, at wiring, at `info` — unlike the per-cycle `poll.query` below. The credential can't
  // check names against the board (`/project/SSX/statuses` 404s for it), so `named` flags which
  // entries are an unverified claim rather than a pinned id — a status name that fails to
  // resolve would otherwise match nothing and leave the service looking healthy while triaging
  // zero tickets.
  pollLog.info("poll.status_filter", {
    statuses,
    restricted: statuses.length > 0,
    named: statuses.filter((entry) => !/^[0-9]+$/.test(entry.trim())),
  });

  return async (cursor: string | null): Promise<readonly TicketRef[]> => {
    const jql = buildNewIssuesJql({
      project: settings.JIRA_PROJECT,
      components: list(settings, "JIRA_COMPONENTS"),
      excludedTypeIds: list(settings, "JIRA_EXCLUDED_TYPES"),
      // The list logged above, not a second read of it.
      statuses,
      cursor,
      now: new Date(),
      overlapMs: numeric(settings, "CURSOR_OVERLAP_MS"),
      firstRunMinutes: numeric(settings, "FIRST_RUN_LOOKBACK_MINUTES"),
    });
    // `debug`, not `info`: this JQL is the same every tick apart from a timestamp and says
    // nothing about what happened. Ask for it with `LOG_LEVEL=debug` when the queue surprises.
    pollLog.debug("poll.query", { jql });
    return await client.search(jql);
  };
}

/**
 * How one issue is handed to the skill.
 *
 * One function because three callers (the daemon, `poll:once`, `triage:once`) need the same
 * answer, and a hand-built copy drifts the moment the real skill grows a requirement.
 */
export function buildTriageOptions(settings: Settings, issueKey: string): TriageRunOptions {
  const isMock = settings.SKILL_NAME === MOCK_SKILL;
  const isStandIn = STAND_IN_SKILLS.has(settings.SKILL_NAME);

  // Checked here rather than left to the skill: without a vault, `intake-triage` asks a human
  // for the path, which in a headless run gets no answer and a clean exit with no verdict.
  if (!isStandIn && settings.VAULT_PATH === "") {
    throw new SettingsError(["VAULT_PATH"]);
  }

  return {
    issueKey,
    skillName: settings.SKILL_NAME,
    executable: settings.STORECODE_PATH,
    workingDirectory: process.cwd(),
    // At least 1ms: zero isn't "no timeout", it's a budget already expired, so it would kill
    // every run on the watchdog's first tick.
    idleMs: numeric(settings, "SESSION_IDLE_TIMEOUT_MS", 1),
    maxRunMs: numeric(settings, "TRIAGE_TIMEOUT_MS", 1),
    deep: false,
    // A skill that reads nothing shouldn't be required to hold a live Atlassian session.
    requiredMcpServers: isMock ? [] : ["atlassian"],
    ...(isMock ? { allowedTools: [] as readonly string[] } : {}),
    ...(isStandIn ? {} : { vaultPath: settings.VAULT_PATH, noHtml: true }),
  };
}

/**
 * How long the daemon sleeps between polls.
 *
 * Lives here, not in `index.ts` (which runs `main` on import), so the value can be asserted
 * about without starting the service. The floor matters: zero is an unthrottled loop against
 * Jira, not an eager poll.
 */
export function pollIntervalMs(settings: Settings): number {
  return numeric(settings, "POLL_INTERVAL_MS", 1);
}

/**
 * How long the daemon sleeps between looks at the pull requests under review.
 *
 * A separate cadence from polling on purpose: new-issue polling is a latency choice over a
 * window, but a review sweep is tied to how fast a human reviewer replies, and coupling it to
 * `POLL_INTERVAL_MS` would make a polling-cadence change silently a review-cadence change too.
 * Same zero floor as `pollIntervalMs`, and here it would also be unthrottled against `gh`.
 */
export function reviewIntervalMs(settings: Settings): number {
  return numeric(settings, "REVIEW_POLL_MS", 1);
}

/**
 * How long the daemon sleeps between sweeps of the watched tickets.
 *
 * The slowest of the three cadences because its trigger is a person changing their mind, which
 * happens on the order of days — checking every few minutes can't make that answer arrive
 * sooner, only multiply reads that find nothing. It's also the one cadence where *shorter* is a
 * spend decision, not a latency one: the memo bounding the relevance check lives in memory, so a
 * restart, not this interval, is what actually buys a re-check.
 */
export function watchIntervalMs(settings: Settings): number {
  return numeric(settings, "WATCH_POLL_MS", 1);
}

/**
 * Whether a run may post, given the settings.
 *
 * A stand-in is pinned to preview only: neither produces a real §11 mutation to post, so
 * posting one would not be a rehearsal.
 */
export function shouldPost(settings: Settings): boolean {
  return !STAND_IN_SKILLS.has(settings.SKILL_NAME) && flag(settings, "WRITE_BACK");
}

/**
 * The ticket's images on disk, or nothing, for the analyst to read.
 *
 * A staging failure degrades the run to text rather than failing it, and returns nothing rather
 * than "no images" — those are different claims about a ticket that triaged fine yesterday.
 */
async function stageForTriage(
  client: JiraClient,
  issueKey: string,
): Promise<ImageStageResult | null> {
  try {
    const detail = await client.fetchDetail(issueKey);
    return await stageImages(
      client,
      detail.attachments,
      join(tmpdir(), "jira-police-attach"),
      issueKey,
      DEFAULT_IMAGE_STAGE_OPTIONS,
    );
  } catch (error) {
    triageLog.warn("triage.image_staging_failed", {
      issueKey,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function createGroom(settings: Settings): (ticket: TicketRef) => Promise<TriagePayload> {
  // Built once, so a misconfiguration surfaces at startup rather than on the
  // first issue that happens to arrive.
  const template = buildTriageOptions(settings, "");
  const posting = shouldPost(settings);
  // Null is the off switch, so the extra detail fetch cannot happen by accident:
  // there is no client to make it with.
  const imageClient = flag(settings, "TRIAGE_IMAGES") ? createJiraClient(settings) : null;

  return async (ticket: TicketRef) => {
    // Only the key crosses over; the skill reads everything else over its own session.
    const staged = imageClient === null ? null : await stageForTriage(imageClient, ticket.key);
    let analysed: TriagePayload;
    try {
      analysed = await runTriage({
        ...template,
        issueKey: ticket.key,
        ...(staged === null
          ? {}
          : {
              images: {
                block: describeStagedImages(staged),
                directory: staged.outcome === "staged" ? staged.directory : null,
              },
            }),
      });
    } finally {
      // In `finally`: a thrown triage is retried by the poller, and a leak per attempt is a
      // leak per ticket that never succeeds.
      if (staged?.outcome === "staged") {
        await removeStagedImages(staged.directory);
      }
    }

    // Spliced in before the gate, and unconditionally, so `assertPostable` checks the exact
    // text that would reach Jira, and a preview or rejection artifact shows the real body too.
    const payload = withFitnessNote(analysed);

    if (!posting) {
      return payload;
    }

    // Throws rather than returning a flag: the poller retries a thrown triage, which is what a
    // refused verdict deserves since the fault is usually one the model can avoid next time.
    // Recorded before re-thrown: a gate that destroys the text it objected to can't be audited.
    try {
      assertPostable(payload, ticket.key);
    } catch (error) {
      if (error instanceof UnpostableError) {
        await writeRejection(settings.OUTPUT_DIR, {
          issueKey: ticket.key,
          violations: error.violations,
          verdict: payload.verdict,
          labels: payload.labels,
          dorPlaceholders: payload.dorPlaceholders,
          mutation: { ...payload.mutation },
        });
      }
      throw error;
    }

    // Cleared before the write, not after, so a poster failure doesn't leave a stale refusal
    // standing as the explanation for a new problem.
    await clearRejection(settings.OUTPUT_DIR, ticket.key);

    await runPost({
      issueKey: ticket.key,
      mutation: payload.mutation,
      executable: template.executable,
      workingDirectory: template.workingDirectory,
      idleMs: template.idleMs,
      maxRunMs: template.maxRunMs,
    });

    return payload;
  };
}

export function createJiraClient(settings: Settings): JiraClient {
  return new JiraClient({
    baseUrl: settings.JIRA_BASE_URL,
    email: settings.JIRA_EMAIL,
    auth: settings.JIRA_AUTH,
  });
}

/**
 * `signal` is optional: the one-shot CLI runs a single cycle and has nothing to interrupt. The
 * daemon passes its shutdown signal so a stop request is honoured between issues, not just cycles.
 */
export function createPollDeps(
  settings: Settings,
  client: JiraClient,
  signal?: AbortSignal,
): PollDeps {
  const priority = list(settings, "TRIAGE_STATUS_PRIORITY");

  // Logged once at wiring, like `poll.status_filter`: an ordering nobody can see is one nobody
  // can judge. Unlike that one, a status matching nothing here isn't silent — `poll.order`
  // shows it every cycle.
  pollLog.info("poll.status_priority", { priority, ordered: priority.length > 0 });

  return {
    fetchCandidates: createDiscover(settings, client),
    triage: createGroom(settings),
    sink: new FileSink(settings.OUTPUT_DIR),
    statePath: settings.STATE_PATH,
    // Omitted entirely when unset, rather than passed as a created-ascending comparator, so
    // the poller's own default is what actually runs.
    ...(priority.length === 0 ? {} : { order: byStatusPriority(priority) }),
    ...(signal === undefined ? {} : { signal }),
  };
}

/**
 * Narrows a discovered issue to what the solve queue reasons about.
 *
 * Drops `created`, `issueTypeId`, `issueTypeName` deliberately: the issue-type restriction on
 * auto mode is enforced in the JQL, where Jira resolves ids and localised names correctly.
 * Handing the type through here would invite a second, weaker check against an English name.
 */
function toSolveCandidate(ticket: TicketRef): SolveCandidate {
  return {
    key: ticket.key,
    summary: ticket.summary,
    url: ticket.url,
    labels: ticket.labels,
    updated: ticket.updated,
  };
}

/**
 * Composes the solve-queue cycle from settings, the way `createPollDeps` composes the grooming
 * one: `solve:once` and the daemon must run the same composition, or the rehearsal proves
 * nothing. Nothing here can write — `SolveDeps` has no write function to give — so reading the
 * board and being able to change it stay two different call sites (`createClaimCapabilities`).
 * `solveMode` is called here, at composition, so an unrecognised `SOLVE_MODE` fails before a
 * query is built rather than at the point where its value would have gated a human's go-ahead.
 */
/**
 * The solve pipeline's way of saying something on a ticket.
 *
 * Composed here, not in the command, for the same reason as `createSolveDeps`: constructing a
 * capability is the privilege grant, and it should be findable in one file. Budgeted on
 * `TRIAGE_TIMEOUT_MS`, not a `SOLVE_*` value — this is a short session holding finished text and
 * calling one Atlassian tool, the same shape as the triage poster, not a model reading a repo.
 */
export function createSolveCommenter(settings: Settings): TicketCommenter {
  return createTicketCommenter({
    executable: settings.STORECODE_PATH,
    workingDirectory: process.cwd(),
    // Floored at 1ms on the same grounds as everywhere else: zero is not "no
    // timeout", it is one that expired before the session started.
    idleMs: numeric(settings, "SESSION_IDLE_TIMEOUT_MS", 1),
    maxRunMs: numeric(settings, "TRIAGE_TIMEOUT_MS", 1),
  });
}

/**
 * The watch's cheap gate: does what happened on the ticket answer the sendback?
 *
 * Composed here for the same reason as the commenter above. `createRelevanceChecker` builds a
 * session with no MCP server and no tools, so there's nothing to withhold or scope. Budgeted on
 * `TRIAGE_TIMEOUT_MS` for the same reason as the commenter: this reads a prompt and answers, not
 * a model reading a repository.
 */
export function createWatchChecker(settings: Settings): RelevanceChecker {
  return createRelevanceChecker({
    executable: settings.STORECODE_PATH,
    workingDirectory: process.cwd(),
    idleMs: numeric(settings, "SESSION_IDLE_TIMEOUT_MS", 1),
    maxRunMs: numeric(settings, "TRIAGE_TIMEOUT_MS", 1),
  });
}

export function createSolveDeps(
  settings: Settings,
  client: JiraClient,
  signal?: AbortSignal,
): SolveDeps {
  const mode = solveMode(settings);
  const project = settings.JIRA_PROJECT;
  const components = list(settings, "JIRA_COMPONENTS");

  const queueJql = buildSolveQueueJql({
    project,
    components,
    mode,
    autoIssueTypes: list(settings, "SOLVE_AUTO_ISSUE_TYPES"),
  });
  const inFlightJql = buildInFlightJql({ project, components });

  // Built eagerly: a malformed query (unsafe project key, or auto mode with no issue types)
  // should stop the process at startup, not whichever cycle first reaches the board.
  return {
    enabled: flag(settings, "SOLVE_ENABLED"),
    mode,
    allowedRepos: list(settings, "SOLVE_REPOS"),
    maxConcurrent: numeric(settings, "MAX_CONCURRENT_SOLVES"),
    // Handed to the cycle report too, so the artifact prints the query that produced its
    // numbers rather than a second rendering that could disagree.
    queueJql,
    inFlightJql,
    fetchQueue: async () => {
      // `debug`, for the reason given at `poll.query`; also handed to the cycle report verbatim.
      solveLog.debug("solve.query", { jql: queueJql });
      return (await client.search(queueJql)).map(toSolveCandidate);
    },
    countInFlight: async () => {
      solveLog.debug("solve.in_flight_query", { jql: inFlightJql });
      return (await client.search(inFlightJql)).length;
    },
    ...(signal === undefined ? {} : { signal }),
  };
}

/**
 * Composes the review cycle, the way `createSolveDeps` composes the solve one.
 *
 * `look` and `act` come from the caller rather than being built here, because they're the two
 * halves the cycle exists to keep apart — a cheap read for every watched pull request, a paid
 * round for the few with work — and building them here would hide that seam from a reader asking
 * how often this spends. What's built here decides scope: the query, the master switch, and the
 * per-tick bound.
 */
export function createReviewCycleDeps(
  settings: Settings,
  client: JiraClient,
  look: ReviewCycleDeps["look"],
  act: ReviewCycleDeps["act"],
  signal?: AbortSignal,
): ReviewCycleDeps {
  const watchJql = buildReviewQueueJql({
    project: settings.JIRA_PROJECT,
    components: list(settings, "JIRA_COMPONENTS"),
  });

  return {
    // The same switch the solve queue reads, checked again here: a review round pushes a
    // commit to a pull request people are reading, so "is this on" isn't a question to answer
    // once.
    enabled: flag(settings, "SOLVE_ENABLED"),
    watchJql,
    maxRounds: numeric(settings, "MAX_REVIEW_ROUNDS_PER_TICK", 0),
    fetchWatched: async () => {
      // `debug`, for the reason given at `poll.query`.
      reviewLog.debug("review.query", { jql: watchJql });
      return (await client.search(watchJql)).map(toWatchedTicket);
    },
    look,
    act,
    ...(signal === undefined ? {} : { signal }),
  };
}

/**
 * The same five fields `toSolveCandidate` takes, and deliberately not that function.
 *
 * Two queues selecting on different facts share a shape today, but sharing the mapping would
 * make the next field either queue needs a field both get — see `WatchedTicket`'s own note.
 */
function toWatchedTicket(ticket: TicketRef): WatchedTicket {
  return {
    key: ticket.key,
    summary: ticket.summary,
    url: ticket.url,
    labels: ticket.labels,
    updated: ticket.updated,
  };
}

/**
 * The claim's write. **This function is the Phase B2 privilege grant.**
 *
 * Kept separate so "what can this process do" is answerable by reading call sites, not by a
 * poller that constructs a writer just to fetch a queue. The narrowing lives at the credential —
 * `updateLabels` refuses anything outside the `agent:` namespace — so this adapter stays thin
 * rather than duplicating a check that would go stale here.
 */
export function createClaimCapabilities(client: JiraClient): ClaimCapabilities {
  return {
    readLabels: async (issueKey) => (await client.fetchDetail(issueKey)).labels,
    applyLabels: async (issueKey, change) => {
      await client.updateLabels(issueKey, { add: change.add, remove: change.remove });
    },
  };
}

/**
 * The solver's dependencies. **This function is the phase C privilege grant.**
 *
 * The only place that composes something that can change a repository: a `CommandRunner` (git,
 * the repo's test commands) and a `PassRunner` (a model session holding `Write`/`Edit`). Kept
 * separate from `createSolveDeps`, whose poller runs every cycle and needs neither — folding
 * them together would mean reading the board also constructs the ability to write to a repo.
 *
 * `VAULT_PATH` is required for the same reason `buildTriageOptions` requires it: a pass that
 * can't read the branch/commit conventions there will invent its own and fail the checks later.
 */
export function createSolveRunDeps(settings: Settings): SolveDependencies {
  if (settings.VAULT_PATH === "") {
    throw new SettingsError(["VAULT_PATH"]);
  }

  return {
    commands: createCommandRunner(),
    passes: createPassRunner({
      executable: settings.STORECODE_PATH,
      // Same floor as the triage budget: zero isn't "no timeout", it's one already expired.
      idleMs: numeric(settings, "SESSION_IDLE_TIMEOUT_MS", 1),
      maxRunMs: numeric(settings, "SOLVE_TIMEOUT_MS", 1),
    }),
  };
}

/** Why a ticket cannot be solved, as a sentence rather than a null. */
export class NotSolvableError extends Error {}

/**
 * Turns one ticket into the request `solveTicket` runs.
 *
 * The repository comes from the ticket's own `svc:` label, checked against `SOLVE_REPOS`.
 * `repoFromLabels` returns `null` for any ambiguous reading; `SOLVE_REPOS` says which repos may
 * be written to at all — kept as two checks so a missing label and a forbidden repository are
 * reported as the two different problems they are.
 */
/**
 * Where worktrees are cut, and why it is configurable.
 *
 * Defaults to the system temp directory: temporary by construction, and away from the checkout
 * so a failed run's evidence isn't mistaken for the repository. Configurable because a path some
 * tooling refuses to open makes the mandatory human diff review impossible to perform. Blank
 * means the default, since freezing today's `tmpdir()` into a string breaks the first machine
 * that disagrees.
 *
 * No `.trim()`: `readSettings` already trims, so a trim here would be dead code no test can
 * unplug.
 *
 * Resolved via `realpathSync`, because `git worktree list --porcelain` prints the resolved
 * path — on macOS `tmpdir()` is a symlink into `/private/var`, and an unresolved comparison
 * against it silently fails to match. `mkdirSync` runs first because `realpathSync` needs the
 * directory to exist; both are wrapped, falling back to the unresolved path on failure so a
 * resolution error can't make this worse than today's behaviour.
 */
function worktreeRoot(settings: Settings): string {
  const configured = settings.SOLVE_WORKTREE_ROOT;
  const root = configured === "" ? join(tmpdir(), "jira-police-solve") : configured;
  try {
    mkdirSync(root, { recursive: true });
    return realpathSync(root);
  } catch {
    return root;
  }
}

export function buildSolveRequest(
  settings: Settings,
  detail: IssueDetail,
  ticket: string,
): SolveRequest {
  if (settings.SOLVE_REPO_ROOT === "") {
    throw new SettingsError(["SOLVE_REPO_ROOT"]);
  }

  const repo = repoFromLabels(detail.labels);
  if (repo === null) {
    throw new NotSolvableError(
      `${detail.key} does not name exactly one repository. Labels: ${detail.labels.join(", ") || "(none)"}. The solver reads the svc: label and refuses to guess between none and several.`,
    );
  }

  const allowed = list(settings, "SOLVE_REPOS");
  if (!allowed.includes(repo)) {
    throw new NotSolvableError(
      `${detail.key} is about "${repo}", which is not in SOLVE_REPOS (${allowed.join(", ") || "empty"}). Nothing was touched.`,
    );
  }

  // Not `SOLVE_READ_DIRS` handed straight through: a name that isn't a directory here is
  // dropped rather than joined onto the root, since `join` would happily turn `..` into a path
  // above it. Rejections are logged, not thrown — a typo must not stop the ticket, but must not
  // be silent either.
  const scope = readScope(settings.SOLVE_REPO_ROOT, list(settings, "SOLVE_READ_DIRS"), repo);
  if (scope.rejected.length > 0) {
    solveLog.warn("solve.read_dirs_rejected", { issueKey: detail.key, names: scope.rejected });
  }

  return {
    issueKey: detail.key,
    ticket,
    summary: detail.summary,
    repoPath: join(settings.SOLVE_REPO_ROOT, repo),
    readDirs: scope.dirs,
    parentDirectory: worktreeRoot(settings),
    baseRef: settings.SOLVE_BASE_REF,
    vaultPath: settings.VAULT_PATH,
    failFirstCheck: failFirstCheck(settings),
    gitTimeoutMs: numeric(settings, "SOLVE_GIT_TIMEOUT_MS", 1),
    stepTimeoutMs: numeric(settings, "SOLVE_STEP_TIMEOUT_MS", 1),
    installTimeoutMs: numeric(settings, "SOLVE_INSTALL_TIMEOUT_MS", 1),
  };
}

/**
 * **This function is the phase D privilege grant.**
 *
 * Composes the argument to `publish`, the first thing in this service that makes work visible
 * to other people: it commits, pushes to a shared remote, and opens a pull request. Kept
 * separate from `buildSolveRequest` so "can this process open a pull request" is answerable by
 * grepping one name. The base branch has its remote stripped, since gh reports a PR base like
 * `origin/main` as missing rather than naming the setting that caused it.
 */
export function buildPublishRequest(
  settings: Settings,
  outcome: Extract<SolveOutcome, { kind: "verified" }>,
  issueKey: string,
): PublishRequest {
  const { title, body } = composePullRequest(outcome, {
    issueKey,
    jiraBaseUrl: settings.JIRA_BASE_URL,
    maxReviewRounds: numeric(settings, "MAX_REVIEW_ITERATIONS", 0),
  });

  return {
    worktree: outcome.worktree,
    repo: githubRepoFor(settings, outcome.worktree.repoPath),
    baseBranch: baseBranchOf(settings.SOLVE_BASE_REF),
    commit: outcome.commit,
    title,
    body,
    identity: botIdentityOf(settings),
    timeoutMs: numeric(settings, "SOLVE_GH_TIMEOUT_MS", 1),
  };
}

/**
 * `origin/main` → `main`.
 *
 * A PR base must be a branch name on the remote, not a ref, or gh reports it as missing. Strips
 * only a leading `origin/`, once, so a branch legitimately named `release/origin/x` survives.
 */
export function baseBranchOf(baseRef: string): string {
  return baseRef.startsWith("origin/") ? baseRef.slice("origin/".length) : baseRef;
}

/**
 * The name and address this service puts on a commit.
 *
 * One function rather than the same literal at each call site, so "whose commit is this" has
 * one answer rather than several that can drift apart.
 */
export function botIdentityOf(settings: Settings): BotIdentity {
  return { name: settings.SOLVE_BOT_NAME, email: settings.SOLVE_BOT_EMAIL };
}

/**
 * `SOLVE_GITHUB_OWNER/<checkout name>`, or a settings error.
 *
 * The only place that decides which GitHub repository this service talks to; passing `--repo`
 * explicitly stops gh inferring a target from whatever remote a worktree happens to carry. Not
 * trimmed — `readSettings` already has. No default: the owner names an account a PR would be
 * opened against, not a thing to guess.
 */
export function githubRepoFor(settings: Settings, repoPath: string): string {
  if (settings.SOLVE_GITHUB_OWNER === "") {
    throw new SettingsError(["SOLVE_GITHUB_OWNER"]);
  }
  return `${settings.SOLVE_GITHUB_OWNER}/${basename(repoPath)}`;
}

/**
 * Where to look for the pull request a review round would act on.
 *
 * `cwd` is the checkout, not a worktree, because the search runs before anything is attached —
 * whether a PR exists decides if there's anything to attach to.
 */
export function buildFindPrRequest(
  settings: Settings,
  base: SolveRequest,
  branch: string,
): FindPrRequest {
  return {
    cwd: base.repoPath,
    repo: githubRepoFor(settings, base.repoPath),
    branch,
    timeoutMs: numeric(settings, "SOLVE_GH_TIMEOUT_MS", 1),
  };
}

/**
 * **This function is the phase D2 privilege grant.**
 *
 * The moment the service pushes to a pull request people are already reading, without being
 * asked again — one step further than `buildPublishRequest`, same reasoning.
 *
 * There's no `round` field: `advance` reads the count off the pull request's own marker
 * comment, the one place that survives the process, rather than a caller supplying a number it
 * can't know. `attach` is a function, not a `Worktree`, so a checkout is only cut for a round
 * that will actually run — `advance` reads the PR first and calls `attach` only then, and the
 * caller keeps ownership of removing it. `cwd` is the repository itself, since every request
 * `surveyReview` makes names its repository explicitly.
 */
export function buildAdvanceRequest(
  settings: Settings,
  base: SolveRequest,
  attach: WorktreeSource,
  number: number,
): AdvanceRequest {
  return {
    ...base,
    attach,
    cwd: base.repoPath,
    repo: githubRepoFor(settings, base.repoPath),
    number,
    identity: botIdentityOf(settings),
    maxRounds: numeric(settings, "MAX_REVIEW_ITERATIONS", 0),
    maxTotalRounds: numeric(settings, "MAX_PR_ROUNDS_TOTAL", 1),
    maxFailedStarts: numeric(settings, "MAX_FAILED_STARTS", 1),
    ghTimeoutMs: numeric(settings, "SOLVE_GH_TIMEOUT_MS", 1),
  };
}

/**
 * Reads one ticket in full and renders it as the text a solve pass is given.
 *
 * `JiraClient.search` returns a `TicketRef` with no description and no comments; a caller that
 * reaches for the object it already has produces a solver that reads a summary and calls it the
 * ticket.
 */
export function createTicketReader(
  client: JiraClient,
): (issueKey: string) => Promise<RenderedTicket & { readonly detail: IssueDetail }> {
  return async (issueKey: string) => {
    const detail = await client.fetchDetail(issueKey);
    const rendered = await renderTicket(client, detail);
    if (rendered.omitted.length > 0) {
      // Logged rather than swallowed: an asset the ticket pointed to but never shown to the
      // solver otherwise surfaces as a baffling diff.
      solveLog.warn("solve.ticket_attachments_omitted", { issueKey, omitted: rendered.omitted });
    }
    return { ...rendered, detail };
  };
}
