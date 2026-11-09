/**
 * The direct message holding the line the operator pastes into the team's pull request channel.
 * Never throws, like the audit notifier: the pull request is already open when it is sent.
 */

import { createLogger } from "../logger.ts";
import { type WriteGate, mayWrite } from "../solve/hold.ts";
import type { SlackClient } from "./client.ts";
import { writeJson } from "./store.ts";

const log = createLogger("slack");

export type PrLineOutcome =
  | { readonly kind: "sent"; readonly ts: string }
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

export interface PrLineSender {
  send(key: string, line: string): Promise<PrLineOutcome>;
}

/** A held ticket's pull request is announced to no one; the pull request itself is open either way. */
export function gatePrLine(sender: PrLineSender, gate: WriteGate): PrLineSender {
  return {
    send: async (key, line) =>
      (await mayWrite(gate, key, "the pull request direct message"))
        ? await sender.send(key, line)
        : { kind: "skipped", reason: `${key} is held` },
  };
}

/** Delivers one message and resolves to its `ts`; may throw, since `prLineSender` catches. */
export type Delivery = (key: string, line: string) => Promise<string>;

export function prLineSender(deliver: Delivery): PrLineSender {
  return {
    send: async (key, line) => {
      try {
        const ts = await deliver(key, line);
        log.info("slack.pr_line_sent", { key, ts });
        return { kind: "sent", ts };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log.warn("slack.pr_line_failed", {
          key,
          reason,
          note: "the pull request is open; announce it by hand",
        });
        return { kind: "failed", reason };
      }
    },
  };
}

export function slackDelivery(slack: Pick<SlackClient, "post">, userId: string): Delivery {
  return async (_key, line) => (await slack.post({ channel: userId, text: line })).ts;
}

/** The exact request a live run would send, one file per ticket. */
export function dryDelivery(directory: string, userId: string): Delivery {
  return async (key, line) => {
    await writeJson(directory, `${key}.pr-line.json`, {
      method: "chat.postMessage",
      channel: userId,
      text: line,
    });
    return "dry-run";
  };
}
