/**
 * Puts the agent-fitness call on the ticket, where someone can act on it.
 *
 * The blockers are not an explanation, they are a to-do list. "Supply a real
 * `.ico` asset" is a five-minute human task that flips a ticket from unsolvable
 * to solvable; "AC#4 is a visual judgement" is a prompt to name who eyeballs it.
 * Kept in a gitignored local artifact, that list reaches nobody — so the loop
 * where a human cheaply removes a blocker and the ticket becomes automatable
 * never closes.
 *
 * Rendered in TypeScript from `payload.agentFitness` rather than written by the
 * skill, and that is the whole design. This service has been bitten twice by the
 * same defect — prose and the machine-readable fields disagreeing (SSX-3814,
 * SSX-3822) — and the standing rule is to trust the structured field. Asking the
 * model to *also* describe its fitness call in the comment would reopen exactly
 * that gap and cost a gate rule to police it. Deriving the sentence from the
 * field makes disagreement impossible by construction instead of by check.
 *
 * The cost of that choice is language: comments are sometimes Norwegian
 * (SSX-3827 was) and this block is always English. That is a real wart, and the
 * trade was made deliberately — a bilingual seam is easier to live with than a
 * class of silent contradiction.
 */

import { FOOTER_SENTINEL } from "./gate.ts";
import type { AgentFitness, TriagePayload } from "./runner.ts";

/**
 * Renders the block, or `null` when it should not appear.
 *
 * Only `ready-ish` tickets get one. That is not an arbitrary threshold: it is
 * the same line the gate already draws, since `solvable` requires `ready-ish`.
 * Below it the fitness answer is trivially "no, the ticket is not ready", which
 * the verdict already says louder — so on a send-back the block would be noise
 * on a ticket a colleague is reading.
 */
export function buildFitnessNote(
  verdict: TriagePayload["verdict"],
  fitness: AgentFitness,
): string | null {
  if (verdict !== "ready-ish") {
    return null;
  }

  const repo = fitness.repo === "" ? "" : ` · \`${fitness.repo}\``;
  const headline = fitness.solvable ? "looks automatable" : "not yet";
  const lines = [
    "---",
    "",
    `🤖 **Agent fitness:** ${headline}${repo} · confidence ${fitness.confidence}`,
    "",
  ];

  if (fitness.solvable) {
    // Deliberately not a promise. Nothing downstream consumes this label yet,
    // and manual mode means a human opts the ticket in even once something
    // does. Claiming a bot "will" pick it up would be false today and still
    // misleading later.
    lines.push(
      "Assessed as safe for an autonomous fix. Nothing picks this up on its own — a human still has to opt the ticket in.",
    );
    return lines.join("\n");
  }

  // `blockers` is empty iff solvable, per the schema — but only the forward
  // direction is enforced by the gate, so a "no" with nothing listed is
  // reachable. Falling back to the rationale keeps the block from rendering a
  // bare refusal with no reason, which is the one thing it exists to prevent.
  if (fitness.blockers.length === 0) {
    lines.push(fitness.rationale === "" ? "No reason was given." : fitness.rationale);
    return lines.join("\n");
  }

  lines.push("To make this agent-solvable, resolve:", "");
  lines.push(...fitness.blockers.map((blocker) => `* ${blocker}`));

  return lines.join("\n");
}

/**
 * Returns the payload with the note spliced into the comment, above the footer.
 *
 * Above rather than below because the footer sentinel is load-bearing: the
 * poster finds its own previous comment by matching that exact trailing line,
 * so anything appended after it would break update-in-place and start posting
 * duplicates on every re-run.
 *
 * A body with no sentinel is returned untouched. That is not this function's
 * failure to report — `assertPostable` already refuses such a body with a
 * message about the footer, and a second complaint here would only bury it.
 */
export function withFitnessNote(payload: TriagePayload): TriagePayload {
  const note = buildFitnessNote(payload.verdict, payload.agentFitness);
  if (note === null) {
    return payload;
  }

  const body = payload.mutation.commentBody;
  const at = body.lastIndexOf(FOOTER_SENTINEL);
  if (at === -1) {
    return payload;
  }

  const commentBody = `${body.slice(0, at).trimEnd()}\n\n${note}\n\n${body.slice(at)}`;

  return { ...payload, mutation: { ...payload.mutation, commentBody } };
}
