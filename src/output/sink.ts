/**
 * Where a finished triage report goes.
 *
 * Two implementations are planned: a local-file sink (v1, always on) and a
 * Slack canvas sink. The canvas one is gated on access that has not been
 * confirmed yet, so the interface exists to keep that swap cheap.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Verdict emitted by the intake-triage skill. */
export type Verdict = "duplicate" | "not-our-team" | "needs-info" | "ready-ish";

export const VERDICT_EMOJI: Record<Verdict, string> = {
  duplicate: "🟥",
  "not-our-team": "🟥",
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
}

export interface OutputSink {
  readonly name: string;
  write(result: TriageResult): Promise<void>;
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
      result.report,
      "",
    ].join("\n");

    await writeFile(join(this.#directory, `${result.issueKey}.md`), body, "utf8");
  }
}
