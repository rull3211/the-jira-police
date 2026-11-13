import { describe, expect, it } from "vitest";

import {
  ChangelogArgError,
  DEFAULT_EXCLUSIONS,
  MAX_DAYS,
  dayOf,
  issueKind,
  judge,
  judgePullRequests,
  names,
  parseDays,
  type JudgedIssue,
  type PullRequest,
} from "./rules.ts";

describe("parseDays", () => {
  it("reads a bare number, a number with a d, and nothing as a week", () => {
    expect(parseDays("14")).toBe(14);
    expect(parseDays("14d")).toBe(14);
    expect(parseDays(" 7 ")).toBe(7);
    expect(parseDays(undefined)).toBe(7);
    expect(parseDays("")).toBe(7);
  });

  it("refuses text that merely starts with a number", () => {
    // parseInt("7abc") is 7: the plausible implementation turns a typo into a window.
    for (const raw of ["7abc", "7 days", "1.5", "-3", "abc", "0", "0031"]) {
      expect(() => parseDays(raw), raw).toThrow(ChangelogArgError);
    }
  });

  it("refuses a window longer than the maximum, and accepts the maximum itself", () => {
    expect(parseDays(String(MAX_DAYS))).toBe(MAX_DAYS);
    expect(() => parseDays(String(MAX_DAYS + 1))).toThrow(/1 to 31/u);
  });

  it("clips an absurd argument in the message it echoes", () => {
    expect(() => parseDays("9".repeat(500) + "x")).toThrow(/got "9{20}"/u);
  });
});

describe("issueKind", () => {
  it("reads Jira's Norwegian type names as well as the English ones", () => {
    expect(issueKind({ name: "Feil", subtask: false })).toBe("bug");
    expect(issueKind({ name: "Bug", subtask: false })).toBe("bug");
    expect(issueKind({ name: "Oppgave", subtask: false })).toBe("task");
    expect(issueKind({ name: "Historie", subtask: false })).toBe("story");
    expect(issueKind({ name: "Epic", subtask: false })).toBe("other");
  });

  it("lets the subtask flag decide before the name does", () => {
    // `Deloppgave` ends in a word that reads as a task; matching names first would call it one.
    expect(issueKind({ name: "Deloppgave", subtask: true })).toBe("sub");
    expect(issueKind({ name: "Task", subtask: true })).toBe("sub");
  });
});

const issue = (over: Partial<JudgedIssue> & { status?: JudgedIssue["status"] }): JudgedIssue => ({
  key: "SSX-1",
  status: { name: "Ferdig", category: "done" },
  resolution: "Solved",
  resolved: "2026-11-12T10:00:00.000+0100",
  ...over,
});

describe("judge", () => {
  it("counts a resolved issue whose status is done", () => {
    expect(judge(issue({}), DEFAULT_EXCLUSIONS)).toEqual({ kind: "counted", statusStale: false });
  });

  it("counts a resolved issue whose status went back to in progress, and says the status is stale", () => {
    const stale = issue({ status: { name: "In Code Review", category: "indeterminate" } });
    expect(judge(stale, DEFAULT_EXCLUSIONS)).toEqual({ kind: "counted", statusStale: true });
  });

  it("excludes a rejected issue even when its resolution reads Solved", () => {
    // Resolution alone would count it: the plausible wrong rule, and the shape SSX-3642 has.
    const rejected = issue({ status: { name: "Avvist", category: "done" }, resolution: "Solved" });
    expect(judge(rejected, DEFAULT_EXCLUSIONS)).toEqual({
      kind: "excluded",
      reason: "status Avvist",
    });
  });

  it("excludes a duplicate by resolution, whatever case it is written in", () => {
    expect(judge(issue({ resolution: "Duplikat" }), DEFAULT_EXCLUSIONS)).toEqual({
      kind: "excluded",
      reason: "resolution Duplikat",
    });
    expect(judge(issue({ resolution: "duplicate" }), DEFAULT_EXCLUSIONS).kind).toBe("excluded");
  });

  it("excludes an issue with no resolution instead of counting it", () => {
    expect(judge(issue({ resolution: null }), DEFAULT_EXCLUSIONS)).toEqual({
      kind: "excluded",
      reason: "no resolution",
    });
    expect(judge(issue({ resolved: null }), DEFAULT_EXCLUSIONS).kind).toBe("excluded");
  });

  it("uses the rules it is given, not the defaults", () => {
    expect(judge(issue({ resolution: "Duplikat" }), { statuses: [], resolutions: [] }).kind).toBe(
      "counted",
    );
  });
});

