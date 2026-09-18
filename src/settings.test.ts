import { describe, expect, it } from "vitest";

import {
  SETTINGS,
  SettingsError,
  describeSettings,
  failFirstCheck,
  flag,
  list,
  numeric,
  readSettings,
  solveMode,
} from "./settings.ts";

/** Minimal environment that satisfies every required setting. */
const MINIMAL = {
  JIRA_EMAIL: "someone@example.com",
  JIRA_AUTH: "placeholder-value",
} satisfies NodeJS.ProcessEnv;

describe("readSettings", () => {
  it("applies fallbacks for everything not supplied", () => {
    const settings = readSettings(MINIMAL);

    expect(settings.JIRA_PROJECT).toBe("SSX");
    expect(settings.JIRA_BASE_URL).toBe("https://storebrand.atlassian.net");
    expect(settings.POLL_INTERVAL_MS).toBe("300000");
  });

  it("prefers a supplied value over the fallback", () => {
    expect(readSettings({ ...MINIMAL, JIRA_PROJECT: "ABC" }).JIRA_PROJECT).toBe("ABC");
  });

  it("trims surrounding whitespace", () => {
    expect(readSettings({ ...MINIMAL, JIRA_PROJECT: "  ABC  " }).JIRA_PROJECT).toBe("ABC");
  });

  it("treats a blank value as absent, not as a deliberate empty string", () => {
    expect(readSettings({ ...MINIMAL, JIRA_PROJECT: "   " }).JIRA_PROJECT).toBe("SSX");
  });

  it("reports every missing required setting at once", () => {
    try {
      readSettings({});
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SettingsError);
      expect((error as SettingsError).missing).toEqual(["JIRA_EMAIL", "JIRA_AUTH"]);
    }
  });

  it("does not fall back to a real skill when unconfigured", () => {
    expect(readSettings(MINIMAL).SKILL_NAME).toBe("mock-triage");
  });

  it("excludes sub-tasks by default", () => {
    expect(readSettings(MINIMAL).JIRA_EXCLUDED_TYPES).toBe("10009");
  });
});

describe("describeSettings", () => {
  it("never reveals a sensitive value", () => {
    const described = describeSettings(readSettings(MINIMAL));

    expect(described["JIRA_AUTH"]).toBe("<redacted>");
    expect(Object.values(described)).not.toContain(MINIMAL.JIRA_AUTH);
    expect(JSON.stringify(described)).not.toContain(MINIMAL.JIRA_AUTH);
  });

  it("shows non-sensitive values in the clear for diagnostics", () => {
    expect(describeSettings(readSettings(MINIMAL))["JIRA_PROJECT"]).toBe("SSX");
  });

  it("covers every declared setting", () => {
    const described = describeSettings(readSettings(MINIMAL));
    expect(Object.keys(described)).toHaveLength(SETTINGS.length);
  });
});

describe("numeric", () => {
  it("parses a numeric setting", () => {
    expect(numeric(readSettings(MINIMAL), "POLL_INTERVAL_MS")).toBe(300_000);
  });

  it("rejects a non-numeric value rather than yielding NaN", () => {
    const settings = readSettings({ ...MINIMAL, POLL_INTERVAL_MS: "soon" });
    expect(() => numeric(settings, "POLL_INTERVAL_MS")).toThrow(/must be a number/);
  });

  // A negative delay isn't caught by the NaN check; setTimeout clamps it to zero and fires at once.
  it("rejects a negative value, which is finite and still nonsense", () => {
    const settings = readSettings({ ...MINIMAL, POLL_INTERVAL_MS: "-1" });
    expect(() => numeric(settings, "POLL_INTERVAL_MS")).toThrow(/must be at least 0/);
  });

  it("names the setting and the floor, so the message identifies the typo", () => {
    const settings = readSettings({ ...MINIMAL, TRIAGE_TIMEOUT_MS: "0" });
    expect(() => numeric(settings, "TRIAGE_TIMEOUT_MS", 1)).toThrow(
      /Setting TRIAGE_TIMEOUT_MS must be at least 1, got 0/,
    );
  });

  it("allows zero where zero is a legitimate choice", () => {
    const settings = readSettings({ ...MINIMAL, MAX_CONCURRENT_SOLVES: "0" });
    expect(numeric(settings, "MAX_CONCURRENT_SOLVES")).toBe(0);
  });

  it("accepts a value sitting exactly on the floor", () => {
    const settings = readSettings({ ...MINIMAL, TRIAGE_TIMEOUT_MS: "1" });
    expect(numeric(settings, "TRIAGE_TIMEOUT_MS", 1)).toBe(1);
  });
});

describe("shipped fallbacks", () => {
  // Catches a fallback typed with a stray minus or a stray "ms" that would otherwise leave
  // this suite green and break a deployment with no .env at all.
  it("every default parses and clears the floor its caller uses", () => {
    const settings = readSettings(MINIMAL);
    expect(numeric(settings, "TRIAGE_TIMEOUT_MS", 1)).toBe(1_200_000);
    expect(numeric(settings, "POLL_INTERVAL_MS", 1)).toBeGreaterThan(0);
    expect(numeric(settings, "CURSOR_OVERLAP_MS")).toBeGreaterThanOrEqual(0);
    expect(numeric(settings, "FIRST_RUN_LOOKBACK_MINUTES")).toBeGreaterThanOrEqual(0);
    expect(numeric(settings, "MAX_CONCURRENT_SOLVES")).toBeGreaterThanOrEqual(0);
    expect(numeric(settings, "MAX_REVIEW_ITERATIONS")).toBeGreaterThanOrEqual(0);
  });
});

