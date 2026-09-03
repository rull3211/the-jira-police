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
 *              *in* an issue. Receives the key and nothing else.
 */

import { JiraClient } from "./jira/client.ts";
import { buildNewIssuesJql } from "./jira/jql.ts";
import type { TicketRef } from "./jira/types.ts";
import { logger } from "./logger.ts";
import { FileSink } from "./output/sink.ts";
import type { PollDeps } from "./poller.ts";
import { type Settings, list, numeric } from "./settings.ts";
import { type TriagePayload, runTriage } from "./triage/runner.ts";

/** Skill that reads nothing, so it must not be made to wait on Atlassian. */
const MOCK_SKILL = "mock-triage";

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

export function createGroom(settings: Settings): (ticket: TicketRef) => Promise<TriagePayload> {
  const isMock = settings.SKILL_NAME === MOCK_SKILL;

  return async (ticket: TicketRef) =>
    await runTriage({
      issueKey: ticket.key,
      skillName: settings.SKILL_NAME,
      executable: settings.STORECODE_PATH,
      workingDirectory: process.cwd(),
      timeoutMs: numeric(settings, "TRIAGE_TIMEOUT_MS"),
      noWrite: true,
      deep: false,
      // Requiring a live Atlassian session from a skill that reads nothing
      // would fail runs for a reason unrelated to what is being exercised.
      requiredMcpServers: isMock ? [] : ["atlassian"],
      ...(isMock ? { allowedTools: [] as readonly string[] } : {}),
    });
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
