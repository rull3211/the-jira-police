import { describe, expect, it } from "vitest";

import { JqlError } from "./jira/jql.ts";
import type { JiraClient } from "./jira/client.ts";
import type { TicketRef } from "./jira/types.ts";
import { type Settings, SettingsError, readSettings } from "./settings.ts";
import { buildPrompt, toolsFor } from "./triage/runner.ts";
import { runSolveCycle } from "./solve/poller.ts";
import { buildTriageOptions, createSolveDeps, shouldPost } from "./wiring.ts";

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
