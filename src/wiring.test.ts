import { describe, expect, it } from "vitest";

import { JqlError } from "./jira/jql.ts";
import type { JiraClient } from "./jira/client.ts";
import type { TicketRef } from "./jira/types.ts";
import { type Settings, SettingsError, readSettings } from "./settings.ts";
import { buildPrompt, toolsFor } from "./triage/runner.ts";
import { runSolveCycle } from "./solve/poller.ts";
import type { IssueDetail } from "./jira/client.ts";
import type { SolveOutcome, SolveRequest } from "./solve/orchestrator.ts";
import type { WorktreeResult } from "./solve/worktree.ts";
import {
  NotSolvableError,
  baseBranchOf,
  buildAdvanceRequest,
  buildFindPrRequest,
  buildPublishRequest,
  buildSolveRequest,
  buildTriageOptions,
  createReviewCycleDeps,
  createSolveDeps,
  createSolveRunDeps,
  githubRepoFor,
  pollIntervalMs,
  reviewIntervalMs,
  shouldPost,
} from "./wiring.ts";

/** Minimum environment that satisfies the required settings. */
const ENV = { JIRA_EMAIL: "a@b.c", JIRA_AUTH: "placeholder" };

function settingsWith(overrides: Partial<Record<string, string>>): Settings {
  return readSettings({ ...ENV, ...overrides });
}

describe("buildTriageOptions", () => {
  it("refuses to build a real run with no vault", () => {
    // The failure this prevents is the quiet one: intake-triage stops and asks
    // a human for the vault path, and a headless run exits 0 having answered
    // nothing. A service that polls forever producing no verdicts looks healthy.
    expect(() =>
      buildTriageOptions(settingsWith({ SKILL_NAME: "intake-triage" }), "SSX-1"),
    ).toThrow(SettingsError);
  });

  it("names the setting that is missing", () => {
    try {
      buildTriageOptions(settingsWith({ SKILL_NAME: "intake-triage" }), "SSX-1");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as SettingsError).missing).toEqual(["VAULT_PATH"]);
    }
  });

  it("treats an unknown skill as the real thing, not as a stand-in", () => {
    // A fork given a vault it does not need loses nothing. One silently denied
    // a vault produces confident verdicts with no dedup behind them.
    expect(() =>
      buildTriageOptions(settingsWith({ SKILL_NAME: "intake-triage-v2" }), "SSX-1"),
    ).toThrow(SettingsError);
  });

  it.each(["mock-triage", "live-triage-probe"])("needs no vault for %s", (skill) => {
    const options = buildTriageOptions(settingsWith({ SKILL_NAME: skill }), "SSX-1");

    expect(options.vaultPath).toBeUndefined();
    expect(options.noHtml).toBeUndefined();
  });

  it("equips a real run with the vault and suppresses the dashboard", () => {
    const options = buildTriageOptions(
      settingsWith({ SKILL_NAME: "intake-triage", VAULT_PATH: "/vaults/v" }),
      "SSX-1",
    );

    expect(options).toMatchObject({
      issueKey: "SSX-1",
      skillName: "intake-triage",
      vaultPath: "/vaults/v",
      noHtml: true,
      // Sub-agents cannot prompt for tool permissions, so the skill's own
      // instructions forbid them outside --deep. Keeping deep off keeps that true.
      deep: false,
      requiredMcpServers: ["atlassian"],
    });
  });

  it("spares the mock a live Atlassian session and every tool", () => {
    const options = buildTriageOptions(settingsWith({ SKILL_NAME: "mock-triage" }), "SSX-1");

    expect(options.requiredMcpServers).toEqual([]);
    expect(options.allowedTools).toEqual([]);
  });

  it("holds the probe to a live session, since it does read a real ticket", () => {
    const options = buildTriageOptions(settingsWith({ SKILL_NAME: "live-triage-probe" }), "SSX-1");

    expect(options.requiredMcpServers).toEqual(["atlassian"]);
    expect(options.allowedTools).toBeUndefined();
  });

  // `numeric` grew a floor, but a floor only applies where a caller asks for
  // it, and "the guard is correct" and "the caller uses it" are separate facts
  // — the same join that has now bitten this codebase in passes.ts, delivery.ts
  // and the triage skill. Asserted here, at the seam, because zero is the value
  // that reads like "no limit" and behaves like "already expired".
  it("refuses a zero triage timeout rather than expiring every run at once", () => {
    expect(() =>
      buildTriageOptions(
        settingsWith({ SKILL_NAME: "mock-triage", TRIAGE_TIMEOUT_MS: "0" }),
        "SSX-1",
      ),
    ).toThrow(/TRIAGE_TIMEOUT_MS must be at least 1/);
  });

  it("refuses a negative triage timeout", () => {
    expect(() =>
      buildTriageOptions(
        settingsWith({ SKILL_NAME: "mock-triage", TRIAGE_TIMEOUT_MS: "-1000" }),
        "SSX-1",
      ),
    ).toThrow(/TRIAGE_TIMEOUT_MS must be at least 1/);
  });

  it("carries the shipped default through unchanged", () => {
    const options = buildTriageOptions(settingsWith({ SKILL_NAME: "mock-triage" }), "SSX-1");

    expect(options.timeoutMs).toBe(1_200_000);
  });
});

