import { describe, expect, it } from "vitest";

import type { SolveMode } from "../settings.ts";
import {
  JqlError,
  assertSafe,
  buildNewIssuesJql,
  buildInFlightJql,
  buildSolveQueueJql,
  jqlValue,
  lookbackMinutes,
} from "./jql.ts";

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

/**
 * The second queue. Selects on label state and nothing else — no cursor, no
 * window — because a ticket labelled for solving months after it was triaged
 * still has to be picked up.
 */
describe("buildSolveQueueJql", () => {
  const QUEUE = {
    project: "SSX",
    components: ["SSX Advisor"],
    mode: "manual" as SolveMode,
    autoIssueTypes: ["Feil"],
  };

  it("builds the manual-mode query verbatim", () => {
    expect(buildSolveQueueJql(QUEUE)).toBe(
      'project = SSX AND component IN ("SSX Advisor") AND statusCategory != Done ' +
        'AND labels = "agent:solvable" AND labels = "agent:start" ' +
        'AND labels NOT IN ("agent:solving", "agent:done", "agent:failed") ORDER BY updated ASC',
    );
  });

  it("builds the auto-mode query verbatim: no start clause, but an issuetype one", () => {
    // Auto is not manual-minus-a-check. It trades the human's label for a type
    // restriction, so the query is the same length and differs in what it asks.
    expect(buildSolveQueueJql({ ...QUEUE, mode: "auto" })).toBe(
      'project = SSX AND component IN ("SSX Advisor") AND statusCategory != Done ' +
        'AND labels = "agent:solvable" AND issuetype IN ("Feil") ' +
        'AND labels NOT IN ("agent:solving", "agent:done", "agent:failed") ORDER BY updated ASC',
    );
  });

  it("restricts unattended solving to the configured issue types", () => {
    expect(buildSolveQueueJql({ ...QUEUE, mode: "auto" })).toContain('issuetype IN ("Feil")');
  });

  it("refuses to build an auto query with no issue-type restriction", () => {
    // The dangerous reading of an empty list is "every type", and this is the
    // only path that changes code with nobody watching. Refusing is louder than
    // allowing nothing, and the silent-no-op is the bug this clause exists for.
    expect(() => buildSolveQueueJql({ ...QUEUE, mode: "auto", autoIssueTypes: [] })).toThrow(
      JqlError,
    );
  });

  it("does not restrict issue type in manual mode, even with the list set", () => {
    // A human typing agent:start on an Epic has said something this list could
    // only second-guess.
    expect(buildSolveQueueJql(QUEUE)).not.toContain("issuetype");
  });

  it("ignores an empty issue-type list in manual mode rather than throwing", () => {
    expect(() =>
      buildSolveQueueJql({ ...QUEUE, mode: "manual", autoIssueTypes: [] }),
    ).not.toThrow();
  });

  it("resolves a numeric issue type as an id and a name as a name", () => {
    // Same rule as components: `issuetype IN (10004)` is an id lookup, while
    // `issuetype IN ("10004")` searches for a type *named* 10004 and finds
    // nothing. Ids are what survive a rename of "Feil".
    expect(buildSolveQueueJql({ ...QUEUE, mode: "auto", autoIssueTypes: ["10004"] })).toContain(
      "issuetype IN (10004)",
    );
    expect(
      buildSolveQueueJql({ ...QUEUE, mode: "auto", autoIssueTypes: ["Feil", "10004"] }),
    ).toContain('issuetype IN ("Feil", 10004)');
  });

  it("rejects an injection attempt through the issue-type list", () => {
    expect(() =>
      buildSolveQueueJql({
        ...QUEUE,
        mode: "auto",
        autoIssueTypes: ['x") OR labels = "agent:solvable'],
      }),
    ).toThrow(JqlError);
  });

  it("requires the human go-ahead in manual mode", () => {
    // The single human step in the whole feature.
    expect(buildSolveQueueJql(QUEUE)).toContain('labels = "agent:start"');
  });

  it("drops the go-ahead clause only for auto", () => {
    expect(buildSolveQueueJql({ ...QUEUE, mode: "auto" })).not.toContain("agent:start");
  });

  it("treats an unrecognised mode as manual rather than as auto", () => {
    // `solveMode` is the only validator, and it throws — but nothing stops a
    // future caller from reading the mode off something else. The clause is
    // written as "not auto" precisely so that a value which never passed
    // validation still lands on the side that waits for a person.
    const rogue = buildSolveQueueJql({ ...QUEUE, mode: "AUTO" as SolveMode });
    expect(rogue).toContain('labels = "agent:start"');
  });

  it("excludes the claim and both terminal labels", () => {
    // The exclusion is the entire dedupe mechanism: there is no seenKeys list
    // and no cursor behind this query.
    expect(buildSolveQueueJql(QUEUE)).toContain(
      'labels NOT IN ("agent:solving", "agent:done", "agent:failed")',
    );
  });

  it("keeps a positive label clause, which is what makes NOT IN safe", () => {
    // `labels NOT IN (...)` also excludes issues whose labels field is empty.
    // Harmless only while every candidate is guaranteed at least one label.
    const jql = buildSolveQueueJql(QUEUE);
    expect(jql.indexOf('labels = "agent:solvable"')).toBeLessThan(jql.indexOf("labels NOT IN"));
  });

  it("has no time or cursor clause at all", () => {
    // The defining difference from the new-issue query. A relative window here
    // would drop a ticket a human labels a week after it was triaged.
    const jql = buildSolveQueueJql(QUEUE);
    expect(jql).not.toContain("created");
    expect(jql).not.toMatch(/-\d+m/);
    expect(jql).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("skips closed tickets, which no cursor would ever carry out of range", () => {
    expect(buildSolveQueueJql(QUEUE)).toContain("statusCategory != Done");
  });

  it("orders oldest touched first, so a backlog drains fairly", () => {
    expect(buildSolveQueueJql(QUEUE)).toMatch(/ORDER BY updated ASC$/);
  });

  it("omits the component clause when nothing is configured", () => {
    expect(buildSolveQueueJql({ ...QUEUE, components: [] })).not.toContain("component");
  });

  it("accepts a component id bare and a component name quoted", () => {
    expect(buildSolveQueueJql({ ...QUEUE, components: ["12644", "SSX Nettsalg"] })).toContain(
      'component IN (12644, "SSX Nettsalg")',
    );
  });

  it("refuses to interpolate an unsafe project", () => {
    expect(() => buildSolveQueueJql({ ...QUEUE, project: 'X" OR "1"="1' })).toThrow(JqlError);
  });

  it("refuses to interpolate an unsafe component", () => {
    expect(() => buildSolveQueueJql({ ...QUEUE, components: ['x") OR labels = "y'] })).toThrow(
      JqlError,
    );
  });
});

/**
 * The concurrency bound's other half.
 *
 * Everything here is about one asymmetry: this query may over-count freely and
 * must never under-count, because an undercount is what lets a second claim
 * through a limit of one.
 */
describe("buildInFlightJql", () => {
  const SCOPE = { project: "SSX", components: ["SSX Advisor"] };

  it("builds the query verbatim", () => {
    expect(buildInFlightJql(SCOPE)).toBe(
      'project = SSX AND component IN ("SSX Advisor") AND labels = "agent:solving"',
    );
  });

  it("counts exactly the tickets the solve queue excludes", () => {
    // The two queries have to disagree on this label and agree on nothing else,
    // or the bound is computed from the wrong population. A claimed ticket is
    // absent from the queue and present here; that is the whole mechanism.
    expect(buildInFlightJql(SCOPE)).toContain('labels = "agent:solving"');
    expect(
      buildSolveQueueJql({ ...SCOPE, mode: "manual" as SolveMode, autoIssueTypes: ["Feil"] }),
    ).toContain('labels NOT IN ("agent:solving"');
  });

  it("counts a claimed ticket even after someone closes it", () => {
    // The deliberate divergence from the queue query. A solve whose ticket was
    // closed mid-run is still running; filtering it out here would undercount,
    // and undercounting a limit of one means two agents in the same repository.
    expect(buildInFlightJql(SCOPE)).not.toContain("statusCategory");
  });

  it("has no ordering clause, because a count does not need one", () => {
    expect(buildInFlightJql(SCOPE)).not.toContain("ORDER BY");
  });

  it("stays inside the same scope the queue claims within", () => {
    // Not widened to the whole project. This poller only ever writes the claim
    // inside its component scope, so a stray agent:solving elsewhere is not its
    // work — and blocking on it forever would be a stall with no findable cause.
    expect(buildInFlightJql(SCOPE)).toContain('component IN ("SSX Advisor")');
  });

  it("omits the component clause when nothing is configured", () => {
    expect(buildInFlightJql({ ...SCOPE, components: [] })).not.toContain("component");
  });

  it("refuses to interpolate an unsafe project", () => {
    expect(() => buildInFlightJql({ ...SCOPE, project: 'X" OR "1"="1' })).toThrow(JqlError);
  });

  it("refuses to interpolate an unsafe component", () => {
    expect(() => buildInFlightJql({ ...SCOPE, components: ['x") OR labels = "y'] })).toThrow(
      JqlError,
    );
  });
});
