import { describe, expect, it } from "vitest";

import {
  SETTINGS,
  SettingsError,
  describeSettings,
  list,
  numeric,
  readSettings,
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
    // An empty line in a .env file is nearly always an unfilled template entry.
    expect(readSettings({ ...MINIMAL, JIRA_PROJECT: "   " }).JIRA_PROJECT).toBe("SSX");
  });

  it("reports every missing required setting at once", () => {
    // One error listing both beats discovering them one deploy at a time.
    try {
      readSettings({});
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SettingsError);
      expect((error as SettingsError).missing).toEqual(["JIRA_EMAIL", "JIRA_AUTH"]);
    }
  });

  it("does not fall back to a real skill when unconfigured", () => {
    // A misconfigured service must not be able to post genuine verdicts.
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
