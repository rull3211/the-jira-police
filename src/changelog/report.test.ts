import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ChangelogGateError, assertReportable } from "./gate.ts";
import { mechanicalProse } from "./mechanical.ts";
import { buildReport, formatRange, renderReport, safeJson } from "./render.ts";
import { LIMITS, type Facts, type IssueFacts, type Prose } from "./types.ts";

const issue = (key: string, over: Partial<IssueFacts> = {}): IssueFacts => ({
  key,
  kind: "task",
  summary: `Summary of ${key}`,
  resolved: "2026-11-10T12:00:00.000+0100",
  reporter: "Ada",
  parent: null,
  links: [],
  statusNote: null,
  description: "First sentence of the description. Second sentence.\n\nA second paragraph.",
  comments: [],
  prs: [
    {
      repo: "advisor-web",
      number: 1,
      title: "t",
      body: "",
      additions: 3,
      deletions: 1,
      merged: "10 Nov",
      flags: [],
    },
  ],
  others: [],
  ...over,
});

const facts = (issues: readonly IssueFacts[], over: Partial<Facts> = {}): Facts => ({
  generated: "2026-11-12",
  window: { start: "2026-11-05", end: "2026-11-12", days: 7 },
  scope: { label: "SSX Advisor", summary: "component SSX Advisor.", jql: "project = SSX" },
  jiraBase: "https://example.atlassian.net/browse/",
  githubBase: "https://github.com/acme/",
  keyPrefixes: ["SSX"],
  repos: [
    { name: "advisor-web", full: "buy-insurance-advisor-web", kind: "web" },
    { name: "commerce-rest", full: "insurance-commerce-rest-api", kind: "service" },
  ],
  issues,
  excluded: [],
  ...over,
});

const prose = (keys: readonly string[]): Prose => ({
  themes: [{ id: "a", label: "A" }],
  entries: keys.map((key) => ({
    key,
    theme: "a",
    title: `Title ${key}`,
    what: "w",
    why: "",
    notes: [],
  })),
  callouts: [],
});

const problemsOf = (run: () => void): readonly string[] => {
  try {
    run();
  } catch (error) {
    if (error instanceof ChangelogGateError) {
      return error.problems;
    }
    throw error;
  }
  return [];
};

describe("assertReportable", () => {
  it("passes when the report holds exactly the issues the query returned, each with prose", () => {
    expect(
      problemsOf(() =>
        assertReportable(facts([issue("SSX-1"), issue("SSX-2")]), prose(["SSX-1", "SSX-2"]), [
          "SSX-1",
          "SSX-2",
        ]),
      ),
    ).toEqual([]);
  });

  it("accepts an excluded issue as accounted for, with no prose", () => {
    const f = facts([issue("SSX-1")], {
      excluded: [{ key: "SSX-9", reason: "resolution Duplikat" }],
    });
    expect(problemsOf(() => assertReportable(f, prose(["SSX-1"]), ["SSX-1", "SSX-9"]))).toEqual([]);
  });

  it("refuses an issue the query returned that the report neither counts nor excludes", () => {
    // The silent drop: a classifier that skips a row would otherwise make the report shorter than Jira.
    const problems = problemsOf(() =>
      assertReportable(facts([issue("SSX-1")]), prose(["SSX-1"]), ["SSX-1", "SSX-2"]),
    );
    expect(problems).toEqual([
      "SSX-2 was returned by the query and is neither counted nor excluded",
    ]);
  });

  it("refuses an issue in the report that the query did not return", () => {
    const problems = problemsOf(() =>
      assertReportable(facts([issue("SSX-1"), issue("SSX-7")]), prose(["SSX-1", "SSX-7"]), [
        "SSX-1",
      ]),
    );
    expect(problems).toEqual(["SSX-7 is in the report and was not returned by the query"]);
  });

  it("refuses a duplicated issue wherever the duplicate is", () => {
    expect(
      problemsOf(() =>
        assertReportable(facts([issue("SSX-1"), issue("SSX-1")]), prose(["SSX-1"]), ["SSX-1"]),
      ),
    ).toContain("SSX-1 is in the report twice");
    expect(
      problemsOf(() =>
        assertReportable(facts([issue("SSX-1")]), prose(["SSX-1"]), ["SSX-1", "SSX-1"]),
      ),
    ).toContain("SSX-1 was returned twice by the query");
  });

  it("refuses an issue resolved outside the window", () => {
    const f = facts([issue("SSX-1", { resolved: "2026-11-04T23:59:00.000+0100" })]);
    expect(problemsOf(() => assertReportable(f, prose(["SSX-1"]), ["SSX-1"]))).toEqual([
      "SSX-1 was resolved on 2026-11-04, outside 2026-11-05 to 2026-11-12",
    ]);
  });

  it("refuses prose that is missing, extra or twice", () => {
    const f = facts([issue("SSX-1"), issue("SSX-2")]);
    expect(problemsOf(() => assertReportable(f, prose(["SSX-1"]), ["SSX-1", "SSX-2"]))).toEqual([
      "no prose for SSX-2",
    ]);
    expect(
      problemsOf(() => assertReportable(f, prose(["SSX-1", "SSX-2", "SSX-3"]), ["SSX-1", "SSX-2"])),
    ).toEqual(["prose for SSX-3, which is not a counted issue"]);
    expect(
      problemsOf(() => assertReportable(f, prose(["SSX-1", "SSX-2", "SSX-2"]), ["SSX-1", "SSX-2"])),
    ).toEqual(["prose for SSX-2 appears twice"]);
  });

  it("refuses prose for an excluded issue, which the report does not show", () => {
    const f = facts([issue("SSX-1")], { excluded: [{ key: "SSX-9", reason: "x" }] });
    expect(
      problemsOf(() => assertReportable(f, prose(["SSX-1", "SSX-9"]), ["SSX-1", "SSX-9"])),
    ).toEqual(["prose for SSX-9, which is not a counted issue"]);
  });

  it("refuses an undeclared theme, too many themes, and an empty title", () => {
    const f = facts([issue("SSX-1")]);
    const bad: Prose = {
      ...prose(["SSX-1"]),
      entries: [{ key: "SSX-1", theme: "nope", title: " ", what: "", why: "", notes: [] }],
    };
    expect(problemsOf(() => assertReportable(f, bad, ["SSX-1"]))).toEqual([
      'SSX-1 names theme "nope", which is not declared',
      "SSX-1 has no title",
    ]);
    const many: Prose = {
      ...prose(["SSX-1"]),
      themes: ["a", "b", "c", "d", "e"].map((id) => ({ id, label: id })),
    };
    expect(problemsOf(() => assertReportable(f, many, ["SSX-1"]))).toEqual([
      "5 themes, at most 4 have a colour",
    ]);
  });

  it("reports every problem at once and says how many", () => {
    const error = (() => {
      try {
        assertReportable(facts([issue("SSX-1")]), prose([]), ["SSX-1", "SSX-2"]);
      } catch (e) {
        return e as ChangelogGateError;
      }
      return null;
    })();
    expect(error?.problems).toHaveLength(2);
    expect(error?.message).toMatch(/^the changelog was not rendered, 2 problem\(s\): /u);
  });
});