describe("pollIntervalMs", () => {
  it("reads the configured cadence", () => {
    expect(pollIntervalMs(settingsWith({ POLL_INTERVAL_MS: "30000" }))).toBe(30_000);
  });

  // The daemon's `--interval 0` is a plausible typo for "as fast as possible",
  // and it would be granted: runLoop would sleep for nothing between cycles and
  // hammer Jira until something rate-limited it.
  it("refuses a zero interval, which is an unthrottled loop and not an eager one", () => {
    expect(() => pollIntervalMs(settingsWith({ POLL_INTERVAL_MS: "0" }))).toThrow(
      /POLL_INTERVAL_MS must be at least 1/,
    );
  });

  it("refuses a negative interval", () => {
    expect(() => pollIntervalMs(settingsWith({ POLL_INTERVAL_MS: "-1" }))).toThrow(
      /POLL_INTERVAL_MS must be at least 1/,
    );
  });
});

describe("reviewIntervalMs", () => {
  it("reads REVIEW_POLL_MS and not the poll cadence", () => {
    // The mutation this catches is a one-word one — returning POLL_INTERVAL_MS
    // — and it is invisible at both defaults being plausible numbers of
    // minutes. What it would do is tie how fast the service answers a reviewer
    // to a setting whose description is "gap between polls".
    const settings = settingsWith({ REVIEW_POLL_MS: "45000", POLL_INTERVAL_MS: "300000" });
    expect(reviewIntervalMs(settings)).toBe(45_000);
  });

  it("refuses a zero interval, which is unthrottled against gh as well as Jira", () => {
    expect(() => reviewIntervalMs(settingsWith({ REVIEW_POLL_MS: "0" }))).toThrow(
      /REVIEW_POLL_MS must be at least 1/,
    );
  });
});

describe("shouldPost and WRITE_BACK", () => {
  function real(overrides: Partial<Record<string, string>> = {}): boolean {
    return shouldPost(
      settingsWith({ SKILL_NAME: "intake-triage", VAULT_PATH: "/vaults/v", ...overrides }),
    );
  }

  it("does not write back unless asked", () => {
    // The default matters more than usual here: this is the only setting whose
    // effect is visible to the whole team.
    expect(real()).toBe(false);
  });

  it("writes back when the setting is true", () => {
    expect(real({ WRITE_BACK: "true" })).toBe(true);
  });

  it.each(["TRUE", "True", " true "])("accepts %o, since .env values arrive untidy", (value) => {
    expect(real({ WRITE_BACK: value })).toBe(true);
  });

  it.each(["yes", "1", "on", "", "  ", "no", "maybe"])(
    "fails closed on %o rather than guessing",
    (value) => {
      // Truthiness would make "0" and "false" enable writes. A setting that
      // posts to shared tickets is the wrong place to be generous.
      expect(real({ WRITE_BACK: value })).toBe(false);
    },
  );

  it.each(["mock-triage", "live-triage-probe"])(
    "keeps %s in preview even when WRITE_BACK is on",
    (skill) => {
      // Both exist to rehearse the pipeline. A rehearsal that comments on a
      // real ticket is not a rehearsal — and the probe does hit a real key.
      expect(shouldPost(settingsWith({ SKILL_NAME: skill, WRITE_BACK: "true" }))).toBe(false);
    },
  );

  it("never lets the analyst write, whatever WRITE_BACK says", () => {
    // The two halves are independent: WRITE_BACK decides whether the poster is
    // dispatched, and cannot re-arm the analyst. Before the split this was one
    // flag doing both jobs, which is how a comment reached a ticket before the
    // verdict behind it had been checked.
    for (const value of ["true", "false"]) {
      const options = buildTriageOptions(
        settingsWith({ SKILL_NAME: "intake-triage", VAULT_PATH: "/vaults/v", WRITE_BACK: value }),
        "SSX-1",
      );

      expect(buildPrompt(options)).toContain("--no-write");
      expect(toolsFor(options).join(" ")).not.toContain("addCommentToJiraIssue");
    }
  });
});

function ticket(overrides: Partial<TicketRef> = {}): TicketRef {
  return {
    key: "SSX-3822",
    summary: "A bug",
    issueTypeId: "10004",
    issueTypeName: "Feil",
    created: "2026-03-01T09:00:00.000+0100",
    updated: "2026-09-02T09:55:34.178+0200",
    labels: ["agent:solvable", "agent:start", "svc:buy-insurance-advisor-web"],
    url: "https://example.invalid/browse/SSX-3822",
    ...overrides,
  };
}

/**
 * A stand-in for the only thing that talks to Jira, recording every query.
 *
 * Answers the two queries differently, and tells them apart the way Jira
 * would — by what they ask for. That is not decoration: on the board these
 * two results are disjoint by construction, since the queue excludes exactly
 * the label the in-flight count selects on. A fake that returned the same
 * rows to both would make a limit of one look like it had no capacity ever,
 * and would hide a wiring bug behind a plausible outcome.
 */
function fakeClient(
  queue: readonly TicketRef[] = [],
  inFlight: readonly TicketRef[] = [],
): { client: JiraClient; queries: string[] } {
  const queries: string[] = [];
  const client = {
    search: async (jql: string): Promise<readonly TicketRef[]> => {
      queries.push(jql);
      return jql.includes("NOT IN") ? queue : inFlight;
    },
  } as unknown as JiraClient;
  return { client, queries };
}

/**
 * Composition of the solve queue.
 *
 * The unit tests in `src/solve/poller.test.ts` prove the cycle behaves against
 * a fake. These prove the fake resembles what production will hand it — which
 * is the half that was missing when the poller was first written, and the half
 * where a wiring mistake is invisible because every component still passes its
 * own tests.
 */
