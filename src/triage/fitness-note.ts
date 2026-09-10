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
 * **Rendering `rationale` is that rule, not an exception to it.** The field is
 * required by the schema and asks for the deciding factor in one sentence, so
 * printing it is the renderer reading structured input — the same thing
 * `sink.ts` already does with it. What the rule forbids is a *second*,
 * free-text account of the call, which can drift from `solvable` and
 * `confidence` while looking equally official. The residual risk is narrower
 * and worth naming: `rationale` is prose, so a model could pair `solvable: true`
 * with a sentence arguing the opposite. That is a coherence question and the
 * gate is where coherence is checked; it is not a reason to discard the field.
 *
 * **The block owns its region, which is why `withFitnessNote` strips first.**
 * On a re-run the model rebuilds the comment from its own previous one and
 * carries this block along as ordinary body text, so splicing without
 * removing produces two. Measured across six runs on the real board: four
 * re-runs, four duplicates, both verdicts; two first runs, both correct. The
 * dossier block — model-written, no renderer — stayed at one through the same
 * re-runs, which is what identifies the cause as the splice rather than the
 * model's copying.
 *
 * The cost of that choice is language: comments are sometimes Norwegian
 * (SSX-3827 was) and this block is always English. That is a real wart, and the
 * trade was made deliberately — a bilingual seam is easier to live with than a
 * class of silent contradiction.
 */

import { FITNESS_MARKER, FOOTER_SENTINEL } from "./gate.ts";
import type { AgentFitness, TriagePayload } from "./runner.ts";

/**
 * The send-back block: what to add, and what happens when it is added.
 *
 * Two things it deliberately says that the `ready-ish` block does not.
 *
 * **That someone will look again.** The watch is the only part of this service
 * whose value depends on a person outside it doing something, and a reporter who
 * does not know the ticket is subscribed has no reason to answer a bot. The
 * `ready-ish` block is careful to promise nothing, for a good reason — nothing
 * claims a solvable ticket without a human opting it in. Here the opposite is
 * true and stating it is not a promise but a fact about the queue: the sweep runs
 * whether or not anyone is told.
 *
 * **That the list is exhaustive.** `blockers` is what the watch measures against,
 * so a reporter who answers all of it has done everything that is being waited
 * for. Saying so is what makes the list actionable rather than indicative — and
 * the gate guarantees the list is non-empty here, so there is always something to
 * point at.
 */
function buildWatchNote(fitness: AgentFitness): string {
  const repo = fitness.repo === "" ? "" : ` · \`${fitness.repo}\``;

  return [
    "---",
    "",
    `🤖 **Agent fitness:** not yet — watching${repo} · confidence ${fitness.confidence}`,
    "",
    "This ticket is close to being fixable automatically. Fill in the following and it becomes a candidate:",
    "",
    ...fitness.blockers.map((blocker) => `* ${blocker}`),
    "",
    "That list is the whole of it — nothing else is being waited for. Answer it in the description or in a comment and this ticket is looked at again on its own; you do not need to ask anyone.",
  ].join("\n");
}

/**
 * Renders the block, or `null` when it should not appear.
 *
 * A `ready-ish` ticket gets one because that is the line the gate already
 * draws: `solvable` requires `ready-ish`. Below it the fitness answer is
 * usually the trivial "no, the ticket is not ready", which the verdict says
 * louder, so the block would be noise on a ticket a colleague is reading.
 *
 * ## The one exception, and it is the whole outbound half of F
 *
 * **`plausible` is only ever true on a send-back**, by the gate's own rule that
 * it and `solvable` are alternatives. So the sentence above, written before
 * `plausible` existed, suppressed the block on precisely the tickets the watch
 * was built for — and this file's own header is the argument against that: *the
 * blockers are not an explanation, they are a to-do list*, and kept off the
 * ticket that list reaches nobody. The schema says the same thing in the field
 * description a model reads: when `plausible` is true the blockers are *"a
 * to-do list addressed to the reporter — the exact condition that would end the
 * watch"*.
 *
 * Without this, F is a machine that subscribes to a ticket, waits for an answer
 * to a question it never asked, and re-triages on whatever the reporter happened
 * to guess. The label is the subscription and this block is the request; posting
 * one without the other is the more expensive half of the feature running blind.
 *
 * It stays silent on an ordinary send-back, which is the original judgement and
 * is untouched: `plausible: false` below `ready-ish` renders nothing.
 */