describe("mechanicalProse", () => {
  it("files an issue under Web apps when a web app changed, and the rest under services", () => {
    const service = issue("SSX-2", {
      prs: [
        {
          repo: "commerce-rest",
          number: 2,
          title: "t",
          body: "",
          additions: 1,
          deletions: 1,
          merged: "10 Nov",
          flags: [],
        },
      ],
    });
    const out = mechanicalProse(facts([issue("SSX-1"), service]));
    expect(out.themes.map((t) => t.label)).toEqual(["Web apps", "Services and other"]);
    expect(out.entries.map((e) => [e.key, e.theme])).toEqual([
      ["SSX-1", "web"],
      ["SSX-2", "other"],
    ]);
  });

  it("declares only the themes that are used", () => {
    expect(mechanicalProse(facts([issue("SSX-1")])).themes.map((t) => t.id)).toEqual(["web"]);
    expect(mechanicalProse(facts([issue("SSX-1", { prs: [] })])).themes.map((t) => t.id)).toEqual([
      "other",
    ]);
  });

  it("uses Jira's summary cut to the title limit as the title", () => {
    const entry = mechanicalProse(facts([issue("SSX-1", { summary: "word ".repeat(60) })]))
      .entries[0];
    expect(entry?.title.length).toBeLessThanOrEqual(LIMITS.title + 1);
    expect(entry?.title.endsWith("…")).toBe(true);
  });

  it("takes the line under the title from the first paragraph of the description only", () => {
    const entry = mechanicalProse(facts([issue("SSX-1")])).entries[0];
    expect(entry?.what).toBe("First sentence of the description. Second sentence.");
  });

  it("ends a long first paragraph at a sentence and marks the cut, inside the limit", () => {
    const sentence = `${"word ".repeat(30).trim()}. `;
    const entry = mechanicalProse(facts([issue("SSX-1", { description: sentence.repeat(6) })]))
      .entries[0];
    expect(entry?.what.length).toBeLessThanOrEqual(LIMITS.what + 2);
    expect(entry?.what.endsWith(". …")).toBe(true);
  });

  it("is itself reportable", () => {
    const f = facts([issue("SSX-1"), issue("SSX-2", { prs: [] })]);
    expect(problemsOf(() => assertReportable(f, mechanicalProse(f), ["SSX-1", "SSX-2"]))).toEqual(
      [],
    );
  });
});

describe("safeJson", () => {
  it("escapes what could end the script element or split a line, and nothing else", () => {
    expect(safeJson("a b")).toBe('"a b"');
    expect(safeJson("</script><!--")).toBe('"\\u003c/script>\\u003c!--"');
    expect(safeJson("x\u2028y\u2029z")).toBe('"x\\u2028y\\u2029z"');
  });
});

