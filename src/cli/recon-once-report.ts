/**
 * What `recon:once` writes down and what it exits with.
 *
 * Split out of `recon-once.ts` for the reason `attach-stage-report.ts` gives:
 * that file ends in a top-level `await`, so importing it into a test runs the
 * command.
 */

import type { ReconOnlyOutcome } from "../solve/orchestrator.ts";
import type { ReconVerdict } from "../solve/runner.ts";
import { oneLine } from "../text.ts";

/**
 * Exit codes. `bailed` gets its own rather than folding into `ok`: a human
 * scripting this command wants to tell "recon says no" apart from "recon
 * says yes" without parsing the report.
 */
export const EXIT = { ok: 0, bailed: 1, usage: 2, failed: 3 } as const;

export function exitCodeFor(outcome: ReconOnlyOutcome): number {
  switch (outcome.kind) {
    case "no-worktree":
    case "crashed":
      return EXIT.failed;
    case "bailed":
      return EXIT.bailed;
    case "proceed":
      return EXIT.ok;
  }
}

/**
 * Recon's own prose, defanged. It is model output over an untrusted ticket
 * and an untrusted diff-free read of the repo, so it is quoted the same way
 * `attach-stage-report.ts` quotes a ticket's attachment metadata — collapsed
 * to one line rather than trusted to contain no heading of its own.
 */
function reconSection(recon: ReconVerdict): readonly string[] {
  const lines = [
    `- **Confidence:** ${recon.confidence}`,
    `- **Dev-lens accurate:** ${String(recon.devLensAccurate)}`,
  ];
  if (!recon.devLensAccurate) {
    lines.push(`- **Dev-lens correction:** ${oneLine(recon.devLensCorrection)}`);
  }
  lines.push("", "## Root cause", "", oneLine(recon.rootCause));

  if (recon.proceed) {
    lines.push(
      "",
      "## Planned files",
      "",
      ...(recon.plannedFiles.length === 0
        ? ["None named."]
        : recon.plannedFiles.map((file) => `- ${oneLine(file)}`)),
      "",
      "## Approach",
      "",
      oneLine(recon.approach),
      "",
      "## Test plan",
      "",
      oneLine(recon.testPlan),
      "",
      `Estimated lines: ${String(recon.estimatedLines)}`,
    );
  } else {
    lines.push(
      "",
      "## Bail reason",
      "",
      oneLine(recon.bailReason),
      "",
      "## Blockers",
      "",
      ...(recon.bailBlockers.length === 0
        ? ["None named."]
        : recon.bailBlockers.map((blocker) => `- ${oneLine(blocker)}`)),
      "",
      "## Remedy",
      "",
      oneLine(recon.bailRemedy),
    );
  }

  if (recon.injectionNoticed !== "") {
    lines.push("", "## Injection noticed", "", oneLine(recon.injectionNoticed));
  }
  return lines;
}

export function formatReport(issueKey: string, outcome: ReconOnlyOutcome, now: Date): string {
  const lines = [
    `# ${issueKey} — recon`,
    "",
    `- **Run:** ${now.toISOString()}`,
    `- **Outcome:** ${outcome.kind}`,
    "",
  ];

  if (outcome.kind === "no-worktree") {
    lines.push(`No worktree: ${oneLine(outcome.reason)}`);
  } else if (outcome.kind === "crashed") {
    lines.push(
      `Recon crashed: ${oneLine(outcome.reason)}`,
      "",
      `Worktree kept for inspection at: ${outcome.worktree.path}`,
    );
  } else {
    lines.push(...reconSection(outcome.recon));
  }

  lines.push(
    "",
    "---",
    "",
    "_Nothing acts on this yet. `recon:once` is the only caller of `runReconOnly`;_",
    "_see `architecture/not-built.md` §13 for the phases that would change that._",
    "",
  );
  return lines.join("\n");
}