export function buildFitnessNote(
  verdict: TriagePayload["verdict"],
  fitness: AgentFitness,
): string | null {
  if (verdict !== "ready-ish") {
    return fitness.plausible ? buildWatchNote(fitness) : null;
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
    // The reason first, then the caveat. Emitting only the caveat is what this
    // branch used to do, and it threw away the one ticket-specific thing the
    // payload carries — so the block said less than the data behind it, and
    // the model kept restoring the difference by hand.
    lines.push(
      fitness.rationale === "" ? "Assessed as safe for an autonomous fix." : fitness.rationale,
      "",
      // Deliberately not a promise. Nothing downstream consumes this label yet,
      // and manual mode means a human opts the ticket in even once something
      // does. Claiming a bot "will" pick it up would be false today and still
      // misleading later.
      "Nothing picks this up on its own — a human still has to opt the ticket in.",
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

const isSeparator = (line: string): boolean => line.trim() === "---";

/**
 * Removes every agent-fitness block already in the body, so the splice below
 * can be the only writer of one.
 *
 * ## What a block is, and where it stops
 *
 * It opens on a line *starting* with `FITNESS_MARKER` — column zero, not
 * anywhere in the line. The renderer writes it there, so a match at column zero
 * is the region this module owns, while a mention of the phrase inside a
 * sentence, a table cell or an evidence blockquote is the report talking about
 * fitness and is none of our business. Anchoring is the difference between the
 * two and there is no other signal that separates them.
 *
 * It closes at the next `---` or at the footer, whichever comes first, and both
 * are kept. Keeping the closing rule matters when two blocks are adjacent: it
 * becomes the *opening* rule of the second one, which the backward scan then
 * removes.
 *
 * ## The backward scan, which is the part that is easy to leave out
 *
 * The renderer emits `---`, a blank line, then the marker — so deleting from
 * the marker forward leaves a horizontal rule hanging under the report with
 * nothing beneath it. Walking back over blanks and separators first is what
 * makes the strip invisible rather than merely correct.
 */
function stripFitnessBlocks(body: string): string {
  const lines = body.split("\n");
  const kept: string[] = [];
  let inBlock = false;

  for (const line of lines) {
    if (line.startsWith(FITNESS_MARKER)) {
      inBlock = true;
      while (kept.length > 0) {
        const last = kept[kept.length - 1] ?? "";
        if (last.trim() !== "" && !isSeparator(last)) {
          break;
        }
        kept.pop();
      }
      continue;
    }

    if (!inBlock) {
      kept.push(line);
      continue;
    }

    if (isSeparator(line) || line.startsWith(FOOTER_SENTINEL)) {
      inBlock = false;
      kept.push(line);
    }
  }

  return kept.join("\n");
}

/**
 * Returns the payload with exactly one note in the comment, above the footer.
 *
 * Above rather than below because the footer sentinel is load-bearing: the
 * poster finds its own previous comment by matching that exact trailing line,
 * so anything appended after it would break update-in-place and start posting
 * duplicates on every re-run.
 *
 * **Strip then splice, and the strip runs even when there is no note to add.**
 * A ticket that was `plausible: true` last run and is not this one renders
 * `null` here, and returning early on that — which is what this function used
 * to do — leaves the previous run's watch note on the ticket for good: a list
 * of blockers addressed to a reporter nobody is waiting on any more. Removing
 * it is the same ownership claim as replacing it.
 *
 * A body with no sentinel is returned untouched. That is not this function's
 * failure to report — `assertPostable` already refuses such a body with a
 * message about the footer, and a second complaint here would only bury it.
 */
export function withFitnessNote(payload: TriagePayload): TriagePayload {
  const note = buildFitnessNote(payload.verdict, payload.agentFitness);
  const body = payload.mutation.commentBody;
  const stripped = stripFitnessBlocks(body);

  if (note === null && stripped === body) {
    return payload;
  }

  const at = stripped.lastIndexOf(FOOTER_SENTINEL);
  if (at === -1) {
    return payload;
  }

  const head = stripped.slice(0, at).trimEnd();
  const tail = stripped.slice(at);
  const commentBody = note === null ? `${head}\n\n${tail}` : `${head}\n\n${note}\n\n${tail}`;

  return { ...payload, mutation: { ...payload.mutation, commentBody } };
}