describe("createSolveDeps", () => {
  const SOLVE_ENV = { JIRA_PROJECT: "SSX", JIRA_COMPONENTS: "SSX Advisor" };

  function solveSettings(overrides: Partial<Record<string, string>> = {}): Settings {
    return settingsWith({ ...SOLVE_ENV, ...overrides });
  }

  it("carries the labels and the timestamp the queue selects on", async () => {
    // The narrowing is where a field gets quietly dropped, and `labels` is the
    // queue's entire state. Dropping it here would leave every ticket skipped
    // with a plausible-looking reason and no sign anything was wrong.
    const { client } = fakeClient([ticket()]);

    const queue = await createSolveDeps(solveSettings(), client).fetchQueue();

    expect(queue).toEqual([
      {
        key: "SSX-3822",
        summary: "A bug",
        url: "https://example.invalid/browse/SSX-3822",
        labels: ["agent:solvable", "agent:start", "svc:buy-insurance-advisor-web"],
        updated: "2026-09-02T09:55:34.178+0200",
      },
    ]);
  });

  it("asks two different questions for the queue and the in-flight count", async () => {
    // The bound's whole mechanism. The queue query excludes agent:solving, so
    // counting in-flight work from the queue result would count zero forever
    // and cap nothing — a limit of one would start a solve every tick.
    const { client, queries } = fakeClient();
    const deps = createSolveDeps(solveSettings(), client);

    await deps.fetchQueue();
    await deps.countInFlight();

    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain('labels NOT IN ("agent:solving"');
    expect(queries[1]).toContain('labels = "agent:solving"');
    expect(queries[0]).not.toBe(queries[1]);
  });

  it("counts the tickets the in-flight query returns, not the queued ones", async () => {
    // Wired to the wrong query this returns 0 forever, because the queue
    // excludes the claim label — and a bound of one would start a solve every
    // tick with the previous one still running.
    const { client } = fakeClient(
      [ticket({ key: "SSX-1" })],
      [ticket({ key: "SSX-2" }), ticket({ key: "SSX-3" })],
    );

    expect(await createSolveDeps(solveSettings(), client).countInFlight()).toBe(2);
  });

  it("has no function capable of writing", () => {
    // Phase B's refusal is structural, not promised: there is nothing to call.
    // If this ever fails, someone has granted the write, and that is a decision
    // that should be made in a review rather than discovered in production.
    const deps = createSolveDeps(solveSettings(), fakeClient().client);

    const callable = Object.entries(deps)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name);

    expect(callable.toSorted()).toEqual(["countInFlight", "fetchQueue"]);
  });

  it("advertises the same queries it runs", async () => {
    // The cycle report prints `queueJql` and `inFlightJql` as the explanation
    // for its numbers, so an operator can paste them into Jira and check the
    // result by hand. That is only worth anything if the advertised query is
    // the executed one — a second rendering built alongside the first would be
    // free to disagree with it, and the report would then be a confident
    // account of a query nobody ran.
    const { client, queries } = fakeClient();
    const deps = createSolveDeps(solveSettings(), client);

    await deps.fetchQueue();
    await deps.countInFlight();

    expect(queries).toEqual([deps.queueJql, deps.inFlightJql]);
  });

  it("is disabled unless SOLVE_ENABLED is exactly true", () => {
    const deps = (value: string): boolean =>
      createSolveDeps(solveSettings({ SOLVE_ENABLED: value }), fakeClient().client).enabled;

    expect(deps("true")).toBe(true);
    for (const value of ["", "yes", "1", "on", "false", "True!"]) {
      expect(deps(value)).toBe(false);
    }
  });

  it("defaults to manual, and requires the human label in the query it builds", async () => {
    const { client, queries } = fakeClient();
    const deps = createSolveDeps(solveSettings(), client);

    expect(deps.mode).toBe("manual");
    await deps.fetchQueue();
    expect(queries[0]).toContain('labels = "agent:start"');
  });

  it("rejects an unrecognised SOLVE_MODE at composition, before any query runs", () => {
    // Not on the first cycle, and not by falling back. A typo'd mode is an
    // operator who believes something about this service that is not true, and
    // the cheapest place to correct them is at startup.
    expect(() =>
      createSolveDeps(solveSettings({ SOLVE_MODE: "atuo" }), fakeClient().client),
    ).toThrow(SettingsError);
  });

  it("builds both queries eagerly, so a bad one fails at startup", async () => {
    // Deferring the build into the closures would mean a service that starts
    // clean, logs nothing, and fails on whichever cycle first reaches the board
    // — by which time nobody is watching startup. Asserting it by the only
    // means available: a query that cannot be built at all.
    expect(() =>
      createSolveDeps(solveSettings({ JIRA_PROJECT: 'X" OR "1"="1' }), fakeClient().client),
    ).toThrow(JqlError);
  });

  it("cannot be blanked into unrestricted auto mode", () => {
    // `SOLVE_AUTO_ISSUE_TYPES=` does not reach the poller as an empty list —
    // readSettings substitutes the fallback, and here the fallback IS the
    // restriction. So the dangerous configuration is unreachable, and the
    // JqlError in buildSolveQueueJql guards the other route in: a caller
    // constructing options directly.
    const { client, queries } = fakeClient();

    const deps = createSolveDeps(
      solveSettings({ SOLVE_MODE: "auto", SOLVE_AUTO_ISSUE_TYPES: "" }),
      client,
    );

    expect(deps.mode).toBe("auto");
    return deps.fetchQueue().then(() => {
      expect(queries[0]).toContain('issuetype IN ("Feil")');
    });
  });

  it("allows no repository at all until one is named", () => {
    // The reason SOLVE_REPOS is the one solve setting with no fallback.
    // `readSettings` cannot tell blank from unset, so a default here would be a
    // write privilege that survives being deleted from .env — an operator
    // taking the solver off a repo would have handed it straight back.
    const allowed = (value?: string): readonly string[] =>
      createSolveDeps(
        solveSettings(value === undefined ? {} : { SOLVE_REPOS: value }),
        fakeClient().client,
      ).allowedRepos;

    expect(allowed()).toEqual([]);
    expect(allowed("")).toEqual([]);
    expect(allowed("a, b")).toEqual(["a", "b"]);
  });

  it("skips every ticket while the allowlist is empty", async () => {
    // The empty list has to mean something by the time it reaches the poller,
    // or the paragraph above is just a comment. Nothing is planned, and the
    // reason names the setting rather than the ticket.
    const deps = createSolveDeps(
      solveSettings({ SOLVE_ENABLED: "true" }),
      fakeClient([ticket()]).client,
    );

    const outcome = await runSolveCycle(deps);

    expect(outcome.planned).toEqual([]);
    expect(outcome.skipped[0]?.reason).toContain("SOLVE_REPOS is empty");
  });

  it("plans a claim end to end once the repository is allowed", async () => {
    // The whole composition, exercised the way `solve:once` will exercise it:
    // real settings, real queries, a fake only at the HTTP boundary. Every
    // piece of this passed its own tests while the queue was unfeedable.
    const deps = createSolveDeps(
      solveSettings({ SOLVE_ENABLED: "true", SOLVE_REPOS: "buy-insurance-advisor-web" }),
      fakeClient([ticket()]).client,
    );

    const outcome = await runSolveCycle(deps);

    expect(outcome.dryRun).toBe(true);
    expect(outcome.planned).toEqual([
      {
        issueKey: "SSX-3822",
        repo: "buy-insurance-advisor-web",
        claim: { add: ["agent:solving"], remove: ["agent:start"] },
        labelsAfter: ["agent:solvable", "svc:buy-insurance-advisor-web", "agent:solving"],
      },
    ]);
  });

  it("passes the concurrency limit through as a number", () => {
    const deps = createSolveDeps(
      solveSettings({ MAX_CONCURRENT_SOLVES: "2" }),
      fakeClient().client,
    );

    expect(deps.maxConcurrent).toBe(2);
  });

  it("omits the signal rather than passing undefined", () => {
    // Same shape as createPollDeps: the one-shot CLI has nothing to interrupt,
    // and `exactOptionalPropertyTypes` makes the difference real.
    expect("signal" in createSolveDeps(solveSettings(), fakeClient().client)).toBe(false);
  });

  it("passes a signal on when the daemon supplies one", () => {
    const controller = new AbortController();

    const deps = createSolveDeps(solveSettings(), fakeClient().client, controller.signal);

    expect(deps.signal).toBe(controller.signal);
  });
});

