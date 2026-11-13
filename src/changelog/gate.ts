import { dayOf } from "./rules.ts";
import { MAX_THEMES, type Facts, type Prose } from "./types.ts";

export class ChangelogGateError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `the changelog was not rendered, ${String(problems.length)} problem(s): ${problems.slice(0, 8).join("; ")}${problems.length > 8 ? "; …" : ""}`,
    );
    this.problems = problems;
  }
}

const duplicates = (keys: readonly string[]): string[] =>
  keys.filter((key, index) => keys.indexOf(key) !== index);

/**
 * Refuses a report whose issues are not exactly the ones the query returned, or whose prose does not
 * cover them exactly once. `queryKeys` is what Jira answered, read before anything was classified.
 */
export function assertReportable(facts: Facts, prose: Prose, queryKeys: readonly string[]): void {
  const problems: string[] = [];
  const counted = facts.issues.map((issue) => issue.key);
  const excluded = facts.excluded.map((entry) => entry.key);
  const accounted = [...counted, ...excluded];

  for (const key of duplicates(queryKeys)) {
    problems.push(`${key} was returned twice by the query`);
  }
  for (const key of duplicates(accounted)) {
    problems.push(`${key} is in the report twice`);
  }
  for (const key of queryKeys.filter((k) => !accounted.includes(k))) {
    problems.push(`${key} was returned by the query and is neither counted nor excluded`);
  }
  for (const key of accounted.filter((k) => !queryKeys.includes(k))) {
    problems.push(`${key} is in the report and was not returned by the query`);
  }

  for (const issue of facts.issues) {
    const day = dayOf(issue.resolved);
    if (day < facts.window.start || day > facts.window.end) {
      problems.push(
        `${issue.key} was resolved on ${day}, outside ${facts.window.start} to ${facts.window.end}`,
      );
    }
  }

  const written = prose.entries.map((entry) => entry.key);
  for (const key of duplicates(written)) {
    problems.push(`prose for ${key} appears twice`);
  }
  for (const key of counted.filter((k) => !written.includes(k))) {
    problems.push(`no prose for ${key}`);
  }
  for (const key of written.filter((k) => !counted.includes(k))) {
    problems.push(`prose for ${key}, which is not a counted issue`);
  }

  const themeIds = prose.themes.map((theme) => theme.id);
  if (prose.themes.length > MAX_THEMES) {
    problems.push(
      `${String(prose.themes.length)} themes, at most ${String(MAX_THEMES)} have a colour`,
    );
  }
  for (const id of duplicates(themeIds)) {
    problems.push(`theme ${id} is declared twice`);
  }
  if (prose.themes.some((theme) => theme.id.trim() === "" || theme.label.trim() === "")) {
    problems.push("a theme has an empty id or label");
  }
  for (const entry of prose.entries) {
    if (!themeIds.includes(entry.theme)) {
      problems.push(`${entry.key} names theme "${entry.theme}", which is not declared`);
    }
    if (entry.title.trim() === "") {
      problems.push(`${entry.key} has no title`);
    }
  }

  if (problems.length > 0) {
    throw new ChangelogGateError(problems);
  }
}