describe("dayOf", () => {
  it("keeps the day Jira wrote, not the UTC day", () => {
    // Converting 00:30 +01:00 to UTC lands on the 11th: the plausible implementation moves the entry a day.
    expect(dayOf("2026-11-12T00:30:00.000+0100")).toBe("2026-11-12");
  });
});

describe("names", () => {
  it("matches the key as a whole token, in either case", () => {
    expect(names("SSX-4266", "ssx-4266-move-button")).toBe(true);
    expect(names("SSX-4267", "feat/ssx-4267-general-advice")).toBe(true);
    expect(names("SSX-4271", "fix(child): change the advice document (SSX-4271)")).toBe(true);
  });

  it("does not match a longer number or a longer prefix", () => {
    expect(names("SSX-427", "fix(SSX-4271): x")).toBe(false);
    expect(names("SSX-4271", "fix(SSX-42710): x")).toBe(false);
    expect(names("SSX-4271", "fix(XSSX-4271): x")).toBe(false);
  });

  it("treats the key as text, not as a pattern", () => {
    expect(names("A.B-1", "AxB-1")).toBe(false);
  });
});

const pr = (over: Partial<PullRequest> & Pick<PullRequest, "number">): PullRequest => ({
  repo: "commerce-rest",
  title: "feat(SSX-4275): return orderTime",
  branch: "feat/other",
  state: "merged",
  additions: 36,
  deletions: 9,
  mergedAt: "2026-11-10T10:00:00Z",
  ...over,
});

describe("judgePullRequests", () => {
  it("counts a merged pull request named for the issue in its title or its branch", () => {
    const out = judgePullRequests("SSX-4266", [
      pr({
        number: 2746,
        repo: "advisor-web",
        title: "feat(advisorsupport): move previous button",
        branch: "ssx-4266-move-button",
      }),
    ]);
    expect(out.counted.map((p) => p.number)).toEqual([2746]);
    expect(out.others).toEqual([]);
  });

  it("does not count a pull request that only mentions the issue in its body", () => {
    // A body names follow-ups and siblings: counting it would credit this issue with another's change.
    const out = judgePullRequests("SSX-4287", [
      pr({ number: 1569, title: "feat(SSX-4319): attach the vilkår", state: "open" }),
    ]);
    expect(out.counted).toEqual([]);
    expect(out.others).toEqual([
      { repo: "commerce-rest", number: 1569, why: "mentions the issue without being named for it" },
    ]);
  });

  it("does not count one that is closed without merging, or still open", () => {
    const out = judgePullRequests("SSX-4266", [
      // The title has no hyphen, so it is the branch that names the issue, as it was on the real one.
      pr({
        number: 2745,
        title: "Ssx 4266 move button",
        branch: "ssx-4266-move-button",
        state: "closed",
        mergedAt: null,
      }),
      pr({ number: 2747, title: "SSX-4266 again", state: "open", mergedAt: null }),
    ]);
    expect(out.counted).toEqual([]);
    expect(out.others.map((o) => o.why)).toEqual(["closed without merging", "still open"]);
  });

  it("flags a revert", () => {
    const out = judgePullRequests("SSX-4271", [
      pr({ number: 2755, title: "revert(child): remove the tool (SSX-4271)" }),
    ]);
    expect(out.counted[0]?.flags).toEqual(["revert"]);
  });

  it("flags the later of two identical merges as the twin of the earlier, by merge time and not by number", () => {
    const out = judgePullRequests("SSX-4275", [
      pr({ number: 1552, mergedAt: "2026-11-10T10:52:35Z" }),
      pr({ number: 1554, mergedAt: "2026-11-10T07:09:37Z" }),
    ]);
    expect(out.counted.map((p) => [p.number, p.flags])).toEqual([
      [1554, []],
      [1552, ["twin of #1554"]],
    ]);
  });

  it("does not call two different changes twins because their titles agree", () => {
    const out = judgePullRequests("SSX-4275", [
      pr({ number: 1, additions: 36, mergedAt: "2026-11-10T07:00:00Z" }),
      pr({ number: 2, additions: 37, mergedAt: "2026-11-10T08:00:00Z" }),
      pr({ number: 3, repo: "advisor-web", additions: 36, mergedAt: "2026-11-10T09:00:00Z" }),
    ]);
    expect(out.counted.every((p) => p.flags.length === 0)).toBe(true);
  });
});
