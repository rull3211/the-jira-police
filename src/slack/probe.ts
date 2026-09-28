/**
 * Whether a message's metadata survives the round trip the audit thread depends on: posted,
 * read back, edited, read back again. Measured against the real app before anything stores state
 * in it, because the documentation does not settle it.
 */

import type { SlackClient, SlackMessage, SlackMetadata } from "./client.ts";
import { SlackError } from "./client.ts";
import { oneLine } from "../text.ts";

export const PROBE_EVENT_TYPE = "jira_police.probe";

export type ProbeClient = Pick<
  SlackClient,
  "authTest" | "post" | "update" | "history" | "deleteMessage"
>;

export interface ProbeStep {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface ProbeResult {
  readonly steps: readonly ProbeStep[];
  /** The probe message's `ts` when it was left in the channel, deliberately or by a failed delete. */
  readonly leftBehind: string | null;
}

export const EXIT = { ok: 0, failed: 1, usage: 2, threw: 3 } as const;

export async function runProbe(
  client: ProbeClient,
  channel: string,
  options: { readonly keep: boolean; readonly nonce: string; readonly now: Date },
): Promise<ProbeResult> {
  const steps: ProbeStep[] = [];
  const record = (name: string, ok: boolean, detail: string): boolean => {
    steps.push({ name, ok, detail: oneLine(detail) });
    return ok;
  };

  try {
    const who = await client.authTest();
    record("auth.test", true, `bot user ${who.userId} in ${who.team}`);
  } catch (error) {
    record("auth.test", false, describe(error));
    return { steps, leftBehind: null };
  }

  const posted = metadataFor(options.nonce, "posted");
  let ts: string;
  try {
    const result = await client.post({
      channel,
      text: `the-jira-police probe, ${options.now.toISOString()} — safe to ignore`,
      metadata: posted,
    });
    ts = result.ts;
    record("chat.postMessage", true, withWarnings(`ts ${ts}`, result.warnings));
  } catch (error) {
    record("chat.postMessage", false, describe(error));
    return { steps, leftBehind: null };
  }

  const readAfterPost = await readBack(client, channel, ts, posted);
  record("metadata after post", readAfterPost.ok, readAfterPost.detail);

  const updated = metadataFor(options.nonce, "updated");
  let updateOk = false;
  try {
    const result = await client.update({
      channel,
      ts,
      text: `the-jira-police probe, ${options.now.toISOString()}, edited — safe to ignore`,
      metadata: updated,
    });
    updateOk = record("chat.update", true, withWarnings(`ts ${result.ts}`, result.warnings));
  } catch (error) {
    record("chat.update", false, describe(error));
  }

  if (updateOk) {
    const readAfterUpdate = await readBack(client, channel, ts, updated);
    record("metadata after update", readAfterUpdate.ok, readAfterUpdate.detail);
  }

  if (options.keep) {
    return { steps, leftBehind: ts };
  }
  try {
    await client.deleteMessage({ channel, ts });
    record("chat.delete", true, `removed ${ts}`);
    return { steps, leftBehind: null };
  } catch (error) {
    record("chat.delete", false, describe(error));
    return { steps, leftBehind: ts };
  }
}

export function exitCodeFor(result: ProbeResult): number {
  return result.steps.every((step) => step.ok) ? EXIT.ok : EXIT.failed;
}

export function formatReport(result: ProbeResult, channel: string, now: Date): string {
  const lines = [
    "# Slack probe",
    "",
    `- **Run:** ${now.toISOString()}`,
    `- **Channel:** ${channel}`,
    `- **Verdict:** ${exitCodeFor(result) === EXIT.ok ? "PASS — metadata round-trips" : "FAIL"}`,
    "",
    "| step | result | detail |",
    "| ---- | ------ | ------ |",
    ...result.steps.map(
      (step) =>
        `| ${step.name} | ${step.ok ? "PASS" : "FAIL"} | ${step.detail.replaceAll("|", "\\|")} |`,
    ),
  ];
  if (result.leftBehind !== null) {
    lines.push("", `The probe message is still in the channel: ts ${result.leftBehind}.`);
  }
  return `${lines.join("\n")}\n`;
}

function metadataFor(nonce: string, stage: "posted" | "updated"): SlackMetadata {
  return { event_type: PROBE_EVENT_TYPE, event_payload: { nonce, stage } };
}

async function readBack(
  client: ProbeClient,
  channel: string,
  ts: string,
  expected: SlackMetadata,
): Promise<{ readonly ok: boolean; readonly detail: string }> {
  let message: SlackMessage | undefined;
  try {
    const page = await client.history({ channel, latest: ts, inclusive: true, limit: 1 });
    message = page.messages.find((candidate) => candidate.ts === ts);
  } catch (error) {
    return { ok: false, detail: describe(error) };
  }
  if (message === undefined) {
    return { ok: false, detail: `conversations.history did not return ${ts}` };
  }
  if (message.metadata === null) {
    return { ok: false, detail: "the message came back with no metadata at all" };
  }
  const got = message.metadata;
  const same =
    got.event_type === expected.event_type &&
    got.event_payload["nonce"] === expected.event_payload["nonce"] &&
    got.event_payload["stage"] === expected.event_payload["stage"];
  return {
    ok: same,
    detail: same
      ? `event_type ${got.event_type}, stage ${String(got.event_payload["stage"])}`
      : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`,
  };
}

function withWarnings(detail: string, warnings: readonly string[]): string {
  return warnings.length === 0 ? detail : `${detail}; Slack warned: ${warnings.join(", ")}`;
}

function describe(error: unknown): string {
  if (error instanceof SlackError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
