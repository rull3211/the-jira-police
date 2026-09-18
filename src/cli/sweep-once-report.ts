/**
 * What `sweep:once` writes down.
 *
 * Split out of `sweep-once.ts` for the reason `attach-stage-report.ts` gives:
 * that file ends in a top-level `await`, so importing it into a test runs the
 * command.
 */

import type { SweepGroup } from "../sweep.ts";
import type { StagingVerdict } from "../staging-sweep.ts";

function formatVerdict(parentDirectory: string, verdict: StagingVerdict, write: boolean): string {
  const ageHours = (verdict.ageMs / 3_600_000).toFixed(1);
  const action = verdict.sweep ? (write ? "removed" : "would remove") : "keeping (too young)";
  return `- ${action} — ${verdict.kind}, ${ageHours}h old — \`${parentDirectory}/${verdict.name}\``;
}

/** The artifact, which is the half of a dry run worth reading tomorrow. */
export function formatReport(groups: readonly SweepGroup[], write: boolean, now: Date): string {
  const lines = [
    `# Staging sweep — ${write ? "write" : "dry run"}`,
    "",
    `- **Run:** ${now.toISOString()}`,
    `- **Mode:** ${write ? "write — stale entries removed" : "dry run — nothing removed"}`,
    "",
  ];

  for (const group of groups) {
    lines.push(`## ${group.parentDirectory}`, "");
    if (group.verdicts.length === 0) {
      lines.push("Nothing this sweep recognises.", "");
      continue;
    }
    for (const verdict of group.verdicts) {
      lines.push(formatVerdict(group.parentDirectory, verdict, write));
    }
    lines.push("");
  }

  lines.push(
    "---",
    "",
    "_A live git worktree never appears above: its directory name is the bare_",
    "_issue key, which `staging-sweep.ts` cannot match — see that module's own_",
    "_comment for the argument._",
    "",
  );
  return lines.join("\n");
}