/** The settings a real solve needs, so each test can remove exactly one. */
const SOLVE_ENV = {
  VAULT_PATH: "/vault",
  SOLVE_REPO_ROOT: "/repos",
  SOLVE_REPOS: "buy-insurance-advisor-web",
};

function detailWith(labels: readonly string[]): IssueDetail {
  return {
    key: "SSX-3822",
    summary: "Distinct favicon",
    issueTypeName: "Oppgave",
    status: "Mottatt",
    labels,
    description: undefined,
    comments: [],
    attachments: [],
    url: "https://example.invalid/browse/SSX-3822",
  };
}

describe("buildSolveRequest", () => {
  it("resolves the repository from the ticket's own svc: label", () => {
    const request = buildSolveRequest(
      settingsWith(SOLVE_ENV),
      detailWith(["svc:buy-insurance-advisor-web"]),
      "ticket text",
    );

    expect(request.repoPath).toBe("/repos/buy-insurance-advisor-web");
    expect(request.issueKey).toBe("SSX-3822");
    expect(request.ticket).toBe("ticket text");
    expect(request.baseRef).toBe("origin/main");
  });

  it("refuses a repository that is not on the allowlist", () => {
    // The write-privilege gate. A ticket naming any other repository is refused
    // here rather than discovered after four model sessions.
    expect(() =>
      buildSolveRequest(
        settingsWith(SOLVE_ENV),
        detailWith(["svc:some-other-repo"]),
        "ticket text",
      ),
    ).toThrow(NotSolvableError);
  });

  it("refuses when SOLVE_REPOS is empty rather than defaulting to everything", () => {
    expect(() =>
      buildSolveRequest(
        settingsWith({ ...SOLVE_ENV, SOLVE_REPOS: "" }),
        detailWith(["svc:buy-insurance-advisor-web"]),
        "ticket text",
      ),
    ).toThrow(NotSolvableError);
  });

  it("refuses a ticket that names no repository, or two", () => {
    // `repoFromLabels` resolves every ambiguous reading to null. Both ends of
    // that are refusals here, because the value decides what gets written to.
    for (const labels of [[], ["triaged"], ["svc:one", "svc:two"]]) {
      expect(() => buildSolveRequest(settingsWith(SOLVE_ENV), detailWith(labels), "t")).toThrow(
        NotSolvableError,
      );
    }
  });

  it("refuses to guess where the checkouts live", () => {
    expect(() =>
      buildSolveRequest(
        settingsWith({ ...SOLVE_ENV, SOLVE_REPO_ROOT: "" }),
        detailWith(["svc:buy-insurance-advisor-web"]),
        "t",
      ),
    ).toThrow(SettingsError);
  });

  it("puts the worktree somewhere that is obviously not the repository", () => {
    // A failed run keeps its worktree for inspection. It should be findable and
    // it should not be sitting inside a checkout somebody works in.
    const request = buildSolveRequest(
      settingsWith(SOLVE_ENV),
      detailWith(["svc:buy-insurance-advisor-web"]),
      "t",
    );

    expect(request.parentDirectory).not.toContain("/repos");
  });

  it("floors every timeout above zero", () => {
    // Zero is not "no timeout"; it is a timeout that expired before the step
    // began, which would kill each one instantly.
    for (const name of [
      "SOLVE_GIT_TIMEOUT_MS",
      "SOLVE_STEP_TIMEOUT_MS",
      "SOLVE_INSTALL_TIMEOUT_MS",
    ]) {
      expect(() =>
        buildSolveRequest(
          settingsWith({ ...SOLVE_ENV, [name]: "0" }),
          detailWith(["svc:buy-insurance-advisor-web"]),
          "t",
        ),
      ).toThrow();
    }
  });
});

