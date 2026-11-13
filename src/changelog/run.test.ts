import { describe, expect, it, vi } from "vitest";

import type { IssueDetail } from "../jira/client.ts";
import type { JiraIssue } from "../jira/types.ts";
import type { ChangelogSettings } from "./collect.ts";
import type { FoundPullRequest } from "./github.ts";
import { DEFAULT_EXCLUSIONS } from "./rules.ts";
import { runChangelog } from "./run.ts";

const scope: ChangelogSettings = {
  project: "SSX",
  component: "SSX Advisor",
  teamId: null,
  label: "SSX Advisor",
  jiraBase: "https://example.atlassian.net/browse/",
  org: "acme",
  repos: [{ name: "advisor-web", full: "buy-insurance-advisor-web", kind: "web" }],
  exclusions: DEFAULT_EXCLUSIONS,
};

const raw = (key: string, resolved: string, fields: Record<string, unknown> = {}): JiraIssue =>
  ({
    id: "1",
    key,
    fields: {
      summary: `Summary of ${key}`,
      issuetype: { id: "1", name: "Oppgave", subtask: false },
      status: { id: "1", name: "Ferdig", statusCategory: { key: "done" } },
      resolution: { name: "Solved" },
      resolutiondate: resolved,
      ...fields,
    },
  }) as unknown as JiraIssue;

const detail = (key: string): IssueDetail => ({
  key,
  summary: "",
  issueTypeName: "",
  status: "",
  labels: [],
  description: null,
  comments: [],
  attachments: [],
  url: "",
});

const pr = (key: string): FoundPullRequest => ({
  repo: "advisor-web",
  number: 5,
  title: `feat(${key}): change`,
  branch: "feat/x",
  state: "merged",
  additions: 3,
  deletions: 1,
  mergedAt: "2026-11-10T10:00:00Z",
  body: "",
});

const TEMPLATE = "<script>const REPORT = /*__REPORT_JSON__*/ null;</script>";

function harness(issues: readonly JiraIssue[]) {
  const files = new Map<string, string>();
  const write = vi.fn(async (file: string, content: string) => {
    files.set(file, content);
  });
  const deps = {
    collect: {
      jira: { searchFields: async () => issues, fetchDetail: async (key: string) => detail(key) },
      github: { search: async (key: string) => [pr(key)], mergedSince: async () => [] },
      now: () => new Date(2026, 10, 12, 15, 0, 0),
    },
    scope,
    template: TEMPLATE,
    write,
  };
  return { deps, files, write };
}

describe("runChangelog", () => {
  it("writes the facts and then the page, and says what it counted", async () => {
    const h = harness([
      raw("SSX-1", "2026-11-10T12:00:00.000+0100"),
      raw("SSX-2", "2026-11-11T12:00:00.000+0100", { resolution: { name: "Duplikat" } }),
    ]);
    const outcome = await runChangelog(h.deps, 7);

    expect(outcome).toEqual({
      kind: "written",
      name: "2026-11-12-7d",
      issues: 1,
      excluded: 1,
      pullRequests: 1,
    });
    expect([...h.files.keys()]).toEqual(["2026-11-12-7d.facts.json", "2026-11-12-7d.html"]);
    expect(JSON.parse(h.files.get("2026-11-12-7d.facts.json") ?? "{}")).toMatchObject({
      queryKeys: ["SSX-1", "SSX-2"],
      facts: { window: { days: 7 } },
    });
    expect(h.files.get("2026-11-12-7d.html")).toContain('"key":"SSX-1"');
  });

  it("keeps the facts but writes no page when the gate refuses, and says why", async () => {
    // Resolved the day before the window opens: the query and the clock disagree, so the report is not trusted.
    const h = harness([raw("SSX-1", "2026-11-04T12:00:00.000+0100")]);
    const outcome = await runChangelog(h.deps, 7);

    expect(outcome).toEqual({
      kind: "refused",
      name: "2026-11-12-7d",
      problems: ["SSX-1 was resolved on 2026-11-04, outside 2026-11-05 to 2026-11-12"],
    });
    expect([...h.files.keys()]).toEqual(["2026-11-12-7d.facts.json"]);
  });

  it("writes nothing when Jira cannot be read, since there is nothing yet to keep", async () => {
    const h = harness([]);
    h.deps.collect.jira.searchFields = async () => {
      throw new Error("Jira 401");
    };
    await expect(runChangelog(h.deps, 7)).rejects.toThrow("Jira 401");
    expect(h.write).not.toHaveBeenCalled();
  });

  it("reports an empty window as a written page with nothing in it", async () => {
    const outcome = await runChangelog(harness([]).deps, 7);
    expect(outcome).toMatchObject({ kind: "written", issues: 0, excluded: 0, pullRequests: 0 });
  });
});
