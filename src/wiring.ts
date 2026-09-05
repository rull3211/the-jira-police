/**
 * Turns resolved settings into the dependencies a poll cycle needs.
 *
 * Lives apart from both entry points because there are two — `poll:once` and
 * the daemon — and a difference between how they are wired would be a bug that
 * only shows up in production. Composing them from the same factory means the
 * one-shot run is a genuine rehearsal of the loop rather than a lookalike.
 *
 * The split between the two halves is enforced here as much as anywhere:
 *
 *   discover — Jira REST, with the configured credential, to learn *which*
 *              issues are new. Returns keys and metadata, nothing more.
 *   groom    — storecode, with its own Atlassian MCP session, to read what is
 *              *in* an issue, and to write the verdict back. Receives the key
 *              and nothing else.
 *
 * `WRITE_BACK` does not soften that split, it leans on it. The REST credential
 * stays read-only and discovery-only — it is withheld from the subprocess
 * entirely (`WITHHELD_FROM_CHILD` in the runner) — so every mutation is made by
 * the skill's own MCP session, as that session's own Jira user. Which means the
 * comments are attributable to a real account, and revoking the write is a
 * matter of this one setting rather than of re-scoping a token.
 *
 * Grooming is itself three steps, composed here and nowhere else:
 *
 *   analyse — `runTriage`, always `--no-write`, no write tool in its allowlist.
 *             Returns the verdict AND the mutation that verdict implies.
 *   gate    — `assertPostable`. Mechanical checks against the rules the skill
 *             sets for itself. Throwing here means nothing was sent.
 *   post    — `runPost`, a second session holding the finished text and no
 *             means of forming a different opinion about it.
 *
 * The order is the point. The service previously ran a single write-enabled
 * session, which posted its comment before the verdict could be inspected — so
 * the check could only ever report a bad write, never prevent one. Splitting
 * the run puts the check in the middle, where refusal still costs nothing but
 * a retry.
 */

import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { type IssueDetail, JiraClient } from "./jira/client.ts";
import { buildInFlightJql, buildNewIssuesJql, buildSolveQueueJql } from "./jira/jql.ts";
import type { TicketRef } from "./jira/types.ts";
import { logger } from "./logger.ts";
import { FileSink, clearRejection, writeRejection } from "./output/sink.ts";
import type { PollDeps } from "./poller.ts";
import { type Settings, SettingsError, flag, list, numeric, solveMode } from "./settings.ts";
import type { ClaimCapabilities } from "./solve/claim.ts";
import { createCommandRunner } from "./solve/exec.ts";
import { repoFromLabels } from "./solve/labels.ts";
import type { SolveDependencies, SolveOutcome, SolveRequest } from "./solve/orchestrator.ts";
import type { AdvanceRequest, PublishRequest } from "./solve/delivery.ts";
import type { FindPrRequest } from "./solve/pr.ts";
import type { Worktree } from "./solve/worktree.ts";
import { createPassRunner } from "./solve/passes.ts";
import { composePullRequest } from "./solve/pr-text.ts";
import type { SolveCandidate, SolveDeps } from "./solve/poller.ts";
import { type RenderedTicket, renderTicket } from "./solve/ticket.ts";
import { withFitnessNote } from "./triage/fitness-note.ts";
import { UnpostableError, assertPostable } from "./triage/gate.ts";
import { runPost } from "./triage/poster.ts";
import { type TriagePayload, type TriageRunOptions, runTriage } from "./triage/runner.ts";

/** Skill that reads nothing, so it must not be made to wait on Atlassian. */
const MOCK_SKILL = "mock-triage";

/**
 * Skills that stand in for the real one while the pipeline is being exercised.
 *
 * Neither consults the knowledge vault and neither writes a dashboard, so both
 * are spared the arguments that exist to make `intake-triage` survive a
 * headless run. Anything not on this list is treated as the real thing —
 * including a fork of it, which is the safer way round: a fork that gets a
 * vault it does not need loses nothing, whereas one silently denied a vault
 * would produce confident verdicts with no dedup behind them.
 */
const STAND_IN_SKILLS: ReadonlySet<string> = new Set([MOCK_SKILL, "live-triage-probe"]);

export function createDiscover(
  settings: Settings,
  client: JiraClient,
): (cursor: string | null) => Promise<readonly TicketRef[]> {
  return async (cursor: string | null): Promise<readonly TicketRef[]> => {
    const jql = buildNewIssuesJql({
      project: settings.JIRA_PROJECT,
      components: list(settings, "JIRA_COMPONENTS"),
      excludedTypeIds: list(settings, "JIRA_EXCLUDED_TYPES"),
      cursor,
      now: new Date(),
      overlapMs: numeric(settings, "CURSOR_OVERLAP_MS"),
      firstRunMinutes: numeric(settings, "FIRST_RUN_LOOKBACK_MINUTES"),
    });
    logger.info("poll.query", { jql });
    return await client.search(jql);
  };
}