describe("worktree root", () => {
  it("uses the configured directory when there is one", () => {
    // It exists because the system temp directory on macOS lands under
    // /private/var, which some tooling cannot open — and the C phase mandates a
    // human reading the diff before anything leaves the machine.
    const request = buildSolveRequest(
      settingsWith({ ...SOLVE_ENV, SOLVE_WORKTREE_ROOT: "/Users/me/solves" }),
      detailWith(["svc:buy-insurance-advisor-web"]),
      "t",
    );

    expect(request.parentDirectory).toBe("/Users/me/solves");
  });

  it("treats whitespace as unset rather than as a directory named space", () => {
    // The trimming is `readSettings`', not this function's — asserted here
    // because this is where it would be noticed if it stopped happening, and
    // because a worktree root of "   " creates a directory nobody can find.
    const request = buildSolveRequest(
      settingsWith({ ...SOLVE_ENV, SOLVE_WORKTREE_ROOT: "   " }),
      detailWith(["svc:buy-insurance-advisor-web"]),
      "t",
    );

    expect(request.parentDirectory).toContain("jira-police-solve");
  });

  it("names the service in the fallback path", () => {
    // A leaked worktree under the system temp directory should be attributable
    // to whatever left it there.
    const request = buildSolveRequest(
      settingsWith(SOLVE_ENV),
      detailWith(["svc:buy-insurance-advisor-web"]),
      "t",
    );

    expect(request.parentDirectory).toContain("jira-police-solve");
  });
});

describe("baseBranchOf", () => {
  it("strips the remote from a remote-tracking ref", () => {
    expect(baseBranchOf("origin/main")).toBe("main");
  });

  it("leaves a plain branch name alone", () => {
    expect(baseBranchOf("main")).toBe("main");
  });

  it("strips only the leading remote, and only one", () => {
    // A branch genuinely called `release/origin/x` must not be mangled, and
    // `origin/origin/x` means the branch `origin/x` on the remote `origin`.
    expect(baseBranchOf("release/origin/x")).toBe("release/origin/x");
    expect(baseBranchOf("origin/origin/x")).toBe("origin/x");
  });

  it("does not mistake a branch that merely starts with the word", () => {
    expect(baseBranchOf("originals")).toBe("originals");
  });
});

/** A `verified` outcome, which is the only kind `buildPublishRequest` accepts. */
function verifiedOutcome(): Extract<SolveOutcome, { kind: "verified" }> {
  return {
    kind: "verified",
    worktree: {
      issueKey: "SSX-3822",
      path: "/tmp/solve/SSX-3822",
      branch: "fix/ssx-3822-favicon",
      repoPath: "/repos/buy-insurance-advisor-web",
    },
    commit: { subject: "fix(advisor): distinct favicon", body: "why" },
    recon: {
      proceed: true,
      confidence: "high",
      rootCause: "",
      devLensAccurate: true,
      devLensCorrection: "",
      plannedFiles: [],
      approach: "",
      testPlan: "",
      estimatedLines: 1,
      bailReason: "",
      bailBlockers: [],
      bailRemedy: "",
      injectionNoticed: "",
    },
    fix: {
      changed: true,
      filesTouched: [],
      summary: "did it",
      commitSubject: "fix(advisor): distinct favicon",
      commitBody: "why",
      testAdded: true,
      testOmittedReason: "",
      residualRisk: "",
      abandoned: "",
      abandonedCause: "none",
    },
    simplify: { changed: false, filesTouched: [], changes: [], declined: "nothing to remove" },
    verification: { outcome: "passed", steps: [] },
    failFirst: { outcome: "skipped", reason: "no tests changed" },
    devLens: { accurate: true, correction: "" },
    files: 1,
    lines: 4,
  };
}

const PUBLISH_ENV = { ...SOLVE_ENV, SOLVE_GITHUB_OWNER: "storebrand-digital" };

