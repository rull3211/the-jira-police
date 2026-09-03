import { describe, expect, it } from "vitest";

import { JqlError, assertSafe, buildNewIssuesJql, jqlValue, lookbackMinutes } from "./jql.ts";

const NOW = new Date("2026-09-02T12:00:00Z");

const BASE = {
  project: "SSX",
  components: [] as readonly string[],
  excludedTypeIds: ["10009"],
  cursor: null,
  now: NOW,
  overlapMs: 120_000,
  firstRunMinutes: 60,
};

describe("assertSafe", () => {
  it("accepts ordinary keys and ids", () => {
    expect(assertSafe("SSX", "project")).toBe("SSX");
    expect(assertSafe("10009", "issue type id")).toBe("10009");
  });

  it.each([
    'SSX" OR "1"="1',
    "SSX ORDER BY created",
    "SSX)",
    "SSX AND assignee = currentUser()",
    "",
    "SSX;",
  ])("rejects %j, since JQL has no parameter binding", (value) => {
    expect(() => assertSafe(value, "project")).toThrow(JqlError);
  });
});

describe("lookbackMinutes", () => {
  it("uses the first-run window when there is no cursor", () => {
    expect(lookbackMinutes({ ...BASE, cursor: null })).toBe(60);
  });

  it("spans the gap since the cursor plus the overlap", () => {
    // 10 minutes elapsed + 2 minutes overlap.
    expect(lookbackMinutes({ ...BASE, cursor: "2026-09-02T11:50:00Z" })).toBe(12);
  });

  it("rounds up, so the cursor's own minute stays inside the window", () => {
    // 30s elapsed + 120s overlap = 2.5 min, which must not truncate to 2.
    expect(lookbackMinutes({ ...BASE, cursor: "2026-09-02T11:59:30Z" })).toBe(3);
  });

  it("never returns less than a minute", () => {
    expect(lookbackMinutes({ ...BASE, cursor: "2026-09-02T12:00:00Z", overlapMs: 0 })).toBe(1);
  });

  it("tolerates a cursor in the future without going negative", () => {
    expect(lookbackMinutes({ ...BASE, cursor: "2026-09-02T13:00:00Z", overlapMs: 0 })).toBe(1);
  });

  it("rejects an unparseable cursor rather than querying nonsense", () => {
    expect(() => lookbackMinutes({ ...BASE, cursor: "not-a-date" })).toThrow(JqlError);
  });
});

describe("buildNewIssuesJql", () => {
  it("builds the expected query", () => {
    expect(buildNewIssuesJql(BASE)).toBe(
      "project = SSX AND created >= -60m AND issuetype NOT IN (10009) ORDER BY created ASC",
    );
  });

  it("uses a relative offset, never an absolute date", () => {
    // Absolute dates in JQL resolve in the server's timezone, not ours.
    const jql = buildNewIssuesJql({ ...BASE, cursor: "2026-09-02T11:00:00Z" });
    expect(jql).toContain("created >= -62m");
    expect(jql).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("omits the exclusion clause when nothing is excluded", () => {
    expect(buildNewIssuesJql({ ...BASE, excludedTypeIds: [] })).toBe(
      "project = SSX AND created >= -60m ORDER BY created ASC",
    );
  });

  it("excludes several issue types", () => {
    expect(buildNewIssuesJql({ ...BASE, excludedTypeIds: ["10009", "10000"] })).toContain(
      "issuetype NOT IN (10009, 10000)",
    );
  });

  it("orders oldest first so the cursor can advance monotonically", () => {
    expect(buildNewIssuesJql(BASE)).toMatch(/ORDER BY created ASC$/);
  });

  it("refuses to interpolate an unsafe project", () => {
    expect(() => buildNewIssuesJql({ ...BASE, project: 'X" OR "1"="1' })).toThrow(JqlError);
  });

  it("refuses to interpolate an unsafe issue type id", () => {
    expect(() => buildNewIssuesJql({ ...BASE, excludedTypeIds: ["1) OR true --"] })).toThrow(
      JqlError,
    );
  });
});

/**
 * The SSX board is shared by several teams. Without this clause the service
 * triages — and pays for — every other team's tickets.
 */
describe("jqlValue", () => {
  it("quotes a name, because real component names contain spaces", () => {
    expect(jqlValue("SSX Advisor", "component")).toBe('"SSX Advisor"');
  });

  it("leaves an id bare, because Jira looks up quoted values by name", () => {
    // `component = "12644"` searches for a component *named* 12644 and finds
    // nothing, so the quoting is what selects id- versus name-lookup.
    expect(jqlValue("12644", "component")).toBe("12644");
  });

  it("trims, so a comma-separated setting does not become a leading space", () => {
    expect(jqlValue("  SSX Advisor  ", "component")).toBe('"SSX Advisor"');
  });

  it.each(['SSX" OR project = FOO', "SSX\\", "SSX'", "SSX\nOR", ""])(
    "rejects %j rather than escaping it",
    (value) => {
      expect(() => jqlValue(value, "component")).toThrow(JqlError);
    },
  );
});

describe("buildNewIssuesJql component filter", () => {
  it("restricts to a single named component", () => {
    expect(buildNewIssuesJql({ ...BASE, components: ["SSX Advisor"] })).toBe(
      'project = SSX AND created >= -60m AND component IN ("SSX Advisor") AND issuetype NOT IN (10009) ORDER BY created ASC',
    );
  });

  it("accepts ids and names side by side", () => {
    expect(buildNewIssuesJql({ ...BASE, components: ["12644", "SSX Nettsalg"] })).toContain(
      'component IN (12644, "SSX Nettsalg")',
    );
  });

  it("omits the clause entirely when no component is configured", () => {
    expect(buildNewIssuesJql({ ...BASE, components: [] })).not.toContain("component");
  });

  it("refuses to interpolate an unsafe component", () => {
    expect(() => buildNewIssuesJql({ ...BASE, components: ['x") OR project = FOO ("'] })).toThrow(
      JqlError,
    );
  });
});
