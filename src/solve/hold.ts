/**
 * A person's `agent:ignore`, checked against the live labels before each outward write; a read that fails holds it.
 * A work boundary throws `TicketHeldError`; a report site skips. Invariant 21 in `architecture/invariants.md` has the contract.
 */

import { createLogger } from "../logger.ts";
import { AGENT_LABELS, isIgnored } from "./labels.ts";
import type { PassRunner } from "./orchestrator.ts";

const log = createLogger("labels");

/** Whether `issueKey` may be written to right now. `where` names the write, for the log and the error. */
export type WriteGate = (issueKey: string, where: string) => Promise<boolean>;

export class TicketHeldError extends Error {
  readonly issueKey: string;
  readonly where: string;

  constructor(issueKey: string, where: string) {
    super(
      `${issueKey} is held at ${where}: it carries ${AGENT_LABELS.ignore}, or its labels could not be read, so nothing more is written to it`,
    );
    this.name = "TicketHeldError";
    this.issueKey = issueKey;
    this.where = where;
  }
}

/** Reads the ticket's labels live and clears the write only if it can see them and the hold is absent. */
export function createWriteGate(
  readLabels: (issueKey: string) => Promise<readonly string[]>,
): WriteGate {
  return async (issueKey, where) => {
    let labels: readonly string[];
    try {
      labels = await readLabels(issueKey);
    } catch (error) {
      log.warn("labels.write_held", { issueKey, where, reason: "labels unreadable", error });
      return false;
    }
    if (isIgnored(labels)) {
      log.info("labels.write_held", { issueKey, where, reason: AGENT_LABELS.ignore });
      return false;
    }
    return true;
  };
}

/** A report site's question. Only `true` clears the write: any other answer is a bug in the gate and holds it. */
export async function mayWrite(gate: WriteGate, issueKey: string, where: string): Promise<boolean> {
  return (await gate(issueKey, where)) === true;
}

/** A work boundary: returns only when the write is cleared. */
export async function assertMayWrite(
  gate: WriteGate,
  issueKey: string,
  where: string,
): Promise<void> {
  if (!(await mayWrite(gate, issueKey, where))) {
    throw new TicketHeldError(issueKey, where);
  }
}

/**
 * Checks the ticket before each model pass starts and again before its result is used, so a label
 * that arrives mid-pass discards that pass's work instead of carrying it into a push.
 */
export function gatePasses(passes: PassRunner, gate: WriteGate): PassRunner {
  return {
    run: async (pass, options, parse) => {
      await assertMayWrite(gate, options.issueKey, `before the ${pass} pass`);
      const result = await passes.run(pass, options, parse);
      await assertMayWrite(gate, options.issueKey, `after the ${pass} pass`);
      return result;
    },
  };
}