describe("buildPublishRequest", () => {
  it("names the repository from configuration, not from the checkout", () => {
    // THE PHASE D PRIVILEGE GRANT. The owner is configured because an owner
    // inferred from the checkout's remote is right until somebody adds a fork
    // as `origin`, at which point a bot opens a pull request somewhere else.
    const request = buildPublishRequest(settingsWith(PUBLISH_ENV), verifiedOutcome(), "SSX-3822");

    expect(request.repo).toBe("storebrand-digital/buy-insurance-advisor-web");
  });

  it("refuses when no owner is configured rather than guessing one", () => {
    expect(() =>
      buildPublishRequest(
        settingsWith({ ...PUBLISH_ENV, SOLVE_GITHUB_OWNER: "" }),
        verifiedOutcome(),
        "SSX-3822",
      ),
    ).toThrow(SettingsError);
  });

  it("refuses an owner that is only whitespace", () => {
    // Also `readSettings`' trimming rather than this function's. Worth pinning
    // where the consequence is: a repo of "  /name" is a pull request opened
    // against a target that does not exist, discovered by gh and not by us.
    expect(() =>
      buildPublishRequest(
        settingsWith({ ...PUBLISH_ENV, SOLVE_GITHUB_OWNER: "  " }),
        verifiedOutcome(),
        "SSX-3822",
      ),
    ).toThrow(SettingsError);
  });

  it("targets the branch the worktree was cut from, without its remote", () => {
    const request = buildPublishRequest(settingsWith(PUBLISH_ENV), verifiedOutcome(), "SSX-3822");

    expect(request.baseBranch).toBe("main");
  });

  it("carries the worktree and the commit through untouched", () => {
    const outcome = verifiedOutcome();

    const request = buildPublishRequest(settingsWith(PUBLISH_ENV), outcome, "SSX-3822");

    expect(request.worktree).toBe(outcome.worktree);
    expect(request.commit).toBe(outcome.commit);
  });

  it("composes a title and a body that name the ticket", () => {
    const request = buildPublishRequest(settingsWith(PUBLISH_ENV), verifiedOutcome(), "SSX-3822");

    expect(request.title).toContain("(SSX-3822)");
    expect(request.body).toContain("SSX-3822");
  });

  it("does not name a reviewer, so the delivery default applies", () => {
    // `exactOptionalPropertyTypes` makes absence real, and `requestReview` falls
    // back to @copilot. Passing an empty string here would ask for a reviewer
    // called "".
    expect(
      "reviewer" in buildPublishRequest(settingsWith(PUBLISH_ENV), verifiedOutcome(), "SSX-3822"),
    ).toBe(false);
  });

  it("floors the gh timeout above zero", () => {
    // Zero is a timeout that expired before the command began.
    expect(() =>
      buildPublishRequest(
        settingsWith({ ...PUBLISH_ENV, SOLVE_GH_TIMEOUT_MS: "0" }),
        verifiedOutcome(),
        "SSX-3822",
      ),
    ).toThrow();
  });

  it("commits as the configured identity", () => {
    const request = buildPublishRequest(
      settingsWith({
        ...PUBLISH_ENV,
        SOLVE_BOT_NAME: "jira-police",
        SOLVE_BOT_EMAIL: "jp@x.invalid",
      }),
      verifiedOutcome(),
      "SSX-3822",
    );

    expect(request.identity).toEqual({ name: "jira-police", email: "jp@x.invalid" });
  });
});

describe("createSolveRunDeps", () => {
  it("composes the two objects that can change something", () => {
    // This function is the phase C privilege grant. Asserting its shape is
    // asserting that the grant is exactly these two and no more.
    const deps = createSolveRunDeps(settingsWith(SOLVE_ENV));

    expect(Object.keys(deps).toSorted()).toEqual(["commands", "passes"]);
    expect(typeof deps.commands.run).toBe("function");
    expect(typeof deps.passes.run).toBe("function");
  });

  it("refuses to build a solver with no vault", () => {
    // Same reason triage refuses: the branch and commit conventions the solver
    // is held to live in the vault, and failing now beats failing four sessions
    // in on a mechanical check.
    expect(() => createSolveRunDeps(settingsWith({ ...SOLVE_ENV, VAULT_PATH: "" }))).toThrow(
      SettingsError,
    );
  });

  it("floors the per-pass timeout above zero", () => {
    expect(() =>
      createSolveRunDeps(settingsWith({ ...SOLVE_ENV, SOLVE_TIMEOUT_MS: "0" })),
    ).toThrow();
  });

  it("does not construct a solver as a side effect of reading the board", () => {
    // The queue poller runs on every cycle and needs none of this. If the two
    // were one function, reading the board would build the ability to write to
    // a repository.
    const readers = createSolveDeps(settingsWith(SOLVE_ENV), {} as JiraClient);

    expect(readers).not.toHaveProperty("commands");
    expect(readers).not.toHaveProperty("passes");
  });
});

describe("githubRepoFor", () => {
  it("joins the configured owner to the checkout's directory name", () => {
    expect(githubRepoFor(settingsWith(PUBLISH_ENV), "/repos/buy-insurance-advisor-web")).toBe(
      "storebrand-digital/buy-insurance-advisor-web",
    );
  });

  it("refuses when no owner is configured rather than guessing one", () => {
    // The single place that decides which GitHub repository this service talks
    // to. An owner inferred from a remote is right until somebody adds a fork
    // as `origin`, and then a bot is pushing to a stranger's repository.
    expect(() =>
      githubRepoFor(settingsWith({ ...PUBLISH_ENV, SOLVE_GITHUB_OWNER: "" }), "/r/x"),
    ).toThrow(SettingsError);
  });
});