/**
 * How one issue is handed to the skill.
 *
 * Its own function because three callers need the same answer — the daemon,
 * `poll:once` and `triage:once` — and the last of those used to build it by
 * hand. That copy drifted the moment the real skill grew requirements, which is
 * exactly the bug this module exists to prevent.
 */
export function buildTriageOptions(settings: Settings, issueKey: string): TriageRunOptions {
  const isMock = settings.SKILL_NAME === MOCK_SKILL;
  const isStandIn = STAND_IN_SKILLS.has(settings.SKILL_NAME);

  // Checked here rather than left to the skill. Without a vault `intake-triage`
  // stops and asks a human for the path — which in a headless run is a question
  // asked of nobody, followed by a clean exit and no verdict. Better to refuse
  // to start than to poll quietly forever.
  if (!isStandIn && settings.VAULT_PATH === "") {
    throw new SettingsError(["VAULT_PATH"]);
  }

  return {
    issueKey,
    skillName: settings.SKILL_NAME,
    executable: settings.STORECODE_PATH,
    workingDirectory: process.cwd(),
    // At least 1ms: zero is not "no timeout", it is a timeout that has already
    // expired, so it would kill every run instantly instead of disabling the cap.
    timeoutMs: numeric(settings, "TRIAGE_TIMEOUT_MS", 1),
    deep: false,
    // Requiring a live Atlassian session from a skill that reads nothing
    // would fail runs for a reason unrelated to what is being exercised.
    requiredMcpServers: isMock ? [] : ["atlassian"],
    ...(isMock ? { allowedTools: [] as readonly string[] } : {}),
    ...(isStandIn ? {} : { vaultPath: settings.VAULT_PATH, noHtml: true }),
  };
}

/**
 * How long the daemon sleeps between polls.
 *
 * One line, and it lives here rather than in `index.ts` for the same reason
 * `buildTriageOptions` does: `index.ts` runs `main` at import, so a value read
 * inside it cannot be asserted about without starting the service. The floor is
 * the point of the function — a zero interval is not an eager poll, it is an
 * unthrottled loop against Jira — and a floor nothing can test is a comment.
 */
export function pollIntervalMs(settings: Settings): number {
  return numeric(settings, "POLL_INTERVAL_MS", 1);
}

/**
 * Whether a run may post, given the settings.
 *
 * A stand-in is pinned to preview whatever the operator configured. Both
 * stand-ins exist to rehearse the pipeline, and a rehearsal that comments on a
 * real ticket is not a rehearsal — nor could it, since neither produces a real
 * §11 mutation to post.
 */
export function shouldPost(settings: Settings): boolean {
  return !STAND_IN_SKILLS.has(settings.SKILL_NAME) && flag(settings, "WRITE_BACK");
}

