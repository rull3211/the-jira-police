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
 * is withheld from the subprocess entirely (`WITHHELD_FROM_CHILD` in the
 * runner), so every *grooming* mutation is made by the skill's own MCP session,
 * as that session's own Jira user. Which means the comments are attributable to
 * a real account, and revoking the write is a matter of this one setting rather
 * than of re-scoping a token.
 *
 * This used to say the credential "stays read-only and discovery-only". It does
 * not, and this is the module that falsifies it: `applyLabelChange` below calls
 * `client.updateLabels`, which is a REST write. The amendment is bounded to the
 * `agent:` namespace at the credential (`jira/client.ts`), so grooming's own
 * `triaged`/`dor:*` labels and its verdict comment are still MCP's and the split
 * described above holds — but the blanket claim was false, in the same file that
 * makes it false.
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
import type { TicketRef } from "./jira/types.ts";
import { logger } from "./logger.ts";
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
  const statuses = list(settings, "TRIAGE_ONLY_STATUS");

  // Rendered here and thrown away, so an unquotable status is a startup crash
  // rather than a `JqlError` raised inside every poll cycle from now on. The
  // query is only built inside the closure below, which means without this the
  // first sign of a bad character in the setting would be an error at 3am, on
  // the tick, forever — nothing written, nothing damaged, and nothing that says
  // the cause is one line of configuration. Only the characters are checkable;
  // whether the status exists is not, see below.
  for (const status of statuses) {
    jqlValue(status, "status");
  }

  // Once, at wiring, at `info` — unlike `poll.query` below, which is per-cycle
  // plumbing at `debug`. The failure it is here for is silent: a status that
  // resolves to nothing is a filter matching nothing, and the service goes on
  // looking healthy while triaging zero tickets forever. The credential cannot
  // check the names against the board — `/project/SSX/statuses` is a 404 for
  // it, verified 2026-09-10 — so printing the list is what is left.
  //
  // **And printing it does not catch the case it was written for.** The
  // shipped default read `Mottatt,Backlog,On Hold,In Progress Concept`, which
  // is what the board calls those columns and what this line would have
  // printed, and `Mottatt` matched zero issues because the name does not
  // resolve on this instance while the id does. A reader checking the log
  // against the board would have agreed with it. That is the argument for
  // `named`: it makes the un-checkable half of each entry visible as such,
  // so a list of ids reads as pinned and a list of names reads as a claim
  // nobody has verified.
  logger.info("poll.status_filter", {
    statuses,
    restricted: statuses.length > 0,
    named: statuses.filter((entry) => !/^[0-9]+$/.test(entry.trim())),
  });

  return async (cursor: string | null): Promise<readonly TicketRef[]> => {
    const jql = buildNewIssuesJql({
      project: settings.JIRA_PROJECT,
      components: list(settings, "JIRA_COMPONENTS"),
      excludedTypeIds: list(settings, "JIRA_EXCLUDED_TYPES"),
      // The list logged above, not a second read of it: a log line describing a
      // filter the query does not use is worse than no log line.
      statuses,
      cursor,
      now: new Date(),
      overlapMs: numeric(settings, "CURSOR_OVERLAP_MS"),
      firstRunMinutes: numeric(settings, "FIRST_RUN_LOOKBACK_MINUTES"),
    });
    // `debug`, with the other three `*.query` lines. A JQL string is plumbing:
    // it is the same every tick apart from a timestamp, it is derived from
    // settings a reader can look up, and it says nothing about what happened —
    // so at `info` it is pure padding around the lines that do. It stays a log
    // line rather than being deleted because it is the first thing anyone wants
    // when the queue returns something surprising, and `LOG_LEVEL=debug` is how
    // you ask for it. The cursor this window was built from is on `cycle.done`.
    logger.debug("poll.query", { jql });
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
    // At least 1ms, both of them: zero is not "no timeout", it is a budget that
    // has already expired, so it would kill every run on the watchdog's first
    // tick instead of disabling the cap.
    idleMs: numeric(settings, "SESSION_IDLE_TIMEOUT_MS", 1),
    maxRunMs: numeric(settings, "TRIAGE_TIMEOUT_MS", 1),
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
 * How long the daemon sleeps between looks at the pull requests under review.
 *
 * A second cadence rather than a share of the first, and the two numbers pull
 * in opposite directions on purpose. Polling for new issues is a window over
 * time, so five minutes is a latency choice; looking at a pull request is a
 * question about a state, and the answer is worth having within about the time
 * a reviewer takes to reply — two and a half to four minutes, measured. Running
 * the review sweep on `POLL_INTERVAL_MS` would tie a reviewer's turnaround to a
 * setting whose description is "gap between polls", which is how a cadence
 * change quietly becomes a policy change.
 *
 * Same floor and the same reason as above: zero is an unthrottled loop, not an
 * eager one, and here it would be unthrottled against `gh` as well as Jira.
 */
export function reviewIntervalMs(settings: Settings): number {
  return numeric(settings, "REVIEW_POLL_MS", 1);
}

/**
 * How long the daemon sleeps between sweeps of the watched tickets.
 *
 * A third cadence, and the slowest, for the reason the plan gave it before any
 * of this was built: the sendback watch is the only loop here whose trigger is a
 * *person changing their mind*. A reporter reads a sendback, goes and finds the
 * baseline number, and comes back — an event measured in days. Checking every
 * few minutes cannot make that answer arrive sooner and multiplies the reads and
 * the checks that find nothing by two hundred.
 *
 * It is also the only cadence where a *shorter* interval is a spending decision
 * rather than a latency one, because the memo bounding the relevance check lives
 * in memory. A sweep that finds the same undeclined trigger it found last time
 * costs nothing; a sweep after a restart costs one check per triggered ticket,
 * so the number that actually governs spend here is restarts per day, not this.
 *
 * Same floor as the other two, and here it matters most: a zero interval against
 * a loop that can start a paid session is not an eager sweep.
 */
export function watchIntervalMs(settings: Settings): number {
  return numeric(settings, "WATCH_POLL_MS", 1);
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
 * `signal` is optional because the one-shot CLI has nothing to interrupt: it
 * runs a single cycle and exits. The daemon passes its shutdown signal so a
 * stop request is honoured between issues rather than only between cycles.
 */
export function createPollDeps(
  settings: Settings,
  client: JiraClient,
  signal?: AbortSignal,
): PollDeps {
  const priority = list(settings, "TRIAGE_STATUS_PRIORITY");

  // Logged once at wiring, like `poll.status_filter`, and for a related reason:
  // an ordering nobody can see is one nobody can judge. Unlike that one the
  // failure here is not silent — a status that matches nothing simply orders
  // nothing, and `poll.order` shows the result every cycle — so this line says
  // what was asked for and leaves the evidence to that one.
  logger.info("poll.status_priority", { priority, ordered: priority.length > 0 });

  return {
    fetchCandidates: createDiscover(settings, client),
    triage: createGroom(settings),
    sink: new FileSink(settings.OUTPUT_DIR),
    statePath: settings.STATE_PATH,
    // Omitted entirely when unset rather than passed as a created-ascending
    // comparator, so the poller's own default is what runs. Two routes to the
    // same order is one more than needs proving, and `poll.order` stays quiet
    // for an operator who never asked for this.
    ...(priority.length === 0 ? {} : { order: byStatusPriority(priority) }),
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
/**
 * The solve pipeline's way of saying something on a ticket.
 *
 * Composed here rather than in the command for the reason `createSolveDeps` is:
 * constructing a capability is the privilege grant, and a reviewer looking for
 * "what can this reach Jira with" should find every answer in one file.
 *
 * The budget is `TRIAGE_TIMEOUT_MS`, which is not a copy-paste. It is what the
 * triage poster runs on — the only comparable component in the tree, and a
 * closer relative than anything named `SOLVE_*`: both are a short storecode
 * session that holds finished text and calls one Atlassian tool. The `SOLVE_*`
 * budgets are all sized for a model reading a repository, and `SOLVE_TIMEOUT_MS`
 * in particular is thirty minutes, which for a one-tool write is not a timeout
 * so much as the absence of one.
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
 * Composed here for the same reason the commenter is — a reviewer asking what
 * this service can reach should find every answer in one file — and it is the
 * shortest answer in it. `createRelevanceChecker` builds a session with no MCP
 * server and no tools at all, so there is nothing to withhold and nothing to
 * scope.
 *
 * `TRIAGE_TIMEOUT_MS` again, and again not a copy-paste: this is a storecode
 * session that reads a prompt and answers, which makes the poster and the
 * commenter its nearest relatives. It will normally finish in seconds. Sizing
 * it from a `SOLVE_*` budget would tie a check that reads no files to a number
 * chosen for a model reading a repository.
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
      // `debug`, for the reason given at `poll.query`. Both of these strings
      // are also handed to the cycle report verbatim, two fields above, so
      // demoting them loses nothing a person was relying on.
      logger.debug("solve.query", { jql: queueJql });
      return (await client.search(queueJql)).map(toSolveCandidate);
    },
    countInFlight: async () => {
      logger.debug("solve.in_flight_query", { jql: inFlightJql });
      return (await client.search(inFlightJql)).length;
    },
    ...(signal === undefined ? {} : { signal }),
  };
}

/**
 * Composes the review cycle, the way `createSolveDeps` composes the solve one.
 *
 * ## `look` and `act` come from the caller, and that is the whole point
 *
 * Every other `create*Deps` in this file builds its dependencies outright. This
 * one takes the two that cost money as parameters, because they are the two
 * halves the cycle exists to keep apart — a cheap read for every watched pull
 * request, a paid round for the few with work — and composing them here would
 * put the seam in the file nobody reads when asking "how often does this spend".
 * `solve-run.ts` builds both from the same primitives `--advance` uses, so the
 * loop and the single shot cannot drift into doing different things.
 *
 * What is built here is the part that decides *scope*: the query, the master
 * switch, and the per-tick bound. Those are the three answers to "how much can
 * this cost", and they belong with the other privilege grants.
 *
 * The query is built eagerly for `createSolveDeps`'s reason: a malformed one is
 * a misconfiguration and should stop the process rather than the tick that first
 * reaches the board.
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
    // The same switch the solve queue reads, and checked again inside the cycle.
    // A review round pushes a commit to a pull request people are reading, so
    // "is this service switched on" is not a question to answer once.
    enabled: flag(settings, "SOLVE_ENABLED"),
    watchJql,
    maxRounds: numeric(settings, "MAX_REVIEW_ROUNDS_PER_TICK", 0),
    fetchWatched: async () => {
      // `debug`, for the reason given at `poll.query`.
      logger.debug("review.query", { jql: watchJql });
      return (await client.search(watchJql)).map(toWatchedTicket);
    },
    look,
    act,
    ...(signal === undefined ? {} : { signal }),
  };
}

/**
 * The same five fields `toSolveCandidate` takes, and deliberately not that
 * function.
 *
 * The two shapes coincide today. They are narrowings of `TicketRef` for two
 * queues that select on different facts, and sharing the mapping would make the
 * next field either queue needs a field both get — which is how `TicketRef`
 * grew a `description` nobody wanted. See `WatchedTicket`'s own note.
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
      // "no timeout", it is a budget that expired before the pass started.
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
 *
 * ## The answer is resolved, because git's is
 *
 * Added 2026-09-11, from a drive that reproduced a wedge the whole test suite
 * missed. Every recovery in `worktree.ts` starts by asking `git worktree list
 * --porcelain` whether a checkout is already at `<root>/<issueKey>`, and git
 * prints the **resolved** path. On macOS `tmpdir()` is `/var/folders/…`, which
 * is a symlink to `/private/var/folders/…` — the same problem this setting was
 * added to work around, arriving a second time as a string comparison that
 * cannot match. So the default configuration silently disabled both salvage
 * paths on the machine this service runs on, and each turned back into the
 * permanent refusal it was written to remove. An explicitly configured root can
 * be symlinked too, so it is resolved on the same line rather than trusted.
 *
 * `mkdirSync` first, because `realpathSync` needs the directory to exist and on
 * a fresh machine it does not; `git worktree add` would have created it a
 * moment later anyway, so this only moves the creation earlier. **Both are
 * wrapped**, and a failure falls back to the unresolved path: the worst case is
 * exactly today's behaviour, and refusing to build a request over a directory
 * git is about to create would be a new way to fail at something that works.
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

  // The other checkouts on this machine, and the reason this is not simply
  // `SOLVE_READ_DIRS` handed through: a name that is not a repository name is
  // dropped rather than joined onto the root, because `join` would happily turn
  // `..` into a path above it, and the one flag these directories reach is
  // `--add-dir`. Rejections are logged rather than thrown — a typo in a
  // discovery convenience must not stop a ticket being solved, but it must not
  // be silent either, or the operator concludes the allowlist is being honoured.
  const scope = readScope(settings.SOLVE_REPO_ROOT, list(settings, "SOLVE_READ_DIRS"), repo);
  if (scope.rejected.length > 0) {
    logger.warn("solve.read_dirs_rejected", { issueKey: detail.key, names: scope.rejected });
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
    identity: botIdentityOf(settings),
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
 * The name and address this service puts on a commit.
 *
 * One function rather than the same object literal at each call site. It was
 * written out twice here and needed a third and fourth for the base-sync
 * merge, which is the point at which "two identical literals" becomes the
 * defect this repository keeps naming: the two spellings are of *whose commit
 * this is*, and a commit attributed to nobody in particular is not a thing to
 * discover from a git log a week later.
 */
export function botIdentityOf(settings: Settings): BotIdentity {
  return { name: settings.SOLVE_BOT_NAME, email: settings.SOLVE_BOT_EMAIL };
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
 * ## There is no `round` here any more, and there used to be a zero
 *
 * This function passed `round: 0` on every invocation, because a fresh process
 * has nothing to count from — so `MAX_REVIEW_ITERATIONS` could not fire from
 * the command line at all and the person typing it was the only thing counting.
 * `advance` now reads the count off the marker comment on the pull request,
 * which is the one place that survives the process. The field is gone from
 * `AdvanceRequest` rather than left here holding a plausible-looking zero: a
 * caller that cannot supply the number cannot supply a wrong one.
 *
 * ## The worktree became a function, and that is the poll-cycle change
 *
 * This took a `Worktree` — an argument that could only be supplied by cutting a
 * checkout and installing into it *before* anyone had asked whether there was
 * anything to answer. `advance` now reads the pull request first and calls
 * `attach` only for the rounds that will actually run, so the checkout is the
 * caller's to make, on demand, and the caller keeps ownership of removing it.
 * `cwd` is what `gh` runs in until then: the repository itself, which is enough
 * because every request `surveyReview` makes names its repository explicitly.
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