/** The solve request the two review-round builders are given. */
function advanceBase(): SolveRequest {
  return buildSolveRequest(
    settingsWith(PUBLISH_ENV),
    detailWith(["svc:buy-insurance-advisor-web"]),
    "ticket text",
  );
}

const attachedWorktree = {
  issueKey: "SSX-3822",
  path: "/tmp/solve/SSX-3822",
  branch: "fix/ssx-3822-favicon",
  repoPath: "/repos/buy-insurance-advisor-web",
};

/**
 * The worktree as a promise of one, which is the shape `advance` now takes.
 *
 * It is never called in these tests, and that is the point of the type: cutting
 * a checkout is work the request describes rather than work it has already
 * done, so building a request costs nothing.
 */
const attachSource = (): Promise<WorktreeResult> =>
  Promise.resolve({ outcome: "created", worktree: attachedWorktree } as const);

describe("buildFindPrRequest", () => {
  it("searches from the repository checkout, not from a worktree", () => {
    // The order this encodes: whether a pull request exists is what decides
    // whether there is anything to attach a worktree to, so the search has to
    // be runnable before one exists.
    const request = buildFindPrRequest(
      settingsWith(PUBLISH_ENV),
      advanceBase(),
      "fix/ssx-3822-favicon",
    );

    expect(request.cwd).toBe("/repos/buy-insurance-advisor-web");
    expect(request.repo).toBe("storebrand-digital/buy-insurance-advisor-web");
    expect(request.branch).toBe("fix/ssx-3822-favicon");
  });

  it("floors the gh timeout above zero", () => {
    expect(() =>
      buildFindPrRequest(
        settingsWith({ ...PUBLISH_ENV, SOLVE_GH_TIMEOUT_MS: "0" }),
        advanceBase(),
        "fix/ssx-3822-favicon",
      ),
    ).toThrow();
  });
});

describe("buildAdvanceRequest", () => {
  it("names the repository from configuration, as publishing does", () => {
    // THE PHASE D2 PRIVILEGE GRANT. Publishing makes work visible; this pushes
    // to a pull request people are already reading, so the target is decided by
    // the same setting rather than by whatever remote the worktree carries.
    const request = buildAdvanceRequest(
      settingsWith(PUBLISH_ENV),
      advanceBase(),
      attachSource,
      2657,
    );

    expect(request.repo).toBe("storebrand-digital/buy-insurance-advisor-web");
    expect(request.number).toBe(2657);
    expect(request.attach).toBe(attachSource);
    // `gh` runs in the repository until a round is actually decided on. Every
    // read the survey makes names its repository explicitly, so this is a
    // working directory and not a target.
    expect(request.cwd).toBe("/repos/buy-insurance-advisor-web");
  });

  it("refuses when no owner is configured", () => {
    expect(() =>
      buildAdvanceRequest(
        settingsWith({ ...PUBLISH_ENV, SOLVE_GITHUB_OWNER: "" }),
        advanceBase(),
        attachSource,
        2657,
      ),
    ).toThrow(SettingsError);
  });

  it("carries the solve request's own fields through untouched", () => {
    // The review round runs the same passes against the same repository with
    // the same timeouts. A separate set of values here would mean a round that
    // verifies differently from the run that opened the pull request.
    const base = advanceBase();

    const request = buildAdvanceRequest(settingsWith(PUBLISH_ENV), base, attachSource, 1);

    expect(request.issueKey).toBe(base.issueKey);
    expect(request.repoPath).toBe(base.repoPath);
    expect(request.baseRef).toBe(base.baseRef);
    expect(request.stepTimeoutMs).toBe(base.stepTimeoutMs);
  });

  it("supplies no round count at all, because the pull request holds it", () => {
    // This test used to pin `round: 0`, and its comment said so: nothing
    // persisted a count, so `MAX_REVIEW_ITERATIONS` could not fire from the
    // command line and the operator was the only thing counting. The marker
    // replaced that, and the fix was to delete the field rather than to pass
    // the right number — a caller that cannot supply the count cannot supply a
    // wrong one. `advance` reads it off the marker comment instead.
    const request = buildAdvanceRequest(
      settingsWith({ ...PUBLISH_ENV, MAX_REVIEW_ITERATIONS: "3" }),
      advanceBase(),
      attachSource,
      1,
    );

    expect("round" in request).toBe(false);
    expect(request.maxRounds).toBe(3);
  });

  it("carries the absolute per-pull-request brake, separately from the reviewer cap", () => {
    // Two numbers, deliberately not one. Relaxing how much argument a bot
    // reviewer is worth must not be able to disable the stop on the machinery.
    const request = buildAdvanceRequest(
      settingsWith({ ...PUBLISH_ENV, MAX_REVIEW_ITERATIONS: "9", MAX_PR_ROUNDS_TOTAL: "20" }),
      advanceBase(),
      attachSource,
      1,
    );

    expect(request.maxRounds).toBe(9);
    expect(request.maxTotalRounds).toBe(20);
  });

  it("does not name a reviewer, so the delivery default applies", () => {
    expect(
      "reviewer" in buildAdvanceRequest(settingsWith(PUBLISH_ENV), advanceBase(), attachSource, 1),
    ).toBe(false);
  });

  it("commits as the configured identity", () => {
    const request = buildAdvanceRequest(
      settingsWith({
        ...PUBLISH_ENV,
        SOLVE_BOT_NAME: "jira-police",
        SOLVE_BOT_EMAIL: "jp@x.invalid",
      }),
      advanceBase(),
      attachSource,
      1,
    );

    expect(request.identity).toEqual({ name: "jira-police", email: "jp@x.invalid" });
  });
});