export function createGroom(settings: Settings): (ticket: TicketRef) => Promise<TriagePayload> {
  // Built once, so a misconfiguration surfaces at startup rather than on the
  // first issue that happens to arrive.
  const template = buildTriageOptions(settings, "");
  const posting = shouldPost(settings);

  return async (ticket: TicketRef) => {
    // The ticket carries summary, type and timestamps; only the key crosses
    // over. Everything else the skill needs, it reads over its own session.
    const analysed = await runTriage({ ...template, issueKey: ticket.key });

    // Spliced in before the gate runs, not after, so `assertPostable` checks the
    // exact text that reaches Jira rather than an earlier draft of it. Applied
    // unconditionally rather than only when posting, so a preview run and a
    // rejection artifact both show the real body too — a refusal that displays
    // a mutation which is not the one we would have sent is a refusal you
    // cannot audit.
    const payload = withFitnessNote(analysed);

    if (!posting) {
      return payload;
    }

    // Throws rather than returning a flag, deliberately. The poller treats a
    // thrown triage as a failed ticket: the key stays unrecorded, the cursor
    // stays behind it, and the next cycle tries again — which is what a refused
    // verdict deserves, since the fault is usually one the model can avoid
    // second time round. It also means no local report is written for a verdict
    // we would not post, matching how `TriageContradictionError` already
    // behaves. An incoherent verdict is not a partial result.
    // The refusal is recorded before it is re-thrown. A gate that destroys the
    // text it objected to cannot be audited, and an unauditable guard is one an
    // operator eventually switches off rather than one they come to trust.
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

    // The gate is satisfied, so any refusal recorded for this key describes a
    // mutation that no longer exists. Cleared before the write rather than
    // after, so a poster failure does not leave the old refusal standing as an
    // explanation for a new problem.
    await clearRejection(settings.OUTPUT_DIR, ticket.key);

    await runPost({
      issueKey: ticket.key,
      mutation: payload.mutation,
      executable: template.executable,
      workingDirectory: template.workingDirectory,
      timeoutMs: template.timeoutMs,
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
 * `signal` is optional because the one-shot CLI has nothing to interrupt: it
 * runs a single cycle and exits. The daemon passes its shutdown signal so a
 * stop request is honoured between issues rather than only between cycles.
 */
export function createPollDeps(
  settings: Settings,
  client: JiraClient,
  signal?: AbortSignal,
): PollDeps {
  return {
    fetchCandidates: createDiscover(settings, client),
    triage: createGroom(settings),
    sink: new FileSink(settings.OUTPUT_DIR),
    statePath: settings.STATE_PATH,
    ...(signal === undefined ? {} : { signal }),
  };
}

/**
 * Narrows a discovered issue to what the solve queue actually reasons about.
 *
 * `TicketRef` carries `created`, `issueTypeId` and `issueTypeName` as well, and
 * this drops all three deliberately. The issue-type restriction on auto mode is
 * enforced *in the JQL*, where Jira resolves ids and localised names correctly;
 * handing the type to the poller as well would invite a second, weaker copy of
 * that check written against the English name — on a board whose bug type is
 * `Feil`, a check that would silently match nothing.
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
 * Composes the solve-queue cycle from settings, the way `createPollDeps`
 * composes the grooming one and for the same reason: `solve:once` and the
 * daemon must be the same run, or the rehearsal proves nothing.
 *
 * Both reads go through the same Jira REST credential the grooming poller uses.
 * Nothing here can write — `SolveDeps` has no write function to give, which is
 * the Phase B refusal made structural rather than promised. The claim's write
 * is a separate composition, `createClaimCapabilities`, so that reading the
 * board and being able to change it stay two different call sites.
 *
 * `solveMode` is called here rather than deeper in, so an unrecognised
 * `SOLVE_MODE` fails at composition — before a query is built, before the board
 * is touched — instead of at the point where its value would have decided
 * whether a human's go-ahead was required.
 */
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

  // Both built eagerly, outside the closures. A malformed query — an unsafe
  // project key, or auto mode with no issue types — is a misconfiguration, and
  // it should stop the process at startup rather than on whichever cycle first
  // happens to reach the board.
  return {
    enabled: flag(settings, "SOLVE_ENABLED"),
    mode,
    allowedRepos: list(settings, "SOLVE_REPOS"),
    maxConcurrent: numeric(settings, "MAX_CONCURRENT_SOLVES"),
    // The same two constants the closures below run, handed to the cycle report
    // so the artifact prints the query that produced its numbers rather than a
    // second rendering of it that could disagree.
    queueJql,
    inFlightJql,
    fetchQueue: async () => {
      logger.info("solve.query", { jql: queueJql });
      return (await client.search(queueJql)).map(toSolveCandidate);
    },
    countInFlight: async () => {
      logger.info("solve.in_flight_query", { jql: inFlightJql });
      return (await client.search(inFlightJql)).length;
    },
    ...(signal === undefined ? {} : { signal }),
  };
}

/**
 * The claim's write. **This function is the Phase B2 privilege grant.**
 *
 * Its own function, called from nowhere that merely reads, for the same reason
 * `createSolveRunDeps` is separate: "what can this process do" should be
 * answerable by reading the call sites, and a poller that constructed a writer
 * in order to fetch a queue would make the answer "everything, always".
 *
 * The narrowing is at the credential — `updateLabels` refuses anything outside
 * the `agent:` namespace and cannot touch a field other than `labels` — so this
 * adapter is deliberately thin. There is nothing for it to check that is not
 * already checked one layer down, and a second copy of the rule here would be
 * the copy that goes stale.
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
 * Everything above composes readers. This composes the two objects that can
 * change something: a `CommandRunner`, which runs git and the repository's own
 * test commands, and a `PassRunner`, which starts a model session holding
 * `Write` and `Edit`. Nothing else in the process can do either, which is why
 * `solve-once.ts` could honestly refuse before this existed — the refusal was
 * structural, and this is the change that removes it.
 *
 * Kept separate from `createSolveDeps` rather than folded into it. The queue
 * poller runs on every cycle and needs none of this; if the two were one
 * function, reading the board would construct the ability to write to a
 * repository, and "what can this process do" would stop being answerable by
 * reading the call site.
 *
 * `VAULT_PATH` is required for the same reason `buildTriageOptions` requires it:
 * the branch naming and commit conventions the solver is held to live there, and
 * a pass that cannot read them will invent its own and fail the mechanical
 * checks afterwards. Failing at startup beats failing four sessions in.
 */
export function createSolveRunDeps(settings: Settings): SolveDependencies {
  if (settings.VAULT_PATH === "") {
    throw new SettingsError(["VAULT_PATH"]);
  }

  return {
    commands: createCommandRunner(),
    passes: createPassRunner({
      executable: settings.STORECODE_PATH,
      // Floored at 1ms on the same grounds as the triage budget: zero is not
      // "no timeout", it is a timeout that expired before the pass started.
      timeoutMs: numeric(settings, "SOLVE_TIMEOUT_MS", 1),
    }),
  };
}

/** Why a ticket cannot be solved, as a sentence rather than a null. */
export class NotSolvableError extends Error {}

/**
 * Turns one ticket into the request `solveTicket` runs.
 *
 * The repository is derived from the ticket's own `svc:` label and then checked
 * against `SOLVE_REPOS`, and both halves matter. `repoFromLabels` answers "which
 * repository is this ticket about" and returns `null` for every ambiguous
 * reading; `SOLVE_REPOS` answers "which repositories may be written to at all".
 * A ticket that names a repository nobody allowed is refused here rather than
 * discovered four sessions later, and the refusal names the repository so
 * widening the allowlist is an obvious next step rather than a guess.
 *
 * The two checks are deliberately not collapsed. One is about the ticket and
 * one is about the operator's configuration, and a single combined "is this
 * solvable" boolean would report a missing label and a forbidden repository as
 * the same event.
 */
/**
 * Where worktrees are cut, and why it is configurable.
 *
 * The default is the system temp directory — temporary by construction, removed
 * on success, and deliberately nowhere near the checkout so a failed run leaves
 * its evidence somewhere obviously not the repository. That default is still
 * right and is unchanged.
 *
 * It became configurable because of what the default costs on macOS, where
 * `tmpdir()` resolves under `/private/var`. The pipeline's own rule is that a
 * human reads the worktree diff by hand before anything leaves the machine, and
 * a path some tooling refuses to open makes that review impossible to perform —
 * so the setting exists to buy back a step the process depends on, not to make
 * the location a matter of taste. Blank means the default, because freezing
 * today's `tmpdir()` into a string breaks the first machine that disagrees.
 *
 * No `.trim()` here, and that is deliberate rather than an omission. Every value
 * `readSettings` produces is already trimmed, and a whitespace-only entry has
 * already become the empty string by the time it arrives — so a trim on this
 * line is a guard no test can unplug, which is the kind of reassuring dead code
 * this project treats as worse than none. `SOLVE_MODE` does trim, and should not.
 */
function worktreeRoot(settings: Settings): string {
  const configured = settings.SOLVE_WORKTREE_ROOT;
  return configured === "" ? join(tmpdir(), "jira-police-solve") : configured;
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

  return {
    issueKey: detail.key,
    ticket,
    summary: detail.summary,
    repoPath: join(settings.SOLVE_REPO_ROOT, repo),
    parentDirectory: worktreeRoot(settings),
    baseRef: settings.SOLVE_BASE_REF,
    vaultPath: settings.VAULT_PATH,
    gitTimeoutMs: numeric(settings, "SOLVE_GIT_TIMEOUT_MS", 1),
    stepTimeoutMs: numeric(settings, "SOLVE_STEP_TIMEOUT_MS", 1),
    installTimeoutMs: numeric(settings, "SOLVE_INSTALL_TIMEOUT_MS", 1),
  };
}

/**
 * **This function is the phase D privilege grant.**
 *
 * What it composes is the argument to `publish`, and `publish` is the first
 * thing in this service that makes work visible to other people: it commits,
 * pushes a branch to a shared remote, opens a pull request and puts a reviewer
 * on it. Nothing before it leaves the machine. That is why it is a separate
 * function from `buildSolveRequest` rather than more fields on it — a reader
 * asking "can this process open a pull request" should find the answer by
 * grepping for one name and looking at its call sites.
 *
 * Three of the four values it needs are configuration and one is derived:
 *
 *  - the repository is `SOLVE_GITHUB_OWNER/<name>`, where the name has already
 *    been through `SOLVE_REPOS`. Passing `--repo` explicitly is what stops gh
 *    inferring a target from whatever remote the worktree carries.
 *  - the base branch is `SOLVE_BASE_REF` with its remote stripped. A PR is
 *    opened against a branch name, and `origin/main` is not one — gh reports
 *    that as a missing base, a long way from the setting that caused it.
 *  - the identity and the timeout are settings with defaults, because neither
 *    widens anything.
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
    identity: { name: settings.SOLVE_BOT_NAME, email: settings.SOLVE_BOT_EMAIL },
    timeoutMs: numeric(settings, "SOLVE_GH_TIMEOUT_MS", 1),
  };
}

/**
 * `origin/main` → `main`.
 *
 * `SOLVE_BASE_REF` is a *ref* — it is fetched and branched from, and both of
 * those want the remote-qualified form. A pull request base is a *branch name*
 * on the remote, and passing `origin/main` there makes gh report that the base
 * does not exist, which sends the reader looking at GitHub rather than at the
 * setting. Only a leading `origin/` is stripped, and only one: a branch legally
 * named `origin/something` is unusual but a branch named `release/origin/x` is
 * not, and a global replace would mangle it.
 */
export function baseBranchOf(baseRef: string): string {
  return baseRef.startsWith("origin/") ? baseRef.slice("origin/".length) : baseRef;
}

/**
 * `SOLVE_GITHUB_OWNER/<checkout name>`, or a settings error.
 *
 * One function rather than the same template literal in three places, because
 * it is the only thing that decides which GitHub repository this service talks
 * to. Passing `--repo` explicitly is what stops gh inferring a target from
 * whatever remote a worktree happens to carry, so every gh call in the service
 * takes its answer from here.
 *
 * Not trimmed: `readSettings` has already done that, so whitespace has already
 * become the empty string. See `worktreeRoot`. The owner has no default on
 * purpose — it names the account a pull request would be opened against, which
 * is not a thing to guess.
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
 * `cwd` is the repository checkout rather than a worktree, and that ordering is
 * the point: the search runs *before* anything is attached, because whether a
 * pull request exists is what decides if there is anything to attach to.
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
 * `buildPublishRequest` is the moment work first becomes visible to other
 * people. This is the moment the service pushes to a pull request people are
 * already reading, without being asked again. Same reasoning, one step further,
 * and the same shape — a reader asking "what can rewrite an open pull request"
 * greps for one name and reads its call sites.
 *
 * ## `round` is zero on every hand-driven invocation, and that is a known gap
 *
 * `advance` compares `round` against `maxRounds` and stops when the reviewer's
 * budget is spent. There is nothing here to count from: each invocation is a
 * fresh process with no memory of the last, so a run started by an operator
 * always claims to be on its first round and `MAX_REVIEW_ITERATIONS` never
 * fires. That is tolerable only while a person is the loop — they can see how
 * many times they have typed the command. It stops being tolerable the moment
 * the daemon drives this, and the count has to come from the pull request
 * itself, which is what the review cursor (D3) exists to read. Recorded here
 * rather than hidden behind a plausible-looking `0`.
 */
export function buildAdvanceRequest(
  settings: Settings,
  base: SolveRequest,
  worktree: Worktree,
  number: number,
): AdvanceRequest {
  return {
    ...base,
    worktree,
    repo: githubRepoFor(settings, worktree.repoPath),
    number,
    identity: { name: settings.SOLVE_BOT_NAME, email: settings.SOLVE_BOT_EMAIL },
    round: 0,
    maxRounds: numeric(settings, "MAX_REVIEW_ITERATIONS", 0),
    ghTimeoutMs: numeric(settings, "SOLVE_GH_TIMEOUT_MS", 1),
  };
}

/**
 * Reads one ticket in full and renders it as the text a solve pass is given.
 *
 * Lives here because it is the join between the Jira client and the solver, and
 * it is a join this codebase has now got wrong twice — once in triage, which
 * decided on tickets whose comments it had never read, and once nearly here.
 * `JiraClient.search` returns a `TicketRef` with no description and no comments;
 * a caller that reached for the object it already had would have produced a
 * solver that reads a summary and calls it the ticket.
 */
export function createTicketReader(
  client: JiraClient,
): (issueKey: string) => Promise<RenderedTicket & { readonly detail: IssueDetail }> {
  return async (issueKey: string) => {
    const detail = await client.fetchDetail(issueKey);
    const rendered = await renderTicket(client, detail);
    if (rendered.omitted.length > 0) {
      // Logged rather than swallowed: "the asset the ticket told you to use was
      // not shown to the solver" is the kind of thing that otherwise surfaces as
      // a baffling diff.
      logger.warn("solve.ticket_attachments_omitted", { issueKey, omitted: rendered.omitted });
    }
    return { ...rendered, detail };
  };
}
