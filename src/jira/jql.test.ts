import { describe, expect, it } from "vitest";

import type { SolveMode } from "../settings.ts";
import {
  JqlError,
  assertSafe,
  buildNewIssuesJql,
  buildInFlightJql,
  buildReviewQueueJql,
  buildSendbackWatchJql,
  buildSolveQueueJql,
  jqlValue,
  lookbackMinutes,
} from "./jql.ts";

const NOW = new Date("2026-09-02T12:00:00Z");

const BASE = {
  project: "SSX",
  components: [] as readonly string[],
  statuses: [] as readonly string[],
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
      "project = SSX AND created >= -60m AND statusCategory != Done AND issuetype NOT IN (10009) ORDER BY created ASC",
    );
  });

  it("skips closed tickets, which a paid triage has nothing to say about", () => {
    // SSX-3859 was closed and inside the window, and bought a model run.
    expect(buildNewIssuesJql(BASE)).toContain("statusCategory != Done");
  });

  it("filters closed on the category, never on the status name", () => {
    // Status names are per-board and Norwegian on this one, so `status = "Done"`
    // is a clause that matches nothing. Same rule as `src/watch/signals.ts`.
    expect(buildNewIssuesJql(BASE)).not.toMatch(/status\s*!?=\s*"?Done"?/);
  });

  it("restricts discovery to the configured statuses", () => {
    // The operator watched triage fire on tickets in code review and in test.
    const jql = buildNewIssuesJql({
      ...BASE,
      statuses: ["Mottatt", "Backlog", "On Hold", "In Progress Concept"],
    });
    expect(jql).toContain('status IN ("Mottatt", "Backlog", "On Hold", "In Progress Concept")');
  });

  it("drops the closed-category clause when an allowlist is set", () => {
    // Not a saving. Both clauses together would silently defeat an allowlist
    // naming a closed status — two clauses that agree until someone configures
    // the setting they exist to configure.
    const jql = buildNewIssuesJql({ ...BASE, statuses: ["Ferdig"] });
    expect(jql).not.toContain("statusCategory");
  });

  it("keeps filtering closed tickets when no allowlist is set", () => {
    // Blank is "anything not closed", so removing the else branch has to fail.
    expect(buildNewIssuesJql({ ...BASE, statuses: [] })).toContain("statusCategory != Done");
  });

  it("cannot be expressed as a status category, which is why it names statuses", () => {
    // Measured against SSX on 2026-09-10: `In Progress Concept` is
    // `indeterminate` and is wanted; `Prioritized` is `new` and is not. The
    // eligible set straddles the taxonomy, so `statusCategory = new` — the
    // one-clause version this nearly shipped as — is wrong in both directions.
    const jql = buildNewIssuesJql({ ...BASE, statuses: ["Mottatt", "In Progress Concept"] });
    expect(jql).toContain('"In Progress Concept"');
    expect(jql).not.toContain("statusCategory = new");
  });

  it("quotes status names but resolves a bare number as an id", () => {
    // Same rule as components: ids survive a rename, names are legible in a
    // config file, and the quoting is what decides which Jira looks up.
    const jql = buildNewIssuesJql({ ...BASE, statuses: ["On Hold", "10213"] });
    expect(jql).toContain('status IN ("On Hold", 10213)');
  });

  it("rejects a status that would break out of its JQL literal", () => {
    // JQL has no parameter binding, so this is rejected rather than escaped.
    expect(() => buildNewIssuesJql({ ...BASE, statuses: ['Mottatt") OR ("x'] })).toThrow(JqlError);
  });

  it("uses a relative offset, never an absolute date", () => {
    // Absolute dates in JQL resolve in the server's timezone, not ours.
    const jql = buildNewIssuesJql({ ...BASE, cursor: "2026-09-02T11:00:00Z" });
    expect(jql).toContain("created >= -62m");
    expect(jql).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("omits the exclusion clause when nothing is excluded", () => {
    expect(buildNewIssuesJql({ ...BASE, excludedTypeIds: [] })).toBe(
      "project = SSX AND created >= -60m AND statusCategory != Done ORDER BY created ASC",
    );
  });

  it("excludes several issue types", () => {
    expect(buildNewIssuesJql({ ...BASE, excludedTypeIds: ["10009", "10000"] })).toContain(
      "issuetype NOT IN (10009, 10000)",
    );
  });

  it("orders oldest first so a truncated search loses the newest, not the oldest", () => {
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
      'project = SSX AND created >= -60m AND statusCategory != Done AND component IN ("SSX Advisor") AND issuetype NOT IN (10009) ORDER BY created ASC',
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
        'AND labels NOT IN ("agent:solving", "agent:reviewing", "agent:review-done", ' +
        '"agent:done", "agent:closed", "agent:failed") ORDER BY updated ASC',
    );
  });

  it("builds the auto-mode query verbatim: no start clause, but an issuetype one", () => {
    // Auto is not manual-minus-a-check. It trades the human's label for a type
    // restriction, so the query is the same length and differs in what it asks.
    expect(buildSolveQueueJql({ ...QUEUE, mode: "auto" })).toBe(
      'project = SSX AND component IN ("SSX Advisor") AND statusCategory != Done ' +
        'AND labels = "agent:solvable" AND issuetype IN ("Feil") ' +
        'AND labels NOT IN ("agent:solving", "agent:reviewing", "agent:review-done", ' +
        '"agent:done", "agent:closed", "agent:failed") ORDER BY updated ASC',
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

  it("excludes every state the machine can be in but the two it starts from", () => {
    // The exclusion is the entire dedupe mechanism: there is no seenKeys list
    // and no cursor behind this query.
    expect(buildSolveQueueJql(QUEUE)).toContain(
      'labels NOT IN ("agent:solving", "agent:reviewing", "agent:review-done", ' +
        '"agent:done", "agent:closed", "agent:failed")',
    );
  });

  it("excludes the two states a pull request sits in, which the claim no longer covers", () => {
    // The mutation this pins is dropping either review label from
    // SOLVE_QUEUE_EXCLUDED_LABELS. Until D4 a ticket under review still carried
    // agent:solving and was excluded by that; it does not, so these two are now
    // the only thing standing between an open pull request and a second solve of
    // the same ticket. agent:review-done is the one that matters most: it is
    // where a ticket waits for a human, which is measured in days.
    const jql = buildSolveQueueJql(QUEUE);
    expect(jql).toContain('"agent:reviewing"');
    expect(jql).toContain('"agent:review-done"');
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

/**
 * The set the review cycle looks at.
 *
 * Every test here is about the same mistake in a different shape: watching one
 * of the two labels, or excluding a ticket that still has an open pull request.
 * Both leave a pull request the loop opened with nothing that will ever look at
 * it again.
 */
describe("buildReviewQueueJql", () => {
  const SCOPE = { project: "SSX", components: ["SSX Advisor"] };

  it("builds the query verbatim", () => {
    expect(buildReviewQueueJql(SCOPE)).toBe(
      'project = SSX AND component IN ("SSX Advisor") ' +
        'AND labels IN ("agent:reviewing", "agent:review-done") ORDER BY updated ASC',
    );
  });

  it("watches an undrafted pull request as well as a drafting one", () => {
    // The mutation this is here for: drop agent:review-done and undrafting
    // silently ends the loop. A human review arriving after the handover is
    // exactly the feedback the loop was extended to hear, and it lands on a
    // ticket carrying that label and no other.
    const jql = buildReviewQueueJql(SCOPE);

    expect(jql).toContain('"agent:reviewing"');
    expect(jql).toContain('"agent:review-done"');
  });

  it("is a disjunction, not a conjunction", () => {
    // `labels = a AND labels = b` is a ticket carrying both, which no ticket
    // ever does — the two are mirror images written in one edit. That mutation
    // yields an always-empty queue, which reads as "nothing to do" rather than
    // as a malfunction, and is the reason this is checked separately from the
    // verbatim string.
    expect(buildReviewQueueJql(SCOPE)).not.toContain("labels =");
  });

  it("keeps watching a pull request whose ticket someone closed", () => {
    // Same direction as the in-flight query and one reason more: the look is
    // what writes agent:done or agent:closed when the pull request ends, so
    // filtering the ticket out here strands the label with nothing to clear it.
    expect(buildReviewQueueJql(SCOPE)).not.toContain("statusCategory");
  });

  it("does not restate the terminals as an exclusion", () => {
    // They are written in the same edit that removes the labels above, so a
    // ticket carrying one is already outside the positive clause. A second copy
    // of that rule is a second thing to keep in step.
    expect(buildReviewQueueJql(SCOPE)).not.toContain("NOT IN");
  });

  it("stays inside the configured scope, and omits the clause when there is none", () => {
    expect(buildReviewQueueJql(SCOPE)).toContain('component IN ("SSX Advisor")');
    expect(buildReviewQueueJql({ ...SCOPE, components: [] })).not.toContain("component");
  });

  it("refuses to interpolate an unsafe project or component", () => {
    expect(() => buildReviewQueueJql({ ...SCOPE, project: 'X" OR "1"="1' })).toThrow(JqlError);
    expect(() => buildReviewQueueJql({ ...SCOPE, components: ['x") OR labels = "y'] })).toThrow(
      JqlError,
    );
  });
});

describe("buildSendbackWatchJql", () => {
  const SCOPE = { project: "SSX", components: ["SSX Advisor"] };

  it("builds the query verbatim", () => {
    expect(buildSendbackWatchJql(SCOPE)).toBe(
      'project = SSX AND component IN ("SSX Advisor") ' +
        'AND labels = "agent:watching" ORDER BY updated ASC',
    );
  });

  it("returns closed tickets, so that something can unsubscribe them", () => {
    // The plan asked for `statusCategory != Done` here and also asked that a
    // closed ticket have its watch label removed. Both cannot hold: a ticket
    // this query hides is a ticket no loop can clean up, so the label would
    // outlive the ticket claiming a subscription nothing honours. Including
    // them is free — a closed ticket is a look that decides "unsubscribe"
    // without paying for a triage run.
    expect(buildSendbackWatchJql(SCOPE)).not.toContain("statusCategory");
  });

  it("does not restate the terminals as an exclusion", () => {
    // agent:watching is removed in the same edit that writes whatever replaced
    // it, so a ticket that moved on is already outside the positive clause.
    expect(buildSendbackWatchJql(SCOPE)).not.toContain("NOT IN");
  });

  it("selects the watch label and nothing broader", () => {
    // The mutation that matters on the invoice: widen this to the send-back
    // verdict's own labels — needs-info, dor:gaps — and the watch subscribes to
    // a set far too large to pay for, which is the reason `plausible` exists as
    // a separate field at all.
    const jql = buildSendbackWatchJql(SCOPE);

    expect(jql).toContain('labels = "agent:watching"');
    expect(jql).not.toContain("dor:gaps");
  });

  it("stays inside the configured scope, and omits the clause when there is none", () => {
    expect(buildSendbackWatchJql(SCOPE)).toContain('component IN ("SSX Advisor")');
    expect(buildSendbackWatchJql({ ...SCOPE, components: [] })).not.toContain("component");
  });

  it("refuses to interpolate an unsafe project or component", () => {
    expect(() => buildSendbackWatchJql({ ...SCOPE, project: 'X" OR "1"="1' })).toThrow(JqlError);
    expect(() => buildSendbackWatchJql({ ...SCOPE, components: ['x") OR labels = "y'] })).toThrow(
      JqlError,
    );
  });
});
