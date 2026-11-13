import { oneLine, shorten, shortenToSentence } from "../text.ts";
import { LIMITS, type Facts, type IssueFacts, type Prose } from "./types.ts";

const isWeb = (facts: Facts, issue: IssueFacts): boolean =>
  issue.prs.some((pr) => facts.repos.find((repo) => repo.name === pr.repo)?.kind === "web");

// Two digits at most, so a paragraph opening with a year ("2026. The release") is not a numbered item.
const BULLET = /^\s*(?:[-*]|\d{1,2}\.)\s+/u;
const NOT_PROSE: readonly RegExp[] = [
  BULLET,
  /^\s*#{1,6}\s/u,
  /^\s*-{3,}\s*$/u,
  /\s\|\s/u,
  /^\s*\[attachment(?:: [^\]]*)?\]\s*$/u,
  /^\s*https?:\/\/\S+\s*$/u,
];

/** A list as one line: an item's continuation lines join it, and items are separated by a middle dot. */
function listItems(lines: readonly string[]): string {
  const items: string[] = [];
  for (const line of lines) {
    if (BULLET.test(line)) {
      items.push(line.replace(BULLET, ""));
    } else {
      const last = items.pop();
      items.push(last === undefined ? line.trim() : `${last} ${line.trim()}`);
    }
  }
  return items.join(" · ");
}

/** The first paragraph that is not a heading, list, table, attachment or bare link; else the first list. */
function openingProse(description: string): string {
  const blocks = description
    .replaceAll(/```[\s\S]*?(?:```|$)/gu, "")
    .split(/\n\s*\n/u)
    .map((block) =>
      block
        .split("\n")
        .map((line) => line.replace(/^\s*>(?: |$)/u, ""))
        .filter((line) => line.trim() !== ""),
    )
    .filter((lines) => lines.length > 0);
  const prose = blocks.find((lines) => !lines.some((line) => NOT_PROSE.some((p) => p.test(line))));
  if (prose !== undefined) {
    return oneLine(prose.join(" "));
  }
  const list = blocks.find((lines) => BULLET.test(lines[0] ?? ""));
  return list === undefined ? "" : oneLine(listItems(list));
}

/**
 * The report with no model: Jira's summary as the title, the description's opening prose under it.
 * Built from nothing a model said.
 */
export function mechanicalProse(facts: Facts): Prose {
  const web = facts.issues.filter((issue) => isWeb(facts, issue));
  const themes = [
    ...(web.length > 0 ? [{ id: "web", label: "Web apps" }] : []),
    ...(web.length < facts.issues.length ? [{ id: "other", label: "Services and other" }] : []),
  ];
  return {
    themes,
    entries: facts.issues.map((issue) => ({
      key: issue.key,
      theme: isWeb(facts, issue) ? "web" : "other",
      title: shorten(oneLine(issue.summary), LIMITS.title),
      what: shortenToSentence(openingProse(issue.description), LIMITS.what),
      why: "",
      notes: [],
    })),
    callouts: [],
  };
}
