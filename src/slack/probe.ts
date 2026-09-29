/**
 * Whether both halves of the audit thread's store work against the real systems: a Slack message
 * posted, edited and deleted, and a record written to, read back from and deleted on one named
 * ticket. Measured before anything is built on either. With an operator named, also whether the bot
 * can send them the direct message a pull request's line arrives in.
 */

import { isDeepStrictEqual } from "node:util";

import type { JiraClient } from "../jira/client.ts";
import { oneLine } from "../text.ts";
import type { SlackClient } from "./client.ts";

export const PROBE_PROPERTY = "jira-police.slack-probe";

/** At the record's caps, so the write measures the largest record the thread can hold, not a toy. */
const SAMPLE_TIMELINE_ENTRIES = 40;
const SAMPLE_MAJOR_ENTRIES = 10;
const SAMPLE_ENTRY_CHARS = 200;

export type ProbeSlack = Pick<SlackClient, "authTest" | "post" | "update" | "deleteMessage">;

export type ProbeJira = Pick<
  JiraClient,
  "getIssueProperty" | "setIssueProperty" | "deleteIssueProperty"
>;

export interface ProbeTarget {
  readonly channel: string;
  /** SLACK_OPERATOR_USER_ID, or `null` to skip the direct message. */
  readonly operator: string | null;
  readonly issueKey: string;
  readonly keep: boolean;
  readonly nonce: string;
  readonly now: Date;
}

