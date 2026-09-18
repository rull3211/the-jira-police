import { describe, expect, it } from "vitest";

import type { IssueDetail } from "../jira/client.ts";
import { type Settings, SettingsError, readSettings } from "../settings.ts";
import { requestOrRefusal } from "./recon-once.ts";

const ENV = { JIRA_EMAIL: "a@b.c", JIRA_AUTH: "placeholder" };

const SOLVE_ENV = {
  VAULT_PATH: "/vault",
  SOLVE_REPO_ROOT: "/repos",
  SOLVE_REPOS: "buy-insurance-advisor-web",
};

function settingsWith(overrides: Partial<Record<string, string>>): Settings {
  return readSettings({ ...ENV, ...SOLVE_ENV, ...overrides });
}

function detailWith(labels: readonly string[]): IssueDetail {
  return {
    key: "SSX-4001",
    summary: "Favicon is missing on the advisor page",
    issueTypeName: "Bug",
    status: "Mottatt",
    labels,
    description: undefined,
    comments: [],
    attachments: [],
    url: "https://example.invalid/browse/SSX-4001",
  };
}

describe("requestOrRefusal", () => {
  it("builds the request for a ticket that names one allowed repository", () => {
    const request = requestOrRefusal(
      settingsWith({}),
      detailWith(["svc:buy-insurance-advisor-web"]),
      "ticket text",
    );

    expect(request?.repoPath).toBe("/repos/buy-insurance-advisor-web");
    expect(request?.issueKey).toBe("SSX-4001");
  });

  it("refuses a repository that is not on the allowlist, without throwing", () => {
    const request = requestOrRefusal(
      settingsWith({}),
      detailWith(["svc:some-other-repo"]),
      "ticket text",
    );

    expect(request).toBeNull();
    expect(process.exitCode).toBe(3);
    process.exitCode = 0;
  });

  it("refuses a ticket that names no repository, or two, the same way", () => {
    for (const labels of [[], ["triaged"], ["svc:one", "svc:two"]]) {
      const request = requestOrRefusal(settingsWith({}), detailWith(labels), "ticket text");
      expect(request).toBeNull();
      process.exitCode = 0;
    }
  });

  it("lets a configuration fault propagate rather than reporting it as a refusal", () => {
    // A missing SOLVE_REPO_ROOT is a fault in the operator's configuration,
    // not a fact about the ticket, and reporting it as "refusing" would send
    // a person looking at the wrong thing.
    expect(() =>
      requestOrRefusal(
        settingsWith({ SOLVE_REPO_ROOT: "" }),
        detailWith(["svc:buy-insurance-advisor-web"]),
        "ticket text",
      ),
    ).toThrow(SettingsError);
  });
});
