/**
 * Renders the agent-fitness call onto the ticket from `payload.agentFitness` rather than having
 * the model write prose, so the comment can never disagree with the structured field. It owns the
 * comment's tail, so it also puts back a legend the model wrote below the footer sentinel.
 */

import { FITNESS_MARKER, FOOTER_SENTINEL } from "./gate.ts";
import type { AgentFitness, TriagePayload } from "./runner.ts";

/**
 * The send-back watch note: unlike the `ready-ish` block, it promises a human will look again,
 * and treats `blockers` as the exhaustive list of what would end the watch.
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
 * Renders the block, or `null` when it should stay off the ticket: always on `ready-ish`,
 * otherwise only when `plausible` (the send-back watch), since `plausible` and `solvable` are the
 * gate's alternatives.
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
    lines.push(
      fitness.rationale === "" ? "Assessed as safe for an autonomous fix." : fitness.rationale,
      "",
      // Deliberately not a promise: nothing consumes this label yet, and manual mode means a
      // human still opts the ticket in even after something does.
      "Nothing picks this up on its own — a human still has to opt the ticket in.",
    );
    return lines.join("\n");
  }

  // A "no" with no blockers is reachable — the gate only enforces solvable ⇒ no blockers, not the
  // reverse — so fall back to the rationale rather than render a bare refusal.
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
 * Removes existing agent-fitness blocks so the splice below is the only writer of one. A block
 * opens on a line starting with `FITNESS_MARKER` (column zero only, so a mention mid-sentence
 * doesn't count) and closes at the next `---` or the footer; the backward scan also eats the
 * separator/blank the renderer put before the marker, so no dangling `---` is left behind.
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

const isLegend = (line: string): boolean => line.trimStart().startsWith("_Legend:");

/**
 * Moves the skill's legend line back above the sentinel when it is the one line below it, since
 * upstream told the model to end the comment with each. Anything else below is left for the gate.
 */
function legendAboveSentinel(body: string): string {
  const lines = body.trimEnd().split("\n");
  const at = lines.findLastIndex((line) => line.trimEnd() === FOOTER_SENTINEL);
  const below = lines.slice(at + 1).filter((line) => line.trim() !== "");
  const legend = below[0];

  if (at === -1 || below.length !== 1 || legend === undefined || !isLegend(legend)) {
    return body;
  }

  return `${lines.slice(0, at).join("\n").trimEnd()}\n\n${legend.trim()}\n\n${FOOTER_SENTINEL}`;
}

/**
 * Returns the payload with exactly one note in the comment, above the footer sentinel, which is
 * left as the last line. The strip always runs, even with no note to add, so a watch note is
 * cleared once the ticket stops qualifying; a body with no sentinel is returned untouched since
 * `assertPostable` refuses it elsewhere.
 */
export function withFitnessNote(payload: TriagePayload): TriagePayload {
  const note = buildFitnessNote(payload.verdict, payload.agentFitness);
  const body = payload.mutation.commentBody;
  // Stripped first: a block runs to the sentinel, so a legend moved above it first would go with it.
  const tidied = legendAboveSentinel(stripFitnessBlocks(body));

  if (note === null && tidied === body) {
    return payload;
  }

  const at = tidied.lastIndexOf(FOOTER_SENTINEL);
  if (at === -1) {
    return payload;
  }

  const head = tidied.slice(0, at).trimEnd();
  const tail = tidied.slice(at);
  const commentBody = note === null ? `${head}\n\n${tail}` : `${head}\n\n${note}\n\n${tail}`;

  return { ...payload, mutation: { ...payload.mutation, commentBody } };
}
