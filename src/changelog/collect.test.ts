import { describe, expect, it, vi } from "vitest";

import type { IssueDetail } from "../jira/client.ts";
import type { JiraIssue } from "../jira/types.ts";
import { type ChangelogSettings, SEARCH_FIELDS, collectFacts } from "./collect.ts";
import type { FoundPullRequest, PullRequestSource } from "./github.ts";
import { DEFAULT_EXCLUSIONS } from "./rules.ts";

const TEAM = "3536e3e8-eddf-4306-9991-173a45afc8a2";

const settings: ChangelogSettings = {
  project: "SSX",
  component: "SSX Advisor",
  teamId: TEAM,
  label: "SSX Advisor",
  jiraBase: "https://example.atlassian.net/browse/",
  org: "acme",
  repos: [
    { name: "advisor-web", full: "buy-insurance-advisor-web", kind: "web" },
    { name: "commerce-rest", full: "insurance-commerce-rest-api", kind: "service" },
  ],
  exclusions: DEFAULT_EXCLUSIONS,
};

const NOW = (): Date => new Date(2026, 10, 12, 15, 0, 0);

function raw(key: string, fields: Record<string, unknown> = {}): JiraIssue {
  return {
    id: "1",
    key,
    fields: {
      summary: `Summary of ${key}`,
      issuetype: { id: "1", name: "Oppgave", subtask: false },
      created: "2026-11-01T10:00:00.000+0100",
      status: { id: "1", name: "Ferdig", statusCategory: { key: "done" } },
      resolution: { name: "Solved" },
      resolutiondate: "2026-11-10T12:00:00.000+0100",
      reporter: { accountId: "a", displayName: "Ada" },
      issuelinks: [],
      ...fields,
    },
  } as unknown as JiraIssue;
}

