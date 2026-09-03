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

import { JiraClient } from "./jira/client.ts";
import { buildInFlightJql, buildNewIssuesJql, buildSolveQueueJql } from "./jira/jql.ts";
import type { TicketRef } from "./jira/types.ts";
import { logger } from "./logger.ts";
import { FileSink, clearRejection, writeRejection } from "./output/sink.ts";
import type { PollDeps } from "./poller.ts";
import { type Settings, SettingsError, flag, list, numeric, solveMode } from "./settings.ts";
import type { SolveCandidate, SolveDeps } from "./solve/poller.ts";
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
    timeoutMs: numeric(settings, "TRIAGE_TIMEOUT_MS"),
    deep: false,
    // Requiring a live Atlassian session from a skill that reads nothing
    // would fail runs for a reason unrelated to what is being exercised.
    requiredMcpServers: isMock ? [] : ["atlassian"],
    ...(isMock ? { allowedTools: [] as readonly string[] } : {}),
    ...(isStandIn ? {} : { vaultPath: settings.VAULT_PATH, noHtml: true }),
  };
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
 * Both reads go through the same Jira REST credential the grooming poller
 * uses, and that is still discovery-only. Nothing here can write — `SolveDeps`
 * has no write function to give, which is the Phase B refusal made structural
 * rather than promised. When the claim is eventually written it will go through
 * storecode's own MCP session, as every other mutation in this service does.
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
