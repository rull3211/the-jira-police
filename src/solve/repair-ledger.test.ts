import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { SolveOutcome } from "./orchestrator.ts";
import {
  HEADER,
  REPAIR_LEDGER_FILE,
  UNREAD,
  distribution,
  isUnread,
  parseLedger,
  recordRepairRound,
  renderNoPage,
  renderSummary,
  repairRow,
} from "./repair-ledger.ts";
import type { FixReport } from "./runner.ts";
import type { Worktree } from "./worktree.ts";

const NOW = new Date("2026-09-22T08:20:13.791Z");

const worktree: Worktree = {
  issueKey: "SSX-3944",
  path: "/tmp/solve/SSX-3944",
  repoPath: "/repos/insurance-core",
  branch: "fix/ssx-3944-contact-info",
};

/** `filesTouched` is the field this module reads; `changed` is the boolean beside it. */
const fixReport = (filesTouched: readonly string[] = ["src/CustomerDto.java"]): FixReport => ({
  changed: true,
  filesTouched,
  summary: "stop auto-vivifying contactInfo",
  commitSubject: "fix(customer): stop auto-vivifying contactInfo",
  commitBody: "The defensive getter created an empty DTO the merger then treated as present.",
  testAdded: true,
  testOmittedReason: "",
  residualRisk: "",
  abandoned: "",
  abandonedCause: "none",
});

/** A failed run, optionally carrying what a repair round concluded. */
function failed(
  repairOutcome?: SolveOutcome["kind"],
  repair?: FixReport,
): Extract<SolveOutcome, { kind: "failed" }> {
  return {
    kind: "failed",
    reason: "2 tests failed",
    fix: fixReport(),
    ...(repairOutcome === undefined ? {} : { repairOutcome }),
    ...(repair === undefined ? {} : { repair }),
    verification: { outcome: "failed", reason: "2 tests failed" } as never,
    devLens: { accurate: true, correction: "" },
    worktree,
  };
}

/** A verified run; with `repair`, the shape a promoted repair round returns. */
function verified(repair?: FixReport): Extract<SolveOutcome, { kind: "verified" }> {
  return {
    kind: "verified",
    worktree,
    commit: { subject: "fix(customer): stop auto-vivifying contactInfo", body: "Refs: SSX-3944" },
    recon: {} as never,
    fix: fixReport(),
    simplify: {} as never,
    ...(repair === undefined ? {} : { repair }),
    verification: { outcome: "passed" } as never,
    failFirst: { outcome: "skipped", reason: "FAIL_FIRST_CHECK is off" },
    devLens: { accurate: true, correction: "" },
    files: 1,
    lines: 4,
  };
}

/** The cells of the one data row in `text`, by the same unescaped-pipe rule the parser uses. */
function onlyRecord(text: string) {
  const { records, unreadable } = parseLedger(text);
  expect(unreadable).toBe(0);
  expect(records).toHaveLength(1);
  return records[0]!;
}

