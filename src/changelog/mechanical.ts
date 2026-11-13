import { oneLine, shorten, shortenToSentence } from "../text.ts";
import { LIMITS, type Facts, type IssueFacts, type Prose } from "./types.ts";

const isWeb = (facts: Facts, issue: IssueFacts): boolean =>
  issue.prs.some((pr) => facts.repos.find((repo) => repo.name === pr.repo)?.kind === "web");

/**
 * The report with no model: Jira's summary as the title, the description's opening paragraph under it.
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
      what: shortenToSentence(oneLine(issue.description.split(/\n\s*\n/u)[0] ?? ""), LIMITS.what),
      why: "",
      notes: [],
    })),
    callouts: [],
  };
}