export interface ProbeStep {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface ProbeResult {
  readonly steps: readonly ProbeStep[];
  /** The Slack message's `ts`, when it is still in the channel. */
  readonly messageLeft: string | null;
  /** The direct message, when it is still in the operator's conversation with the bot. */
  readonly directLeft: { readonly channel: string; readonly ts: string } | null;
  /** Whether the probe property is still on the ticket, deliberately or by a failed delete. */
  readonly propertyLeft: boolean;
}

export const EXIT = { ok: 0, failed: 1, usage: 2, threw: 3 } as const;

type Recorder = (name: string, ok: boolean, detail: string) => boolean;

export async function runProbe(
  slack: ProbeSlack,
  jira: ProbeJira,
  target: ProbeTarget,
): Promise<ProbeResult> {
  const steps: ProbeStep[] = [];
  const record: Recorder = (name, ok, detail) => {
    steps.push({ name, ok, detail: oneLine(detail) });
    return ok;
  };

  const messageLeft = await slackHalf(slack, target, record);
  const authed = steps.some((step) => step.name === "auth.test" && step.ok);
  const directLeft =
    target.operator === null || !authed
      ? null
      : await directMessage(slack, target, target.operator, record);
  const propertyLeft = await jiraHalf(jira, target, messageLeft ?? "", record);
  return { steps, messageLeft, directLeft, propertyLeft };
}

async function directMessage(
  slack: ProbeSlack,
  target: ProbeTarget,
  operator: string,
  record: Recorder,
): Promise<ProbeResult["directLeft"]> {
  let left: { readonly channel: string; readonly ts: string };
  try {
    const posted = await slack.post({
      channel: operator,
      text: `the-jira-police probe for ${target.issueKey}, ${target.now.toISOString()}: a pull request's line arrives here — safe to ignore`,
    });
    left = { channel: posted.channel, ts: posted.ts };
    record(
      "direct message",
      true,
      withWarnings(`to ${operator}, in ${posted.channel}, ts ${posted.ts}`, posted.warnings),
    );
  } catch (error) {
    record("direct message", false, describe(error));
    return null;
  }

  if (target.keep) {
    return left;
  }
  try {
    await slack.deleteMessage(left);
    record("direct message delete", true, `removed ${left.ts}`);
    return null;
  } catch (error) {
    record("direct message delete", false, describe(error));
    return left;
  }
}

async function slackHalf(
  slack: ProbeSlack,
  target: ProbeTarget,
  record: Recorder,
): Promise<string | null> {
  try {
    const who = await slack.authTest();
    record("auth.test", true, `bot user ${who.userId} in ${who.team}`);
  } catch (error) {
    record("auth.test", false, describe(error));
    return null;
  }

  let ts: string;
  try {
    const posted = await slack.post({
      channel: target.channel,
      text: `the-jira-police probe for ${target.issueKey}, ${target.now.toISOString()} — safe to ignore`,
    });
    ts = posted.ts;
    record("chat.postMessage", true, withWarnings(`ts ${ts}`, posted.warnings));
  } catch (error) {
    record("chat.postMessage", false, describe(error));
    return null;
  }

  try {
    const edited = await slack.update({
      channel: target.channel,
      ts,
      text: `the-jira-police probe for ${target.issueKey}, ${target.now.toISOString()}, edited — safe to ignore`,
    });
    record("chat.update", true, withWarnings(`ts ${edited.ts}`, edited.warnings));
  } catch (error) {
    record("chat.update", false, describe(error));
  }

  if (target.keep) {
    return ts;
  }
  try {
    await slack.deleteMessage({ channel: target.channel, ts });
    record("chat.delete", true, `removed ${ts}`);
    return null;
  } catch (error) {
    record("chat.delete", false, describe(error));
    return ts;
  }
}

async function jiraHalf(
  jira: ProbeJira,
  target: ProbeTarget,
  ts: string,
  record: Recorder,
): Promise<boolean> {
  const written = sampleRecord(target, ts);
  try {
    await jira.setIssueProperty(target.issueKey, PROBE_PROPERTY, written);
    record(
      "property write",
      true,
      `${PROBE_PROPERTY} on ${target.issueKey}, ${String(JSON.stringify(written).length)} characters`,
    );
  } catch (error) {
    record("property write", false, describe(error));
    return false;
  }

  try {
    const read = await jira.getIssueProperty(target.issueKey, PROBE_PROPERTY);
    const same = isDeepStrictEqual(read, written);
    record(
      "property read back",
      same,
      same
        ? "identical, timeline included"
        : `came back different: ${JSON.stringify(read).slice(0, 200)}`,
    );
  } catch (error) {
    record("property read back", false, describe(error));
  }

  if (target.keep) {
    return true;
  }
  try {
    const deleted = await jira.deleteIssueProperty(target.issueKey, PROBE_PROPERTY);
    record(
      "property delete",
      deleted,
      deleted ? "removed" : "Jira said there was nothing to delete",
    );
    const after = await jira.getIssueProperty(target.issueKey, PROBE_PROPERTY);
    record("property gone", after === null, after === null ? "reads as absent" : "still readable");
    return after !== null;
  } catch (error) {
    record("property delete", false, describe(error));
    return true;
  }
}

/** Shaped like the audit record: nested objects and a list of objects, which Slack's metadata could not hold. */
export function sampleRecord(target: ProbeTarget, ts: string): unknown {
  const at = target.now.toISOString();
  return {
    probe: target.nonce,
    slack: { channel: target.channel, ts },
    triage: { verdict: "ready-ish", solvable: true, confidence: "high" },
    pr: { url: "https://github.com/example/repo/pull/1", state: "draft" },
    major: entries(SAMPLE_MAJOR_ENTRIES, "major", at),
    timeline: entries(SAMPLE_TIMELINE_ENTRIES, "timeline", at),
  };
}

function entries(count: number, kind: string, at: string): readonly object[] {
  return Array.from({ length: count }, (_unused, index) => ({
    at,
    what: `probe ${kind} entry ${String(index + 1)} of ${String(count)} `.padEnd(
      SAMPLE_ENTRY_CHARS,
      ".",
    ),
  }));
}

export function exitCodeFor(result: ProbeResult): number {
  return result.steps.every((step) => step.ok) ? EXIT.ok : EXIT.failed;
}

export function formatReport(result: ProbeResult, target: ProbeTarget): string {
  const lines = [
    "# Slack probe",
    "",
    `- **Run:** ${target.now.toISOString()}`,
    `- **Channel:** ${target.channel}`,
    `- **Operator:** ${target.operator ?? "none named; no direct message sent"}`,
    `- **Ticket:** ${target.issueKey}`,
    `- **Verdict:** ${exitCodeFor(result) === EXIT.ok ? "PASS — every step worked" : "FAIL"}`,
    "",
    "| step | result | detail |",
    "| ---- | ------ | ------ |",
    ...result.steps.map(
      (step) =>
        `| ${step.name} | ${step.ok ? "PASS" : "FAIL"} | ${step.detail.replaceAll("|", "\\|")} |`,
    ),
  ];
  if (result.messageLeft !== null) {
    lines.push("", `The probe message is still in the channel: ts ${result.messageLeft}.`);
  }
  if (result.directLeft !== null) {
    lines.push(
      "",
      `The direct message is still with ${target.operator ?? "the operator"}: ${result.directLeft.channel}, ts ${result.directLeft.ts}.`,
    );
  }
  if (result.propertyLeft) {
    lines.push("", `${PROBE_PROPERTY} is still on ${target.issueKey}.`);
  }
  return `${lines.join("\n")}\n`;
}

function withWarnings(detail: string, warnings: readonly string[]): string {
  return warnings.length === 0 ? detail : `${detail}; Slack warned: ${warnings.join(", ")}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