describe("repairRow", () => {
  it("scores a green round as unread, because an exit code cannot audit that verdict", () => {
    const record = onlyRecord(repairRow("SSX-3944", failed("verified", fixReport()), NOW) ?? "");

    expect(record.round).toBe("verified");
    expect(record.read).toBe(UNREAD);
  });

  it("asks for no reading on a round that ended any other way", () => {
    // The claim in the header quantifies over both arms: a version writing `unread` everywhere
    // reads identically on the row above and turns the column into a debt nobody clears.
    for (const kind of ["failed", "crashed", "abandoned", "refused"] as const) {
      const record = onlyRecord(repairRow("SSX-3944", failed(kind), NOW) ?? "");
      expect(record.round).toBe(kind);
      expect(record.read).not.toBe(UNREAD);
    }
  });

  it("records the files the round touched, not whether it touched any", () => {
    // `FixReport.changed` is a boolean sitting next to `filesTouched`, and the orchestrator's own
    // logging already confuses the two — a row reading `true` would look like a filename.
    const record = onlyRecord(
      repairRow(
        "SSX-3944",
        failed("verified", fixReport(["src/CustomerDto.java", "src/CustomerCmHelperTest.java"])),
        NOW,
      ) ?? "",
    );

    expect(record.files).toBe("src/CustomerDto.java, src/CustomerCmHelperTest.java");
  });

  it("records the worktree path, which is the only place the diff lives", () => {
    const record = onlyRecord(repairRow("SSX-3944", failed("verified", fixReport()), NOW) ?? "");

    expect(record.worktree).toBe("/tmp/solve/SSX-3944");
    expect(record.when).toBe("2026-09-22T08:20:13.791Z");
    expect(record.issueKey).toBe("SSX-3944");
  });

  it("says a round ran even when it died before reporting which files it touched", () => {
    // `crashed`, `abandoned` and `refused` rounds carry no report; dropping the row would make
    // them indistinguishable from REPAIR_ROUND being off.
    const record = onlyRecord(repairRow("SSX-3944", failed("crashed"), NOW) ?? "");

    expect(record.round).toBe("crashed");
    expect(record.files).toBe("—");
  });

  it("writes no row for a failed run that bought no round", () => {
    expect(repairRow("SSX-3944", failed(), NOW)).toBeNull();
  });

  it("records a promoted round, which reaches it as `verified` rather than as `failed`", () => {
    // The rounds a pull request is opened from are the ones this page most needs; they carry
    // `repair` and no `repairOutcome`, so a predicate on `failed` alone drops every one silently.
    const record = onlyRecord(
      repairRow("SSX-3944", verified(fixReport(["src/CustomerCmHelperTest.java"])), NOW) ?? "",
    );

    expect(record.round).toBe("verified");
    expect(record.read).toBe(UNREAD);
    expect(record.files).toBe("src/CustomerCmHelperTest.java");
  });

  it("writes no row for a verified run no repair round produced", () => {
    // The plausible wrong widening — firing on every `verified` — would score each clean solve as
    // a green repair round, and bury the real ones under rows nobody owes a reading.
    expect(repairRow("SSX-3944", verified(), NOW)).toBeNull();
  });

  it("writes no row for an outcome that never reaches a round", () => {
    const bailed = {
      kind: "bailed",
      reason: "the described file does not exist",
      recon: {} as never,
      devLens: { accurate: true, correction: "" },
      worktree,
      cleanup: { outcome: "removed" },
    } as unknown as SolveOutcome;

    expect(repairRow("SSX-3944", bailed, NOW)).toBeNull();
  });

  it("loses a round that ran and then escaped, which is the gap the docstring names", () => {
    // Exercised rather than only asserted in prose: `escapeVerdict` replaces the whole outcome, so
    // the round's verdict is gone before this module sees it. The row is not merely absent by
    // accident — there is nothing left to write one from.
    const escaped = {
      kind: "escaped",
      paths: ["/repos/insurance-core"],
      would: "failed",
      worktree,
    } as unknown as SolveOutcome;

    expect(repairRow("SSX-3944", escaped, NOW)).toBeNull();
  });

  it("escapes a filename that would otherwise forge a column", () => {
    // Not cosmetic: an unescaped pipe shifts every cell after it, so the row still parses and the
    // `Round` column silently answers with a filename fragment.
    const record = onlyRecord(
      repairRow("SSX-3944", failed("verified", fixReport(["src/a|b.java"])), NOW) ?? "",
    );

    expect(record.round).toBe("verified");
    expect(record.files).toBe("src/a|b.java");
    expect(record.read).toBe(UNREAD);
  });
});

describe("parseLedger", () => {
  it("reads back exactly what the writer wrote, header and all", () => {
    // Built with the real writer rather than a hand-typed table: a fixture modelling the writer's
    // output is a test that cannot see the writer change.
    const page =
      HEADER +
      repairRow("SSX-3944", failed("verified", fixReport()), NOW) +
      repairRow("SSX-3950", failed("crashed"), NOW);

    const { records, unreadable } = parseLedger(page);

    expect(unreadable).toBe(0);
    expect(records.map((record) => record.issueKey)).toEqual(["SSX-3944", "SSX-3950"]);
    expect(records.map((record) => record.round)).toEqual(["verified", "crashed"]);
  });

  it("counts a table line it cannot read rather than dropping it", () => {
    // A page that silently loses rows understates the thing it scores.
    const page = `${HEADER}| 2026-09-22T08:20:13.791Z | SSX-3944 | verified |\n`;
    const { records, unreadable } = parseLedger(page);

    expect(records).toHaveLength(0);
    expect(unreadable).toBe(1);
  });

  it("keeps a row whose date cell a human could not fill in", () => {
    // The row this page most wants back-filled is one that predates it, and a person with no ISO
    // timestamp to hand types `-`. Treating any all-hyphen first cell as the alignment row made
    // that row disappear without even reaching `unreadable`.
    const page = `${HEADER}| - | SSX-3944 | verified | src/A.java | /tmp/w | unread |\n`;
    const { records, unreadable } = parseLedger(page);

    expect(unreadable).toBe(0);
    expect(records.map((record) => record.issueKey)).toEqual(["SSX-3944"]);
    expect(records[0]?.round).toBe("verified");
  });

  it("reads the header's own two opening lines as neither rows nor damage", () => {
    const { records, unreadable } = parseLedger(HEADER);

    expect(records).toHaveLength(0);
    expect(unreadable).toBe(0);
  });

  it("keeps a cell a human rewrote by hand", () => {
    const row = repairRow("SSX-3944", failed("verified", fixReport()), NOW) ?? "";
    const annotated = row.replace(UNREAD, "2026-09-23 honest — restored the test's premise");

    expect(onlyRecord(HEADER + annotated).read).toBe(
      "2026-09-23 honest — restored the test's premise",
    );
  });
});

