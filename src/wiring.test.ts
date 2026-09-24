import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  attachReconImages,
  baseBranchOf,
  buildAdvanceRequest,
  buildFindPrRequest,
  buildPublishRequest,
  buildSolveRequest,
  buildTriageOptions,
  createDiscover,
  createPollDeps,
  createReviewCycleDeps,
  createSolveDeps,
  createSolveRunDeps,
  githubRepoFor,
  imageStageOptions,
  pollIntervalMs,
  reviewIntervalMs,
  shouldPost,
} from "./wiring.ts";

/** Minimum environment that satisfies the required settings. */
const ENV = { JIRA_EMAIL: "a@b.c", JIRA_AUTH: "placeholder" };

function settingsWith(overrides: Partial<Record<string, string>>): Settings {
  return readSettings({ ...ENV, ...overrides });
}

/** Never called: proves the off switch skips the extra Jira fetch entirely. */
function unreachableClient(): JiraClient {
  return {
    fetchDetail: async () => {
      throw new Error("fetchDetail must not be called when RECON_IMAGES is off");
    },
  } as unknown as JiraClient;
}

describe("buildTriageOptions", () => {
  it("refuses to build a real run with no vault", () => {
    // Otherwise a headless run exits 0 having answered nothing, and the service looks healthy
    // while producing no verdicts.
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
    // A fork given a vault it doesn't need loses nothing; one silently denied one wouldn't.
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
      // Sub-agents can't prompt for tool permissions, so the skill forbids them outside --deep.
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

  // "The guard is correct" and "the caller uses it" are separate facts; a floor only applies
  // where a caller asks for it.
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

  it("carries the shipped defaults through unchanged", () => {
    const options = buildTriageOptions(settingsWith({ SKILL_NAME: "mock-triage" }), "SSX-1");

    expect(options.maxRunMs).toBe(1_200_000);
    expect(options.idleMs).toBe(600_000);
  });

  it("gives the silence budget its own setting rather than deriving it", () => {
    const options = buildTriageOptions(
      settingsWith({ SKILL_NAME: "mock-triage", SESSION_IDLE_TIMEOUT_MS: "90000" }),
      "SSX-1",
    );

    // Moving one budget must not move the other: deriving idle from a fraction of the ceiling
    // would let raising the ceiling for a slow repository quietly buy a wedged pass extra time.
    expect(options.idleMs).toBe(90_000);
    expect(options.maxRunMs).toBe(1_200_000);
  });
});

describe("pollIntervalMs", () => {
  it("reads the configured cadence", () => {
    expect(pollIntervalMs(settingsWith({ POLL_INTERVAL_MS: "30000" }))).toBe(30_000);
  });

  // `--interval 0` reads like "as fast as possible", but granted it would hammer Jira until
  // something rate-limited it.
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

describe("imageStageOptions", () => {
  it("defaults the count cap to 10", () => {
    expect(imageStageOptions(settingsWith({})).maxImages).toBe(10);
  });

  it("reads an operator-raised cap", () => {
    expect(imageStageOptions(settingsWith({ MAX_STAGED_IMAGES: "25" })).maxImages).toBe(25);
  });

  it("refuses a zero cap rather than silently staging nothing", () => {
    // Zero reads as "no limit" and would behave as "already exhausted" —
    // the same shape `numeric`'s floor exists to catch elsewhere in this file.
    expect(() => imageStageOptions(settingsWith({ MAX_STAGED_IMAGES: "0" }))).toThrow(
      /MAX_STAGED_IMAGES must be at least 1/,
    );
  });

  it("leaves the byte ceiling alone, since only the count is a setting", () => {
    expect(imageStageOptions(settingsWith({ MAX_STAGED_IMAGES: "25" })).maxImageBytes).toBe(
      4 * 1024 * 1024,
    );
  });
});

describe("attachReconImages", () => {
  const request: SolveRequest = {
    issueKey: "SSX-3822",
    ticket: "ticket text",
    summary: "Distinct favicon",
    repoPath: "/repos/buy-insurance-advisor-web",
    parentDirectory: "/repos",
    baseRef: "origin/main",
    identity: { name: "jira-police", email: "jira-police@example.invalid" },
    gitTimeoutMs: 1000,
    stepTimeoutMs: 1000,
    installTimeoutMs: 1000,
  };

  it("does nothing when RECON_IMAGES is off", async () => {
    const staged = await attachReconImages(settingsWith({}), unreachableClient(), request);

    expect(staged.request).toBe(request);
    await expect(staged.cleanup()).resolves.toBeUndefined();
  });

  it("degrades to the unstaged request when the Jira fetch fails", async () => {
    // Matches `stageForTriage`: a staging failure must not fail the run, only
    // drop back to text.
    const failingClient = {
      fetchDetail: async () => {
        throw new Error("network unreachable");
      },
    } as unknown as JiraClient;

    const staged = await attachReconImages(
      settingsWith({ RECON_IMAGES: "true" }),
      failingClient,
      request,
    );

    expect(staged.request).toBe(request);
    await expect(staged.cleanup()).resolves.toBeUndefined();
  });

  it("attaches nothing, and says so honestly, when the ticket has no images", async () => {
    const client = {
      fetchDetail: async () => ({ attachments: [] }),
    } as unknown as JiraClient;

    const staged = await attachReconImages(settingsWith({ RECON_IMAGES: "true" }), client, request);

    expect(staged.request).not.toBe(request);
    expect(staged.request.images?.directory).toBeNull();
    await expect(staged.cleanup()).resolves.toBeUndefined();
  });
});

describe("reviewIntervalMs", () => {
  it("reads REVIEW_POLL_MS and not the poll cadence", () => {
    // Returning POLL_INTERVAL_MS instead would tie how fast the service answers a reviewer to
    // a setting whose description is "gap between polls".
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
    // This is the only setting whose effect is visible to the whole team.
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
      // Truthiness would make "0" and "false" enable writes to shared tickets.
      expect(real({ WRITE_BACK: value })).toBe(false);
    },
  );

  it.each(["mock-triage", "live-triage-probe"])(
    "keeps %s in preview even when WRITE_BACK is on",
    (skill) => {
      // A rehearsal that comments on a real ticket is not a rehearsal, and the probe hits a real key.
      expect(shouldPost(settingsWith({ SKILL_NAME: skill, WRITE_BACK: "true" }))).toBe(false);
    },
  );

  it("never lets the analyst write, whatever WRITE_BACK says", () => {
    // The two halves are independent: WRITE_BACK decides whether the poster is dispatched, and
    // cannot re-arm the analyst.
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
    statusId: "10165",
    statusName: "Mottatt",
    labels: ["agent:solvable", "agent:start", "svc:buy-insurance-advisor-web"],
    url: "https://example.invalid/browse/SSX-3822",
    ...overrides,
  };
}

/**
 * A stand-in for the only thing that talks to Jira, recording every query.
 *
 * Tells the two queries apart by what they ask for, since on the board they're disjoint by
 * construction. A fake returning the same rows to both would hide a wiring bug behind a
 * plausible outcome.
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
 * Composition of discovery.
 *
 * Proves two things that split apart: `TRIAGE_ONLY_STATUS` characters are rejected once, at
 * startup, and the values reach the query the poller actually runs. What none of these prove is
 * that a value resolves against the board — a well-formed, correctly spelled status name can
 * still match zero issues there, which is why the default is pinned by id.
 */
describe("createDiscover", () => {
  async function queryFor(overrides: Partial<Record<string, string>> = {}): Promise<string> {
    const { client, queries } = fakeClient();
    await createDiscover(settingsWith({ JIRA_PROJECT: "SSX", ...overrides }), client)(null);
    return queries[0] ?? "";
  }

  it("restricts the query to the configured statuses", async () => {
    expect(await queryFor({ TRIAGE_ONLY_STATUS: "Mottatt,On Hold" })).toContain(
      'status IN ("Mottatt", "On Hold")',
    );
  });

  it("ships restricted by default, because the unrestricted query was the defect", async () => {
    // If this ever reads as unrestricted, discovery silently goes back to triaging other
    // people's in-flight work — a failure that shows up as spend, not as an error.
    expect(await queryFor()).toContain("status IN (10165, 10025, 10194, 10179)");
  });

  it("pins the default statuses by id, unquoted, because the readable spelling missed 51 tickets", async () => {
    // About the quoting, not the values: quoting an id turns it back into a name lookup
    // (`jqlValue`), which is the same defect wearing the new values.
    expect(await queryFor()).not.toMatch(/status IN \([^)]*"/);
  });

  it("refuses a status that would break out of its JQL literal, at wiring", async () => {
    // At construction, not on the first cycle: without the check here, this input is an error
    // every poll for the life of the process.
    expect(() =>
      createDiscover(settingsWith({ TRIAGE_ONLY_STATUS: 'Mottatt") OR ("x' }), fakeClient().client),
    ).toThrow(JqlError);
  });
});

/**
 * Composition of the grooming cycle.
 *
 * `byStatusPriority` and the poller's own comparator handling are each tested elsewhere; the
 * only thing neither proves is whether the setting reaches either of them, so an ordering that
 * is correct and never wired up would be invisible from both sides.
 */
describe("createPollDeps", () => {
  const client = fakeClient().client;

  it("wires no comparator at all when no priority is configured", () => {
    // Not "wires a created-ascending comparator": the poller already defaults to that, and
    // passing one anyway would make `poll.order` fire for an operator who never asked for one.
    expect(createPollDeps(settingsWith({ TRIAGE_STATUS_PRIORITY: "" }), client).order).toBe(
      undefined,
    );
  });

  it("wires the configured order through to the cycle", () => {
    const deps = createPollDeps(settingsWith({ TRIAGE_STATUS_PRIORITY: "10025,10165" }), client);

    const mottatt = ticket({ key: "SSX-1", statusId: "10165", statusName: "Mottatt" });
    const backlog = ticket({ key: "SSX-2", statusId: "10025", statusName: "Backlog" });

    expect(deps.order).toBeDefined();
    expect([mottatt, backlog].toSorted(deps.order).map((t) => t.key)).toEqual(["SSX-2", "SSX-1"]);
  });
});

/**
 * Composition of the solve queue.
 *
 * `src/solve/poller.test.ts` proves the cycle behaves against a fake; these prove the fake
 * resembles what production hands it — the half where a wiring mistake is invisible because
 * every component still passes its own tests.
 */
describe("createSolveDeps", () => {
  const SOLVE_ENV = { JIRA_PROJECT: "SSX", JIRA_COMPONENTS: "SSX Advisor" };

  function solveSettings(overrides: Partial<Record<string, string>> = {}): Settings {
    return settingsWith({ ...SOLVE_ENV, ...overrides });
  }

  it("carries the labels and the timestamp the queue selects on", async () => {
    // `labels` is the queue's entire state; dropped here, every ticket would be skipped with a
    // plausible-looking reason and no sign anything was wrong.
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
    // The queue excludes agent:solving, so counting in-flight work from the queue result would
    // count zero forever and cap nothing.
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
    // Wired to the wrong query this returns 0 forever, since the queue excludes the claim label.
    const { client } = fakeClient(
      [ticket({ key: "SSX-1" })],
      [ticket({ key: "SSX-2" }), ticket({ key: "SSX-3" })],
    );

    expect(await createSolveDeps(solveSettings(), client).countInFlight()).toBe(2);
  });

  it("has no function capable of writing", () => {
    // Phase B's refusal is structural, not promised: there is nothing to call.
    const deps = createSolveDeps(solveSettings(), fakeClient().client);

    const callable = Object.entries(deps)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name);

    expect(callable.toSorted()).toEqual(["countInFlight", "fetchQueue"]);
  });

  it("advertises the same queries it runs", async () => {
    // The cycle report prints these as the explanation for its numbers, which only holds if
    // the advertised query is the executed one and not a second rendering that could disagree.
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
    // Not by falling back: a typo'd mode is an operator believing something false about this
    // service, and the cheapest place to correct that is at startup.
    expect(() =>
      createSolveDeps(solveSettings({ SOLVE_MODE: "atuo" }), fakeClient().client),
    ).toThrow(SettingsError);
  });

  it("builds both queries eagerly, so a bad one fails at startup", async () => {
    // Deferred into the closures, this would fail on whichever cycle first reaches the board,
    // by which time nobody is watching startup.
    expect(() =>
      createSolveDeps(solveSettings({ JIRA_PROJECT: 'X" OR "1"="1' }), fakeClient().client),
    ).toThrow(JqlError);
  });

  it("cannot be blanked into unrestricted auto mode", () => {
    // `SOLVE_AUTO_ISSUE_TYPES=` never reaches the poller as an empty list — `readSettings`
    // substitutes the fallback, and the fallback IS the restriction.
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
    // The reason SOLVE_REPOS has no fallback: `readSettings` can't tell blank from unset, so
    // a default would be a write privilege that survives being deleted from .env.
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
    // The empty list has to mean something by the time it reaches the poller: nothing is
    // planned, and the reason names the setting rather than the ticket.
    const deps = createSolveDeps(
      solveSettings({ SOLVE_ENABLED: "true" }),
      fakeClient([ticket()]).client,
    );

    const outcome = await runSolveCycle(deps);

    expect(outcome.planned).toEqual([]);
    expect(outcome.skipped[0]?.reason).toContain("SOLVE_REPOS is empty");
  });

  it("plans a claim end to end once the repository is allowed", async () => {
    // Exercised the way `solve:once` will: real settings, real queries, a fake only at the
    // HTTP boundary.
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
    // Same shape as `createPollDeps`: `exactOptionalPropertyTypes` makes the absence real.
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

  it("commits as the configured identity", () => {
    // The commit ahead of a repair round is made inside the pipeline, before `publish` runs.
    const request = buildSolveRequest(
      settingsWith({
        ...SOLVE_ENV,
        SOLVE_BOT_NAME: "jira-police",
        SOLVE_BOT_EMAIL: "jp@x.invalid",
      }),
      detailWith(["svc:buy-insurance-advisor-web"]),
      "ticket text",
    );

    expect(request.identity).toEqual({ name: "jira-police", email: "jp@x.invalid" });
  });

  it("allows dependency bumps unless DEPENDENCY_BUMPS says otherwise, and a typo turns them off", () => {
    const bumps = (value: string | undefined) =>
      buildSolveRequest(
        settingsWith(value === undefined ? SOLVE_ENV : { ...SOLVE_ENV, DEPENDENCY_BUMPS: value }),
        detailWith(["svc:buy-insurance-advisor-web"]),
        "ticket text",
      ).dependencyBumps;

    expect(bumps(undefined)).toBe(true);
    expect(bumps("true")).toBe(true);
    expect(bumps("false")).toBe(false);
    expect(bumps("ture")).toBe(false);
  });

  it("refuses a repository that is not on the allowlist", () => {
    // Refused here rather than discovered after four model sessions.
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
    // `repoFromLabels` resolves every ambiguous reading to null; both ends are refusals here.
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

  it("resolves the readable checkouts under the same root the write repo comes from", () => {
    // Resolved here rather than passed through, so nothing downstream sees an operator-supplied
    // string that isn't a path this function built.
    const request = buildSolveRequest(
      settingsWith({ ...SOLVE_ENV, SOLVE_READ_DIRS: "commerce-rest-api, buy-insurance-web" }),
      detailWith(["svc:buy-insurance-advisor-web"]),
      "t",
    );

    expect(request.readDirs).toEqual(["/repos/commerce-rest-api", "/repos/buy-insurance-web"]);
  });

  it("does not list the repository being solved among the ones to read", () => {
    // Naming it here would tell a write pass that its own dirty, feature-branch working copy
    // is part of its context.
    const request = buildSolveRequest(
      settingsWith({
        ...SOLVE_ENV,
        SOLVE_READ_DIRS: "buy-insurance-advisor-web, commerce-rest-api",
      }),
      detailWith(["svc:buy-insurance-advisor-web"]),
      "t",
    );

    expect(request.readDirs).toEqual(["/repos/commerce-rest-api"]);
  });

  it("drops a name that is not a repository name rather than joining it onto the root", () => {
    // `join("/repos", "../..")` is a directory above the root, and these paths reach `--add-dir`.
    const request = buildSolveRequest(
      settingsWith({ ...SOLVE_ENV, SOLVE_READ_DIRS: "../.., /etc, commerce-rest-api" }),
      detailWith(["svc:buy-insurance-advisor-web"]),
      "t",
    );

    expect(request.readDirs).toEqual(["/repos/commerce-rest-api"]);
  });

  it("reads no other checkout at all when the setting is unset", () => {
    // The same no-fallback rule `SOLVE_REPOS` has, for the same reason.
    const request = buildSolveRequest(
      settingsWith(SOLVE_ENV),
      detailWith(["svc:buy-insurance-advisor-web"]),
      "t",
    );

    expect(request.readDirs).toEqual([]);
  });

  it("puts the worktree somewhere that is obviously not the repository", () => {
    // A failed run keeps its worktree for inspection; it must not sit inside a checkout
    // somebody works in.
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
    // A real directory, not a made-up one: this function creates and resolves what it's
    // handed, so a fake path would pass only because the permission error is caught.
    const configured = mkdtempSync(join(realpathSync(tmpdir()), "wiring-root-"));
    const request = buildSolveRequest(
      settingsWith({ ...SOLVE_ENV, SOLVE_WORKTREE_ROOT: configured }),
      detailWith(["svc:buy-insurance-advisor-web"]),
      "t",
    );

    expect(request.parentDirectory).toBe(configured);
  });

  it("resolves the root, because git prints resolved paths and we compare strings", () => {
    // `worktree.ts` matches recovery paths by string equality against what `git worktree
    // list --porcelain` prints, which is always resolved — an unresolved root would never match.
    const real = mkdtempSync(join(realpathSync(tmpdir()), "wiring-real-"));
    const link = `${real}-link`;
    symlinkSync(real, link);

    const request = buildSolveRequest(
      settingsWith({ ...SOLVE_ENV, SOLVE_WORKTREE_ROOT: link }),
      detailWith(["svc:buy-insurance-advisor-web"]),
      "t",
    );

    expect(request.parentDirectory).toBe(real);
    expect(request.parentDirectory).not.toBe(link);
  });

  it("treats whitespace as unset rather than as a directory named space", () => {
    // The trimming is `readSettings`', not this function's; a worktree root of "   " would
    // otherwise create a directory nobody can find.
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
    // `release/origin/x` must not be mangled; `origin/origin/x` means branch `origin/x` on
    // remote `origin`.
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
    bumps: [],
  };
}

const PUBLISH_ENV = { ...SOLVE_ENV, SOLVE_GITHUB_OWNER: "storebrand-digital" };

describe("buildPublishRequest", () => {
  it("names the repository from configuration, not from the checkout", () => {
    // The phase D privilege grant. An owner inferred from the checkout's remote is right until
    // somebody adds a fork as `origin`, at which point a bot opens a pull request elsewhere.
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
    // `readSettings`' trimming, not this function's: an untrimmed owner would open a PR
    // against a target that doesn't exist, discovered by gh rather than by us.
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

  it("carries the bound on attempts that never became rounds", () => {
    // Counts a different thing from the other two caps: those are read off the marker, which
    // only moves when a round reserves, so neither sees an attempt that died before reserving.
    const request = buildAdvanceRequest(
      settingsWith({ ...PUBLISH_ENV, MAX_FAILED_STARTS: "5" }),
      advanceBase(),
      attachSource,
      1,
    );

    expect(request.maxFailedStarts).toBe(5);
  });

  it("does not name a reviewer, so the delivery default applies", () => {
    // `exactOptionalPropertyTypes` makes absence real; passing an empty string instead would
    // ask for a reviewer called "".
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
    // The phase C privilege grant: asserting its shape asserts the grant is exactly these two.
    const deps = createSolveRunDeps(settingsWith(SOLVE_ENV));

    expect(Object.keys(deps).toSorted()).toEqual(["commands", "passes"]);
    expect(typeof deps.commands.run).toBe("function");
    expect(typeof deps.passes.run).toBe("function");
  });

  it("refuses to build a solver with no vault", () => {
    // Same reason triage refuses: failing now beats failing four sessions in on a mechanical check.
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
    // If the two were one function, reading the board would build the ability to write to a repo.
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
    // An owner inferred from a remote is right until somebody adds a fork as `origin`, and
    // then a bot pushes to a stranger's repository.
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
 * The worktree as a promise of one, which is the shape `advance` takes.
 *
 * Never called in these tests, which is the point: cutting a checkout is work the request
 * describes rather than work it has already done, so building a request costs nothing.
 */
const attachSource = (): Promise<WorktreeResult> =>
  Promise.resolve({ outcome: "created", worktree: attachedWorktree } as const);

describe("buildFindPrRequest", () => {
  it("searches from the repository checkout, not from a worktree", () => {
    // Whether a pull request exists decides whether there's anything to attach a worktree to,
    // so the search must be runnable before one exists.
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
    // The phase D2 privilege grant: this pushes to a pull request people are already reading,
    // so the target is decided by the same setting rather than by whatever remote the worktree
    // carries.
    const request = buildAdvanceRequest(
      settingsWith(PUBLISH_ENV),
      advanceBase(),
      attachSource,
      2657,
    );

    expect(request.repo).toBe("storebrand-digital/buy-insurance-advisor-web");
    expect(request.number).toBe(2657);
    expect(request.attach).toBe(attachSource);
    // A working directory, not a target: every read the survey makes names its repository
    // explicitly.
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
    // A separate set of values here would mean a round that verifies differently from the run
    // that opened the pull request.
    const base = advanceBase();

    const request = buildAdvanceRequest(settingsWith(PUBLISH_ENV), base, attachSource, 1);

    expect(request.issueKey).toBe(base.issueKey);
    expect(request.repoPath).toBe(base.repoPath);
    expect(request.baseRef).toBe(base.baseRef);
    expect(request.stepTimeoutMs).toBe(base.stepTimeoutMs);
  });

  it("supplies no round count at all, because the pull request holds it", () => {
    // The field is deleted rather than given the right number: a caller that cannot supply
    // the count cannot supply a wrong one. `advance` reads it off the marker comment instead.
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
    // Two numbers, deliberately not one: relaxing how much argument a bot reviewer gets must
    // not disable the stop on the machinery.
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
 * `src/solve/review-cycle.test.ts` proves the cycle bounds its spend against a fake; these
 * prove the fake resembles what production hands it: the query, the switch, the per-tick bound.
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
    // Wired to `buildSolveQueueJql` instead, this looks at tickets with no pull request at
    // all, and `look` would report every one as unlookable.
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
    // The cycle sorts oldest-updated first so a pull request can't be starved twice by the
    // per-tick bound; drop `updated` here and every ticket parses as NaN.
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
    // `flag`, not `!== "false"`: an unset or mistyped SOLVE_ENABLED must not arm the one loop
    // here that pushes to a pull request unattended.
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
    // Zero must reach the cycle as zero, not clamped or read as absent: look at everything,
    // spend on nothing.
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
    // The caller's, so the loop and `--advance` cannot drift into doing different things.
    const look = never;
    const act = never;
    const deps = createReviewCycleDeps(reviewSettings(), watchClient().client, look, act);

    expect(deps.look).toBe(look);
    expect(deps.act).toBe(act);
  });

  it("omits the signal rather than passing undefined", () => {
    // `exactOptionalPropertyTypes` makes these two different objects; present-but-undefined
    // stops being harmless the moment anything checks the key.
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