const doc = (text: string): unknown => ({
  type: "doc",
  version: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const detail = (key: string): IssueDetail => ({
  key,
  summary: "",
  issueTypeName: "Oppgave",
  status: "Ferdig",
  labels: [],
  description: doc(`Description of ${key}.`),
  comments: [
    {
      id: "1",
      author: "Bo",
      created: "2026-11-09T10:00:00.000+0100",
      updated: "",
      body: doc("A  comment\n\nwith   spaces"),
    },
  ],
  attachments: [],
  url: "",
});

const pr = (
  over: Partial<FoundPullRequest> & Pick<FoundPullRequest, "number">,
): FoundPullRequest => ({
  repo: "advisor-web",
  title: "feat(SSX-1): a change",
  branch: "feat/other",
  state: "merged",
  additions: 10,
  deletions: 2,
  mergedAt: "2026-11-10T09:00:00Z",
  body: "the body",
  ...over,
});

function harness(
  issues: readonly JiraIssue[],
  byKey: Record<string, readonly FoundPullRequest[]> = {},
  merged: readonly FoundPullRequest[] = [],
) {
  const searchFields = vi.fn(async () => issues);
  const fetchDetail = vi.fn(async (key: string) => detail(key));
  const search = vi.fn<PullRequestSource["search"]>(async (key) => byKey[key] ?? []);
  const mergedSince = vi.fn<PullRequestSource["mergedSince"]>(async () => merged);
  const github: PullRequestSource = { search, mergedSince };
  return {
    deps: { jira: { searchFields, fetchDetail }, github, now: NOW },
    searchFields,
    fetchDetail,
    search,
    mergedSince,
  };
}

describe("collectFacts", () => {
  it("asks Jira for the scoped query over the window and reads an issue into facts", async () => {
    const h = harness([raw("SSX-1", { parent: { key: "SSX-100" } })], {
      "SSX-1": [pr({ number: 5 })],
    });
    const { facts, queryKeys } = await collectFacts(h.deps, settings, 7);

    expect(queryKeys).toEqual(["SSX-1"]);
    expect(facts.window).toEqual({ start: "2026-11-05", end: "2026-11-12", days: 7 });
    expect(h.searchFields).toHaveBeenCalledWith(facts.scope.jql, SEARCH_FIELDS);
    expect(facts.scope.jql).toContain(`(component = "SSX Advisor" OR Team = "${TEAM}")`);
    expect(facts.issues).toHaveLength(1);
    expect(facts.issues[0]).toMatchObject({
      key: "SSX-1",
      kind: "task",
      summary: "Summary of SSX-1",
      resolved: "2026-11-10T12:00:00.000+0100",
      reporter: "Ada",
      parent: "SSX-100",
      statusNote: null,
      description: "Description of SSX-1.",
      comments: [{ author: "Bo", text: "A comment with spaces" }],
      prs: [
        {
          repo: "advisor-web",
          number: 5,
          additions: 10,
          deletions: 2,
          merged: "10 Nov",
          body: "the body",
          flags: [],
        },
      ],
    });
  });

  it("excludes a duplicate and a rejected issue without spending a Jira or GitHub call on either", async () => {
    const h = harness([
      raw("SSX-1"),
      raw("SSX-2", { resolution: { name: "Duplikat" } }),
      raw("SSX-3", { status: { id: "2", name: "Avvist", statusCategory: { key: "done" } } }),
    ]);
    const { facts } = await collectFacts(h.deps, settings, 7);

    expect(facts.issues.map((i) => i.key)).toEqual(["SSX-1"]);
    expect(facts.excluded).toEqual([
      { key: "SSX-2", reason: "resolution Duplikat" },
      { key: "SSX-3", reason: "status Avvist" },
    ]);
    expect(h.fetchDetail.mock.calls.map((c) => c[0])).toEqual(["SSX-1"]);
    expect(h.search.mock.calls.map((c) => c[0])).toEqual(["SSX-1"]);
  });

  it("counts an issue resolved but not in a done status, and says what Jira shows", async () => {
    const h = harness([
      raw("SSX-1", {
        status: { id: "3", name: "In Code Review", statusCategory: { key: "indeterminate" } },
      }),
    ]);
    const { facts } = await collectFacts(h.deps, settings, 7);
    expect(facts.issues[0]?.statusNote).toBe(
      "Jira shows In Code Review although the issue was resolved 2026-11-10 12:00.",
    );
  });

  it("reads a link from either end, and marks one open unless its other end is done", async () => {
    const h = harness([
      raw("SSX-1", {
        issuelinks: [
          {
            type: { name: "Relates", inward: "relates to", outward: "relates to" },
            outwardIssue: {
              key: "SSX-5",
              fields: { status: { statusCategory: { key: "indeterminate" } } },
            },
          },
          {
            type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
            inwardIssue: { key: "IT-6", fields: { status: { statusCategory: { key: "done" } } } },
          },
        ],
      }),
    ]);
    const { facts } = await collectFacts(h.deps, settings, 7);
    expect(facts.issues[0]?.links).toEqual([
      { key: "SSX-5", label: "relates to", open: true },
      { key: "IT-6", label: "is blocked by", open: false },
    ]);
    expect(facts.keyPrefixes).toEqual(["SSX", "IT"]);
  });

  it("does not count a pull request that merely mentions the issue, and lists it as not counted", async () => {
    const h = harness([raw("SSX-1")], {
      "SSX-1": [pr({ number: 5 }), pr({ number: 6, title: "feat(SSX-9): other" })],
    });
    const { facts } = await collectFacts(h.deps, settings, 7);
    expect(facts.issues[0]?.prs.map((p) => p.number)).toEqual([5]);
    expect(facts.issues[0]?.others).toEqual([
      { repo: "advisor-web", number: 6, why: "mentions the issue without being named for it" },
    ]);
  });

  it("finds a pull request only its branch names, looking back past the window and listing each repository once", async () => {
    const branchOnly = pr({
      number: 9,
      title: "feat(advisorsupport): move button",
      branch: "ssx-2-move-button",
      body: "Flytt en knapp",
    });
    const h = harness([raw("SSX-2"), raw("SSX-3")], {}, [branchOnly]);
    const { facts } = await collectFacts(h.deps, settings, 7);

    expect(facts.issues.find((i) => i.key === "SSX-2")?.prs).toMatchObject([
      { number: 9, body: "Flytt en knapp" },
    ]);
    expect(facts.issues.find((i) => i.key === "SSX-3")?.prs).toEqual([]);
    // Two issues both needed the fallback, but each repository is listed once.
    expect(h.mergedSince.mock.calls.map((c) => c[0]).toSorted()).toEqual([
      "buy-insurance-advisor-web",
      "insurance-commerce-rest-api",
    ]);
    expect(h.mergedSince.mock.calls[0]?.[1]).toBe("2026-10-22");
  });

  it("does not run the branch search when the ordinary search already found the change", async () => {
    const h = harness([raw("SSX-1")], { "SSX-1": [pr({ number: 5 })] });
    await collectFacts(h.deps, settings, 7);
    expect(h.mergedSince).not.toHaveBeenCalled();
  });

  it("gives a repository nobody configured a filter chip, as a service", async () => {
    const h = harness([raw("SSX-1")], { "SSX-1": [pr({ number: 5, repo: "other-repo" })] });
    const { facts } = await collectFacts(h.deps, settings, 7);
    expect(facts.repos.map((r) => [r.name, r.kind])).toEqual([
      ["advisor-web", "web"],
      ["commerce-rest", "service"],
      ["other-repo", "service"],
    ]);
  });

  it("reads a payload with fields missing as unknown rather than throwing", async () => {
    const h = harness([
      {
        id: "1",
        key: "SSX-1",
        fields: { resolutiondate: "2026-11-10T12:00:00.000+0100", resolution: { name: "Solved" } },
      } as unknown as JiraIssue,
    ]);
    const { facts } = await collectFacts(h.deps, settings, 7);
    expect(facts.issues[0]).toMatchObject({
      summary: "SSX-1",
      kind: "other",
      reporter: null,
      parent: null,
      statusNote: "Jira shows unknown although the issue was resolved 2026-11-10 12:00.",
    });
  });
});