describe("distribution", () => {
  it("counts each ending, commonest first and ties broken by name", () => {
    const { records } = parseLedger(
      HEADER +
        repairRow("SSX-1", failed("failed"), NOW) +
        repairRow("SSX-2", failed("verified", fixReport()), NOW) +
        repairRow("SSX-3", failed("failed"), NOW) +
        repairRow("SSX-4", failed("crashed"), NOW),
    );

    expect(distribution(records)).toEqual([
      ["failed", 2],
      ["crashed", 1],
      ["verified", 1],
    ]);
  });
});

/** A page built from real rows, so the summary is read off what the writer actually emits. */
const reading = (rows: readonly (string | null)[]) => parseLedger(HEADER + rows.join(""));

describe("renderSummary", () => {
  it("names every green round and marks the ones nobody has read", () => {
    const summary = renderSummary(
      reading([
        repairRow("SSX-3944", failed("verified", fixReport()), NOW),
        repairRow("SSX-3950", failed("failed"), NOW),
      ]),
    );

    expect(summary).toContain("UNREAD");
    expect(summary).toContain("SSX-3944");
    expect(summary).toContain("/tmp/solve/SSX-3944");
    expect(summary).toContain("git -C <worktree> diff HEAD");
    // The distribution is the other half, and it must count the round that was not green.
    expect(summary).toContain("failed");
  });

  it("reproduces a hand-written reading verbatim instead of classifying it", () => {
    // Counting "honest" and "cheap" would be counting the string that describes the event; the
    // event is a judgement nothing mechanical can make, which is why this page exists.
    const row = repairRow("SSX-3944", failed("verified", fixReport()), NOW) ?? "";
    const summary = renderSummary(
      reading([row.replace(UNREAD, "2026-09-23 cheap — deleted the failing assertion")]),
    );

    expect(summary).toContain("2026-09-23 cheap — deleted the failing assertion");
    expect(summary).not.toContain("UNREAD");
  });

  it("says plainly that nothing has been read when no round has gone green", () => {
    const summary = renderSummary(reading([repairRow("SSX-3950", failed("crashed"), NOW)]));

    expect(summary).toContain("(none yet)");
    expect(summary).not.toContain("UNREAD");
  });

  it("counts the green rounds separately from the rounds", () => {
    // Two different numbers that would coincide on a page of nothing but green rounds, which is
    // why the page here deliberately is not one.
    const summary = renderSummary(
      reading([
        repairRow("SSX-1", failed("verified", fixReport()), NOW),
        repairRow("SSX-2", failed("crashed"), NOW),
        repairRow("SSX-3", failed("failed"), NOW),
      ]),
    );

    expect(summary).toContain("3 repair round(s) recorded");
    expect(summary).toContain("Green rounds: 1");
  });

  it("refuses to let an all-unread page read as evidence of anything", () => {
    // The headline the README and architecture/solve.md both lean on. Without this the whole
    // block can be deleted and the suite stays green, since "UNREAD" also appears per record.
    const summary = renderSummary(
      reading([
        repairRow("SSX-1", failed("verified", fixReport()), NOW),
        repairRow("SSX-2", failed("verified", fixReport()), NOW),
      ]),
    );

    expect(summary).toContain("Never read: 2 of 2");
    expect(summary).toContain("not that any of them were honest");
  });

  it("drops that headline once every green round has been read", () => {
    const read = (repairRow("SSX-1", failed("verified", fixReport()), NOW) ?? "").replace(
      UNREAD,
      "2026-09-23 honest",
    );
    const summary = renderSummary(reading([read]));

    expect(summary).not.toContain("Never read:");
    expect(summary).toContain("2026-09-23 honest");
  });

  it("calls the counts a floor when a line could not be read", () => {
    const summary = renderSummary(parseLedger(`${HEADER}| broken | row |\n`));

    expect(summary).toContain("floor");
  });
});

