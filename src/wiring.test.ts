import { describe, expect, it } from "vitest";

import { type Settings, SettingsError, readSettings } from "./settings.ts";
import { buildTriageOptions } from "./wiring.ts";

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
      noWrite: true,
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

describe("buildTriageOptions and WRITE_BACK", () => {
  function real(overrides: Partial<Record<string, string>> = {}) {
    return buildTriageOptions(
      settingsWith({ SKILL_NAME: "intake-triage", VAULT_PATH: "/vaults/v", ...overrides }),
      "SSX-1",
    );
  }

  it("does not write back unless asked", () => {
    // The default matters more than usual here: this is the only setting whose
    // effect is visible to the whole team.
    expect(real().noWrite).toBe(true);
  });

  it("writes back when the setting is true", () => {
    expect(real({ WRITE_BACK: "true" }).noWrite).toBe(false);
  });

  it.each(["TRUE", "True", " true "])("accepts %o, since .env values arrive untidy", (value) => {
    expect(real({ WRITE_BACK: value }).noWrite).toBe(false);
  });

  it.each(["yes", "1", "on", "", "  ", "no", "maybe"])(
    "fails closed on %o rather than guessing",
    (value) => {
      // Truthiness would make "0" and "false" enable writes. A setting that
      // posts to shared tickets is the wrong place to be generous.
      expect(real({ WRITE_BACK: value }).noWrite).toBe(true);
    },
  );

  it.each(["mock-triage", "live-triage-probe"])(
    "keeps %s in preview even when WRITE_BACK is on",
    (skill) => {
      // Both exist to rehearse the pipeline. A rehearsal that comments on a
      // real ticket is not a rehearsal — and the probe does hit a real key.
      const options = buildTriageOptions(
        settingsWith({ SKILL_NAME: skill, WRITE_BACK: "true" }),
        "SSX-1",
      );

      expect(options.noWrite).toBe(true);
    },
  );
});
