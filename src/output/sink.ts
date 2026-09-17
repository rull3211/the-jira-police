/**
 * Where a finished triage report goes.
 *
 * One implementation: the local-file sink below.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Mutually referential with `runner.ts` via `import type` only, so the cycle vanishes once types are stripped.
import { type AgentFitness, type DorPlaceholder, UNATTRIBUTED_DOR_ROW } from "../triage/runner.ts";

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
  /** Required rather than optional: without an artifact recording it, a wrong call and a right one look identical after the fact. */
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
  readonly dorPlaceholders: readonly DorPlaceholder[];
  /** The payload that was refused, rendered as-is. */
  readonly mutation: Readonly<Record<string, unknown>>;
}

/** Writes a refused mutation to `<dir>/<ISSUE-KEY>.rejected.md`; the distinct suffix keeps it from being mistaken for a delivered report. */
export async function writeRejection(directory: string, rejection: Rejection): Promise<void> {
  await mkdir(directory, { recursive: true });

  const body = [
    `# ${rejection.issueKey} — REFUSED, nothing was posted`,
    "",
    `- **Verdict:** ${rejection.verdict}`,
    `- **Labels:** ${rejection.labels.join(", ") || "—"}`,
    `- **DoR placeholders:** ${
      rejection.dorPlaceholders
        .map(
          (placeholder) =>
            `${placeholder.text} (${
              placeholder.row === UNATTRIBUTED_DOR_ROW ? "no row given" : `row ${placeholder.row}`
            })`,
        )
        .join(", ") || "—"
    }`,
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

/** Once a later run clears the gate, a prior refusal file's claim is stale and would sit beside a fresh report for the same key. */
export async function clearRejection(directory: string, issueKey: string): Promise<void> {
  await rm(join(directory, `${issueKey}.rejected.md`), { force: true });
}

/** `plausible` prints only on a no: the gate forbids it being true beside a yes, so on a yes it would always read "no". */
export function formatAgentFitness(fitness: AgentFitness): readonly string[] {
  const verdict = fitness.solvable ? "🤖 yes" : "— no";

  return [
    "## Agent fitness",
    "",
    `- **Solvable by an agent:** ${verdict} (confidence: ${fitness.confidence})`,
    ...(fitness.solvable
      ? []
      : [`- **Nearly solvable:** ${fitness.plausible ? "👀 yes — watching" : "— no"}`]),
    ...(fitness.repo === "" ? [] : [`- **Repo:** \`${fitness.repo}\``]),
    `- **Rationale:** ${fitness.rationale === "" ? "—" : fitness.rationale}`,
    `- **Blockers:** ${fitness.blockers.length > 0 ? fitness.blockers.join("; ") : "—"}`,
  ];
}

/** Writes the full report to `<dir>/<ISSUE-KEY>.md`. */
export class FileSink implements OutputSink {
  readonly name = "file";

  // Written out longhand rather than as a parameter property: Node's type-stripping runtime rejects those.
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