describe("formatRange", () => {
  it("writes the range the way a reader says it", () => {
    expect(formatRange("2026-11-05", "2026-11-12")).toBe("5–12 Nov 2026");
    expect(formatRange("2026-10-30", "2026-11-05")).toBe("30 Oct–5 Nov 2026");
    expect(formatRange("2025-12-28", "2026-01-03")).toBe("28 Dec 2025–3 Jan 2026");
  });
});

describe("renderReport", () => {
  const template = "<script>const REPORT = /*__REPORT_JSON__*/ null;</script>";

  it("puts the report where the placeholder was, once", () => {
    const html = renderReport(template, facts([issue("SSX-1")]), prose(["SSX-1"]));
    expect(html.startsWith("<script>const REPORT = {")).toBe(true);
    expect(html).not.toContain("__REPORT_JSON__");
  });

  it("cannot be broken out of by text in a title", () => {
    const p = prose(["SSX-1"]);
    const hostile: Prose = {
      ...p,
      entries: [{ ...p.entries[0]!, title: "</script><script>alert(1)</script>" }],
    };
    const html = renderReport(template, facts([issue("SSX-1")]), hostile);
    expect(html).not.toContain("<script>alert(1)");
    expect(html.match(/<\/script>/gu)).toHaveLength(1);
  });

  it("keeps a dollar pattern in the report as text", () => {
    const p = prose(["SSX-1"]);
    const html = renderReport(template, facts([issue("SSX-1")]), {
      ...p,
      entries: [{ ...p.entries[0]!, title: "costs $& and $1" }],
    });
    expect(html).toContain("costs $& and $1");
  });

  it("refuses a template with no placeholder or two", () => {
    expect(() => renderReport("<html>", facts([]), prose([]))).toThrow(/exactly once/u);
    expect(() => renderReport(`${template}${template}`, facts([]), prose([]))).toThrow(
      /exactly once/u,
    );
  });
});

describe("the page template", () => {
  // The tests above use a stand-in, which cannot notice the real file losing its placeholder.
  const real = readFileSync(
    new URL("../../.claude/skills/changelog/template.html", import.meta.url),
    "utf8",
  );

  it("holds the placeholder exactly once and renders with it", () => {
    const html = renderReport(real, facts([issue("SSX-1")]), prose(["SSX-1"]));
    expect(html).toContain('"key":"SSX-1"');
    expect(html).not.toContain("__REPORT_JSON__");
  });

  it("reads every field the report builds, so a renamed one is caught here", () => {
    const report = buildReport(facts([issue("SSX-1")]), prose(["SSX-1"]));
    const entry = (report["entries"] as Record<string, unknown>[])[0] ?? {};
    for (const field of Object.keys(report)) {
      expect(real, `REPORT.${field}`).toContain(`REPORT.${field}`);
    }
    for (const field of Object.keys(entry)) {
      expect(real, `entry.${field}`).toMatch(new RegExp(`\\be\\.${field}\\b`, "u"));
    }
  });
});

describe("buildReport", () => {
  it("joins prose to facts by key and keeps the facts' own numbers", () => {
    const f = facts([issue("SSX-1", { kind: "bug" })]);
    const report = buildReport(f, prose(["SSX-1"])) as {
      entries: { key: string; type: string; title: string; prs: { n: number; add: number }[] }[];
    };
    expect(report.entries[0]).toMatchObject({
      key: "SSX-1",
      type: "bug",
      title: "Title SSX-1",
      prs: [{ n: 1, add: 3 }],
    });
  });

  it("computes its notices from the facts: excluded, stale status, open links and no pull request", () => {
    const f = facts(
      [
        issue("SSX-1", {
          statusNote: "Jira shows In Code Review.",
          links: [
            { key: "SSX-5", label: "Relates", open: true },
            { key: "SSX-6", label: "Relates", open: false },
          ],
        }),
        issue("SSX-2", { prs: [] }),
      ],
      { excluded: [{ key: "SSX-9", reason: "resolution Duplikat" }] },
    );
    const notices = (
      buildReport(f, prose(["SSX-1", "SSX-2"])) as { notices: { title: string; text: string }[] }
    ).notices;
    expect(notices.map((n) => n.title)).toEqual([
      "Resolved but not counted",
      "Status and resolution disagree",
      "Linked work still open",
      "No merged pull request found",
    ]);
    expect(notices[2]?.text).toBe("SSX-5 (linked from SSX-1)");
    expect(notices[3]?.text).toBe("SSX-2");
  });

  it("has no notices when there is nothing to say", () => {
    expect(
      (buildReport(facts([issue("SSX-1")]), prose(["SSX-1"])) as { notices: unknown[] }).notices,
    ).toEqual([]);
  });
});