/**
 * Composition of the review cycle.
 *
 * The unit tests in `src/solve/review-cycle.test.ts` prove the cycle bounds its
 * spend against a fake. These prove the fake resembles what production hands it,
 * which for this cycle is the half that decides how much it can cost: the query
 * that says which pull requests are in scope, the switch, and the per-tick bound.
 */
/** Records the query and answers it, without `fakeClient`'s NOT IN routing. */
function watchClient(watched: readonly TicketRef[] = []): {
  client: JiraClient;
  queries: string[];
} {
  const queries: string[] = [];
  const client = {
    search: async (jql: string): Promise<readonly TicketRef[]> => {
      queries.push(jql);
      return watched;
    },
  } as unknown as JiraClient;
  return { client, queries };
}

/** A `look` or an `act` that must not be called, and says so if it is. */
const never = async (): Promise<never> => {
  throw new Error("not called");
};

describe("createReviewCycleDeps", () => {
  const REVIEW_ENV = { JIRA_PROJECT: "SSX", JIRA_COMPONENTS: "SSX Advisor" };

  function reviewSettings(overrides: Partial<Record<string, string>> = {}): Settings {
    return settingsWith({ ...REVIEW_ENV, ...overrides });
  }

  it("reads the watched set, not the solve queue", async () => {
    // THE ONE THAT MATTERS. Wired to `buildSolveQueueJql` this looks at tickets
    // that have no pull request at all, and `look` would report every one of
    // them as unlookable — a cycle that is busy, costs Jira round trips, and
    // never notices the merge it exists to notice.
    const { client, queries } = watchClient();

    await createReviewCycleDeps(reviewSettings(), client, never, never).fetchWatched();

    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('labels IN ("agent:reviewing", "agent:review-done")');
    expect(queries[0]).not.toContain("agent:solvable");
  });

  it("advertises the query it runs", async () => {
    const { client, queries } = watchClient();
    const deps = createReviewCycleDeps(reviewSettings(), client, never, never);

    await deps.fetchWatched();

    expect(deps.watchJql).toBe(queries[0]);
  });

  it("carries the timestamp the cycle orders on", async () => {
    // The cycle sorts oldest-updated first so the same pull request cannot be
    // starved twice by the per-tick bound. Drop `updated` in the narrowing and
    // every ticket parses as NaN, the sort becomes whatever order Jira replied
    // in, and the starvation the ordering prevents comes back silently.
    const { client } = watchClient([ticket()]);

    const watched = await createReviewCycleDeps(
      reviewSettings(),
      client,
      never,
      never,
    ).fetchWatched();

    expect(watched).toEqual([
      {
        key: "SSX-3822",
        summary: "A bug",
        url: "https://example.invalid/browse/SSX-3822",
        labels: ["agent:solvable", "agent:start", "svc:buy-insurance-advisor-web"],
        updated: "2026-09-02T09:55:34.178+0200",
      },
    ]);
  });

  it("fails closed on the master switch", () => {
    // `flag` and not `!== "false"`: an unset or mistyped SOLVE_ENABLED must not
    // arm the one loop here that pushes to a pull request unattended.
    expect(
      createReviewCycleDeps(reviewSettings(), watchClient().client, never, never).enabled,
    ).toBe(false);
    expect(
      createReviewCycleDeps(
        reviewSettings({ SOLVE_ENABLED: "true" }),
        watchClient().client,
        never,
        never,
      ).enabled,
    ).toBe(true);
  });

  it("takes the per-tick bound from its own setting", () => {
    const deps = createReviewCycleDeps(
      reviewSettings({ MAX_REVIEW_ROUNDS_PER_TICK: "1" }),
      watchClient().client,
      never,
      never,
    );

    expect(deps.maxRounds).toBe(1);
  });

  it("allows a bound of zero, which is this cycle's dry run", () => {
    // Zero must reach the cycle as zero rather than being clamped or read as
    // absent: look at everything, spend on nothing, is the honest dry run for a
    // round whose whole effect is on a pull request.
    expect(
      createReviewCycleDeps(
        reviewSettings({ MAX_REVIEW_ROUNDS_PER_TICK: "0" }),
        watchClient().client,
        never,
        never,
      ).maxRounds,
    ).toBe(0);
  });

  it("passes the caller's two halves through untouched", () => {
    // The cheap look and the paid round are the caller's, so that the loop and
    // `--advance` cannot drift into doing different things. Rebuilding either
    // here would put the spend seam in the file nobody reads.
    const look = never;
    const act = never;
    const deps = createReviewCycleDeps(reviewSettings(), watchClient().client, look, act);

    expect(deps.look).toBe(look);
    expect(deps.act).toBe(act);
  });

  it("omits the signal rather than passing undefined", () => {
    // `exactOptionalPropertyTypes` makes these two different objects, and the
    // cycle reads `signal?.aborted`. Present-but-undefined is harmless here and
    // is the shape that stops being harmless the moment anything checks the key.
    const deps = createReviewCycleDeps(reviewSettings(), watchClient().client, never, never);

    expect("signal" in deps).toBe(false);
  });

  it("carries a signal when one is given", async () => {
    const controller = new AbortController();
    const deps = createReviewCycleDeps(
      reviewSettings(),
      watchClient().client,
      never,
      never,
      controller.signal,
    );

    expect(deps.signal).toBe(controller.signal);
  });
});