describe("list", () => {
  it("splits, trims and drops empties", () => {
    const settings = readSettings({
      ...MINIMAL,
      JIRA_EXCLUDED_TYPES: " 10009 , 10007 ,, ",
    });
    expect(list(settings, "JIRA_EXCLUDED_TYPES")).toEqual(["10009", "10007"]);
  });
});

/** The solve queue's control plane; every one of these must be safe when nobody has said anything. */
describe("the solve settings", () => {
  it("is off unless somebody turned it on", () => {
    expect(flag(readSettings(MINIMAL), "SOLVE_ENABLED")).toBe(false);
  });

  it.each(["", "  ", "yes", "1", "on", "ture", "false"])(
    "reads %j as off, because only true may arm it",
    (value) => {
      expect(flag(readSettings({ ...MINIMAL, SOLVE_ENABLED: value }), "SOLVE_ENABLED")).toBe(false);
    },
  );

  it("arms only on an explicit true", () => {
    expect(flag(readSettings({ ...MINIMAL, SOLVE_ENABLED: "true" }), "SOLVE_ENABLED")).toBe(true);
  });

  it("checks fail-first unless somebody turned it off", () => {
    // On by default: it grants nothing, so the safe direction is the opposite of its neighbours'.
    expect(failFirstCheck(readSettings(MINIMAL))).toBe(true);
  });

  it.each(["", "  ", "no", "0", "flase", "off", "true"])(
    "keeps checking on %j, because only false may withdraw it",
    (value) => {
      // Deliberately not `flag()`: a typo here must not silently withdraw a guard.
      expect(failFirstCheck(readSettings({ ...MINIMAL, FAIL_FIRST_CHECK: value }))).toBe(true);
    },
  );

  it.each(["false", "FALSE", " false "])("turns off on an explicit %j", (value) => {
    expect(failFirstCheck(readSettings({ ...MINIMAL, FAIL_FIRST_CHECK: value }))).toBe(false);
  });

  it("defaults to manual, so a solve waits for a human", () => {
    expect(solveMode(readSettings(MINIMAL))).toBe("manual");
  });

  it("reads an explicit auto", () => {
    expect(solveMode(readSettings({ ...MINIMAL, SOLVE_MODE: "auto" }))).toBe("auto");
  });

  it.each(["atuo", "AUTOMATIC", "on", "yes", "0", "manual auto"])(
    "refuses %j rather than guessing",
    (value) => {
      // Not a silent fallback to manual: that would run a mode the operator can't see.
      const settings = readSettings({ ...MINIMAL, SOLVE_MODE: value });
      expect(() => solveMode(settings)).toThrow(SettingsError);
      expect(() => solveMode(settings)).toThrow(/SOLVE_MODE/);
    },
  );

  it("never resolves an unreadable mode to auto", () => {
    for (const value of ["atuo", "AUTOMATIC", "on"]) {
      const settings = readSettings({ ...MINIMAL, SOLVE_MODE: value });
      let resolved: string | null = null;
      try {
        resolved = solveMode(settings);
      } catch {
        resolved = null;
      }
      expect(resolved).not.toBe("auto");
    }
  });

  it("names the setting and quotes the value it could not read", () => {
    try {
      solveMode(readSettings({ ...MINIMAL, SOLVE_MODE: "atuo" }));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as SettingsError).message).toContain("atuo");
    }
  });

  it("reports the mode as a configuration problem, so it exits 78 rather than crashing", () => {
    // `withConfigErrors` keys on SettingsError; anything else reaches the operator as a stack trace.
    expect(() => solveMode(readSettings({ ...MINIMAL, SOLVE_MODE: "atuo" }))).toThrow(
      SettingsError,
    );
  });

  it("allows no repository out of the box", () => {
    // No fallback: since `readSettings` can't tell blank from unset, a default would survive
    // being deleted from .env.
    expect(list(readSettings(MINIMAL), "SOLVE_REPOS")).toEqual([]);
  });

  it("reads a blank allowlist as an empty list, which the poller reads as nothing", () => {
    expect(list(readSettings({ ...MINIMAL, SOLVE_REPOS: " , " }), "SOLVE_REPOS")).toEqual([]);
    expect(list(readSettings({ ...MINIMAL, SOLVE_REPOS: "" }), "SOLVE_REPOS")).toEqual([]);
  });

  it("still takes an allowlist when one is configured", () => {
    expect(
      list(readSettings({ ...MINIMAL, SOLVE_REPOS: "buy-insurance-advisor-web" }), "SOLVE_REPOS"),
    ).toEqual(["buy-insurance-advisor-web"]);
  });

  it("defaults to one solve at a time and three review rounds", () => {
    const settings = readSettings(MINIMAL);
    expect(numeric(settings, "MAX_CONCURRENT_SOLVES")).toBe(1);
    expect(numeric(settings, "MAX_REVIEW_ITERATIONS")).toBe(3);
  });
});

describe("RECON_IMAGES", () => {
  it("is off unless somebody turned it on", () => {
    // The picture reaches a live pass, not a dry run, so this fails closed the
    // same way TRIAGE_IMAGES and WRITE_BACK do.
    expect(flag(readSettings(MINIMAL), "RECON_IMAGES")).toBe(false);
  });

  it.each(["", "  ", "yes", "1", "on", "ture", "false"])(
    "reads %j as off, because only true may arm it",
    (value) => {
      expect(flag(readSettings({ ...MINIMAL, RECON_IMAGES: value }), "RECON_IMAGES")).toBe(false);
    },
  );

  it("arms only on an explicit true", () => {
    expect(flag(readSettings({ ...MINIMAL, RECON_IMAGES: "true" }), "RECON_IMAGES")).toBe(true);
  });
});
