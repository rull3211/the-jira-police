import { MONTHS } from "./rules.ts";
import type { Facts, Prose } from "./types.ts";

const PLACEHOLDER = "/*__REPORT_JSON__*/ null";

const part = (day: string) => ({
  y: day.slice(0, 4),
  m: MONTHS[Number(day.slice(5, 7)) - 1] ?? "?",
  d: String(Number(day.slice(8, 10))),
});

/** `5–12 Nov 2026`, or `30 Oct–5 Nov 2026` across a month. */
export function formatRange(start: string, end: string): string {
  const a = part(start);
  const b = part(end);
  const first = a.m === b.m && a.y === b.y ? a.d : `${a.d} ${a.m}${a.y === b.y ? "" : ` ${a.y}`}`;
  return `${first}–${b.d} ${b.m} ${b.y}`;
}

const list = (keys: readonly string[]): string => keys.join(", ");

// Built from code points: a literal U+2028 in this file would be a line break inside a regex.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/** JSON that cannot end the script element it sits in, or be split by a line separator. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(LINE_SEPARATOR, "\\u2028")
    .replaceAll(PARAGRAPH_SEPARATOR, "\\u2029");
}

export function buildReport(facts: Facts, prose: Prose): Record<string, unknown> {
  const written = new Map(prose.entries.map((entry) => [entry.key, entry]));
  const entries = facts.issues.map((issue) => {
    const text = written.get(issue.key);
    return {
      key: issue.key,
      type: issue.kind,
      theme: text?.theme ?? "",
      resolved: issue.resolved,
      title: text?.title ?? issue.summary,
      what: text?.what ?? "",
      why: text?.why ?? "",
      notes: text?.notes ?? [],
      statusNote: issue.statusNote,
      reporter: issue.reporter,
      links: issue.links.map((link) => ({ key: link.key, label: link.label })),
      prs: issue.prs.map((pr) => ({
        repo: pr.repo,
        n: pr.number,
        add: pr.additions,
        del: pr.deletions,
        merged: pr.merged,
        flags: pr.flags,
      })),
      others: issue.others.map((other) => ({ repo: other.repo, n: other.number, why: other.why })),
    };
  });

  const notices: { title: string; text: string }[] = [];
  if (facts.excluded.length > 0) {
    notices.push({
      title: "Resolved but not counted",
      text: facts.excluded.map((e) => `${e.key} (${e.reason})`).join(", "),
    });
  }
  const stale = facts.issues.filter((issue) => issue.statusNote !== null).map((issue) => issue.key);
  if (stale.length > 0) {
    notices.push({
      title: "Status and resolution disagree",
      text: `${list(stale)}: resolved, but the Jira status is not a done one. Counted.`,
    });
  }
  const open = facts.issues.flatMap((issue) =>
    issue.links.filter((link) => link.open).map((link) => `${link.key} (linked from ${issue.key})`),
  );
  if (open.length > 0) {
    notices.push({ title: "Linked work still open", text: open.join(", ") });
  }
  const bare = facts.issues.filter((issue) => issue.prs.length === 0).map((issue) => issue.key);
  if (bare.length > 0) {
    notices.push({ title: "No merged pull request found", text: list(bare) });
  }

  return {
    title: `${facts.scope.label} changelog`,
    subtitle: `Everything finished in the last ${String(facts.window.days)} days (${formatRange(facts.window.start, facts.window.end)}): ${facts.scope.summary}`,
    generated: facts.generated,
    window: facts.window,
    keyPrefixes: facts.keyPrefixes,
    jiraBase: facts.jiraBase,
    githubBase: facts.githubBase,
    repos: facts.repos,
    themes: prose.themes,
    entries,
    notices,
    callouts: prose.callouts,
    excluded: facts.excluded,
    scope: { summary: facts.scope.summary, jql: facts.scope.jql },
  };
}

/** The placeholder is replaced by a function so a `$&` inside the report is text, not a pattern. */
export function renderReport(template: string, facts: Facts, prose: Prose): string {
  if (template.split(PLACEHOLDER).length !== 2) {
    throw new Error(`the template must hold ${PLACEHOLDER} exactly once`);
  }
  return template.replace(PLACEHOLDER, () => safeJson(buildReport(facts, prose)));
}