describe("renderNoPage", () => {
  const path = "/repos/wt/groomed/repair-rounds.md";

  it("draws no conclusion about whether a round has run", () => {
    // The defect this replaced said "No repair rounds have been recorded" and "a failed solve has
    // not happened yet", from an empty relative directory in a worktree. Both were false, and the
    // second was an inference the command has no standing to make.
    const message = renderNoPage(path, true, undefined);

    expect(message).toContain("not evidence that no repair round has run");
    expect(message).not.toMatch(/has not happened yet/u);
    expect(message).not.toMatch(/no repair rounds have been recorded/iu);
  });

  it("names the absolute page it looked at, so the answer belongs to a checkout", () => {
    // A relative path printed from a worktree reads as an answer about the checkout solves write
    // to, which it is not. `OUTPUT_DIR` is relative, so this has to resolve rather than trust the
    // caller — the caller being an entry point no test runs.
    const relative = renderNoPage("groomed/repair-rounds.md", true, undefined);

    expect(relative).toMatch(/No page at \//u);
    expect(relative).toContain(`${process.cwd()}/groomed/repair-rounds.md`);
    expect(renderNoPage(path, true, undefined)).toContain(path);
  });

  it("reports an unset flag as unset rather than as the default it resolves to", () => {
    const message = renderNoPage(path, true, undefined);

    expect(message).toContain("unset in this environment");
    expect(message).toContain("built-in default");
  });

  it("quotes the value when this environment actually supplies one", () => {
    expect(renderNoPage(path, false, "false")).toContain('REPAIR_ROUND is "false"');
    expect(renderNoPage(path, false, "  false  ")).toContain('REPAIR_ROUND is "false"');
  });

  it("says nothing is buying a round only when nothing is", () => {
    expect(renderNoPage(path, false, "false")).toContain("Nothing is buying a round");
    expect(renderNoPage(path, true, "true")).not.toContain("Nothing is buying a round");
  });
});

describe("isUnread", () => {
  it("is false for a round that never went green, whatever its Read cell says", () => {
    // Two questions: "does this row owe a reading" and "has anyone read it". Only `verified` owes
    // one, so a `crashed` row carrying the harness's placeholder must not count as a debt.
    expect(
      isUnread({
        when: NOW.toISOString(),
        issueKey: "SSX-1",
        round: "crashed",
        files: "—",
        worktree: "/tmp/x",
        read: UNREAD,
      }),
    ).toBe(false);
  });
});

describe("recordRepairRound", () => {
  it("writes the header once and appends after that", async () => {
    const directory = await mkdtemp(join(tmpdir(), "repair-ledger-"));

    const first = await recordRepairRound(
      directory,
      "SSX-3944",
      failed("verified", fixReport()),
      NOW,
    );
    await recordRepairRound(directory, "SSX-3950", failed("crashed"), NOW);

    expect(first).toBe(join(directory, REPAIR_LEDGER_FILE));
    const page = await readFile(join(directory, REPAIR_LEDGER_FILE), "utf8");
    expect(page.split("# Repair rounds")).toHaveLength(2);
    expect(parseLedger(page).records).toHaveLength(2);
  });

  it("creates no page at all for a run that bought no round", async () => {
    // An empty file would read as "rounds ran and none were recorded", which is the opposite of
    // what REPAIR_ROUND=false means.
    const directory = await mkdtemp(join(tmpdir(), "repair-ledger-"));

    expect(await recordRepairRound(directory, "SSX-3944", failed(), NOW)).toBeNull();
    await expect(readFile(join(directory, REPAIR_LEDGER_FILE), "utf8")).rejects.toThrow();
  });

  it("still writes the header into a file an interrupted first write left empty", async () => {
    const directory = await mkdtemp(join(tmpdir(), "repair-ledger-"));
    await writeFile(join(directory, REPAIR_LEDGER_FILE), "", "utf8");

    await recordRepairRound(directory, "SSX-3944", failed("verified", fixReport()), NOW);

    const page = await readFile(join(directory, REPAIR_LEDGER_FILE), "utf8");
    expect(page.startsWith("# Repair rounds")).toBe(true);
    expect(parseLedger(page).records).toHaveLength(1);
  });
});
