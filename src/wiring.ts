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
 */

import { JiraClient } from "./jira/client.ts";
import { buildNewIssuesJql } from "./jira/jql.ts";
import type { TicketRef } from "./jira/types.ts";
import { logger } from "./logger.ts";
import { FileSink } from "./output/sink.ts";
import type { PollDeps } from "./poller.ts";
import { type Settings, SettingsError, flag, list, numeric } from "./settings.ts";
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
    // A stand-in is pinned to preview whatever the operator configured. Both
    // exist to rehearse the pipeline, and a rehearsal that comments on a real
    // ticket is not a rehearsal.
    noWrite: isStandIn || !flag(settings, "WRITE_BACK"),
    deep: false,
    // Requiring a live Atlassian session from a skill that reads nothing
    // would fail runs for a reason unrelated to what is being exercised.
    requiredMcpServers: isMock ? [] : ["atlassian"],
    ...(isMock ? { allowedTools: [] as readonly string[] } : {}),
    ...(isStandIn ? {} : { vaultPath: settings.VAULT_PATH, noHtml: true }),
  };
}

export function createGroom(settings: Settings): (ticket: TicketRef) => Promise<TriagePayload> {
  // Built once, so a misconfiguration surfaces at startup rather than on the
  // first issue that happens to arrive.
  const template = buildTriageOptions(settings, "");

  // The ticket carries summary, type and timestamps; only the key crosses over.
  // Everything else the skill needs, it reads for itself over its own session.
  return async (ticket: TicketRef) => await runTriage({ ...template, issueKey: ticket.key });
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
