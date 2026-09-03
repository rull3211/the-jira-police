/**
 * Where a finished triage report goes.
 *
 * Two implementations are planned: a local-file sink (v1, always on) and a
 * Slack canvas sink. The canvas one is gated on access that has not been
 * confirmed yet, so the interface exists to keep that swap cheap.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Mutually referential with `runner.ts`, which imports `Verdict` from here.
// Both directions are `import type`, so the cycle exists only for the type
// checker: Node's type-stripping erases these lines before anything is loaded.
import type { AgentFitness } from "../triage/runner.ts";

/** Verdict emitted by the intake-triage skill. */
export type Verdict = "duplicate" | "not-our-team" | "out-of-scope" | "needs-info" | "ready-ish";

export const VERDICT_EMOJI: Record<Verdict, string> = {
  duplicate: "🟥",
  "not-our-team": "🟥",
  "out-of-scope": "🟥",
  "needs-info": "🟨",
  "ready-ish": "🟩",
};

export interface TriageResult {
  readonly issueKey: string;
  readonly issueUrl: string;
  readonly summary: string;
  readonly verdict: Verdict;
  /** Labels the skill suggests, e.g. dor:gaps, route:ours. */
  readonly labels: readonly string[];
  readonly recommendedNextStep: string;
  /** The full report, as rendered by the skill. */
  readonly report: string;
  /**
   * The agent-fitness call, carried through so it can be judged.
   *
   * Required rather than optional, and that is the point. The assessment ships
   * ahead of anything that acts on it precisely so its accuracy can be measured
   * first — which is impossible if it never reaches an artifact. It did not: the
   * first live run produced a fitness call that existed only in memory, and the
   * sole surviving trace on disk was whether `agent:solvable` appeared in
   * `labels`. That is the conclusion without the reasoning, so a wrong call and
   * a right one look identical afterwards.
   *
   * Both construction sites already hold the payload, so there is no caller for
   * whom this is a burden, and optional would only have re-created the hole.
   */
  readonly agentFitness: AgentFitness;
}

export interface OutputSink {
  readonly name: string;
  write(result: TriageResult): Promise<void>;
}

/** Everything needed to judge a refusal after the fact. */
export interface Rejection {
  readonly issueKey: string;
  readonly violations: readonly string[];
  readonly verdict: string;
  readonly labels: readonly string[];
  readonly dorPlaceholders: readonly string[];
  /** The payload that was refused, rendered as-is. */
  readonly mutation: Readonly<Record<string, unknown>>;
}

/**
 * Writes a refused mutation to `<dir>/<ISSUE-KEY>.rejected.md`.
 *
 * The gate throws, and a throw carries only its message — so without this the
 * one artifact an operator needs to decide whether the refusal was *correct*,
 * the comment body itself, is destroyed at the moment it becomes interesting.
 * That matters more than it sounds: these checks are heuristics over prose, and
 * a heuristic you cannot audit is one you end up disabling out of frustration.
 *
 * Written under a distinct suffix rather than `<KEY>.md` so a refusal can never
 * be mistaken for a delivered report, and so a later successful run does not
 * silently overwrite the evidence of the earlier failure.
 */
export async function writeRejection(directory: string, rejection: Rejection): Promise<void> {
  await mkdir(directory, { recursive: true });

  const body = [
    `# ${rejection.issueKey} — REFUSED, nothing was posted`,
    "",
    `- **Verdict:** ${rejection.verdict}`,
    `- **Labels:** ${rejection.labels.join(", ") || "—"}`,
    `- **DoR placeholders:** ${rejection.dorPlaceholders.join(", ") || "—"}`,
    "",
    "## Why it was refused",
    "",
    ...rejection.violations.map((violation) => `- ${violation}`),
    "",
    "## The mutation that was withheld",
    "",
    "```json",
    JSON.stringify(rejection.mutation, null, 2),
    "```",
    "",
  ].join("\n");

  await writeFile(join(directory, `${rejection.issueKey}.rejected.md`), body, "utf8");
}

/**
 * Removes a superseded rejection, if one is there.
 *
 * A refusal file is a claim about the present — "this ticket has a mutation we
 * would not post". Once a later run gets through the gate that claim is false,
 * and leaving it on disk puts a stale failure next to a fresh report for the
 * same key. Whoever reads the directory next has no way to tell which is
 * current.
 *
 * Missing file is the normal case, not an error: most runs never refuse.
 */
export async function clearRejection(directory: string, issueKey: string): Promise<void> {
  await rm(join(directory, `${issueKey}.rejected.md`), { force: true });
}

/**
 * The fitness call, rendered so a human can mark it right or wrong.
 *
 * Both halves are shown. A "no" is the common case and the more interesting
 * one to audit — the failure mode this whole staged rollout is guarding against
 * is an assessment that says yes when it should not, and you cannot spot the
 * pattern in the yeses without the noes to compare them against. So the
 * rationale and blockers print either way; only `repo` is conditional, because
 * it is routinely empty when the answer is no and an empty field teaches
 * nothing.
 */
export function formatAgentFitness(fitness: AgentFitness): readonly string[] {
  const verdict = fitness.solvable ? "🤖 yes" : "— no";

  return [
    "## Agent fitness",
    "",
    `- **Solvable by an agent:** ${verdict} (confidence: ${fitness.confidence})`,
    ...(fitness.repo === "" ? [] : [`- **Repo:** \`${fitness.repo}\``]),
    `- **Rationale:** ${fitness.rationale === "" ? "—" : fitness.rationale}`,
    `- **Blockers:** ${fitness.blockers.length > 0 ? fitness.blockers.join("; ") : "—"}`,
  ];
}

/** One line, suitable for a canvas checklist item or a terminal summary. */
export function formatChecklistLine(result: TriageResult): string {
  const emoji = VERDICT_EMOJI[result.verdict];
  const labels = result.labels.length > 0 ? ` · ${result.labels.join(" ")}` : "";
  return `- [ ] ${emoji} [${result.issueKey}](${result.issueUrl}) — ${result.summary}${labels}`;
}

/**
 * Writes the full report to `<dir>/<ISSUE-KEY>.md`.
 *
 * This is the v1 sink: it lets the output be judged over the first several runs
 * before anything is published anywhere the team can see.
 */
export class FileSink implements OutputSink {
  readonly name = "file";

  // Written out longhand rather than as a parameter property: Node's
  // type-stripping runtime rejects those, and this project has no build step.
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async write(result: TriageResult): Promise<void> {
    await mkdir(this.#directory, { recursive: true });

    const body = [
      `# ${result.issueKey} — ${result.summary}`,
      "",
      `- **Verdict:** ${VERDICT_EMOJI[result.verdict]} ${result.verdict}`,
      `- **Labels:** ${result.labels.length > 0 ? result.labels.join(", ") : "—"}`,
      `- **Next step:** ${result.recommendedNextStep}`,
      `- **Issue:** ${result.issueUrl}`,
      "",
      "---",
      "",
      ...formatAgentFitness(result.agentFitness),
      "",
      "---",
      "",
      result.report,
      "",
    ].join("\n");

    await writeFile(join(this.#directory, `${result.issueKey}.md`), body, "utf8");
  }
}
