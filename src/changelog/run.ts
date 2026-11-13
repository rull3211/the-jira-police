import { type ChangelogSettings, type CollectDeps, collectFacts } from "./collect.ts";
import { ChangelogGateError, assertReportable } from "./gate.ts";
import { mechanicalProse } from "./mechanical.ts";
import { renderReport } from "./render.ts";

export interface RunDeps {
  readonly collect: CollectDeps;
  readonly scope: ChangelogSettings;
  readonly template: string;
  /** Writes one file under the report directory; the name carries no path. */
  readonly write: (file: string, content: string) => Promise<void>;
}

export type RunOutcome =
  | {
      readonly kind: "written";
      readonly name: string;
      readonly issues: number;
      readonly excluded: number;
      readonly pullRequests: number;
    }
  | { readonly kind: "refused"; readonly name: string; readonly problems: readonly string[] };

/**
 * One report, from nothing to a page. The facts are written before the gate looks at them, so a refusal
 * leaves the evidence it was made from; a page is written only after the gate has passed.
 */
export async function runChangelog(deps: RunDeps, days: number): Promise<RunOutcome> {
  const { facts, queryKeys } = await collectFacts(deps.collect, deps.scope, days);
  const name = `${facts.window.end}-${String(days)}d`;
  await deps.write(`${name}.facts.json`, `${JSON.stringify({ queryKeys, facts }, null, 2)}\n`);

  const prose = mechanicalProse(facts);
  try {
    assertReportable(facts, prose, queryKeys);
  } catch (error) {
    if (error instanceof ChangelogGateError) {
      return { kind: "refused", name, problems: error.problems };
    }
    throw error;
  }

  await deps.write(`${name}.html`, renderReport(deps.template, facts, prose));
  const pullRequests = new Set(
    facts.issues.flatMap((issue) => issue.prs.map((pr) => `${pr.repo}#${String(pr.number)}`)),
  );
  return {
    kind: "written",
    name,
    issues: facts.issues.length,
    excluded: facts.excluded.length,
    pullRequests: pullRequests.size,
  };
}
