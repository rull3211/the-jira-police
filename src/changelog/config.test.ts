import { describe, expect, it } from "vitest";

import { SettingsError, readSettings } from "../settings.ts";
import { readChangelogSettings } from "./config.ts";

const settingsWith = (extra: Record<string, string> = {}) =>
  readSettings({ JIRA_EMAIL: "a@b.c", JIRA_AUTH: "placeholder", ...extra });

/** What `.env` sets for the SSX Advisor team. */
const THIS_TEAM = {
  CHANGELOG_COMPONENT: "SSX Advisor",
  CHANGELOG_TEAM_ID: "3536e3e8-eddf-4306-9991-173a45afc8a2",
  CHANGELOG_GITHUB_ORG: "storebrand-digital",
  CHANGELOG_REPOS:
    "advisor-web=buy-insurance-advisor-web,edh2-admin,commerce-rest=insurance-commerce-rest-api,ssx-mono-repo=insurance-ssx-mono-repo",
  CHANGELOG_WEBAPPS: "advisor-web,edh2-admin",
};

const problemsOf = (extra: Record<string, string>): string => {
  try {
    readChangelogSettings(settingsWith(extra));
  } catch (error) {
    if (error instanceof SettingsError) {
      return error.message;
    }
    throw error;
  }
  return "";
};

describe("readChangelogSettings", () => {
  it("reads a team's configuration into a component, a team, repositories and web apps", () => {
    const read = readChangelogSettings(settingsWith(THIS_TEAM));
    expect(read).toMatchObject({
      project: "SSX",
      component: "SSX Advisor",
      teamId: "3536e3e8-eddf-4306-9991-173a45afc8a2",
      label: "SSX Advisor",
      jiraBase: "https://storebrand.atlassian.net/browse/",
      org: "storebrand-digital",
    });
    expect(read.repos.map((r) => [r.name, r.full, r.kind])).toEqual([
      ["advisor-web", "buy-insurance-advisor-web", "web"],
      ["edh2-admin", "edh2-admin", "web"],
      ["commerce-rest", "insurance-commerce-rest-api", "service"],
      ["ssx-mono-repo", "insurance-ssx-mono-repo", "service"],
    ]);
  });

  it("lets each web app be chosen separately, and another team set every part", () => {
    const read = readChangelogSettings(
      settingsWith({
        JIRA_PROJECT: "ABC",
        JIRA_BASE_URL: "https://acme.atlassian.net/",
        CHANGELOG_TEAM_ID: "11111111-2222-3333-4444-555555555555",
        CHANGELOG_GITHUB_ORG: "acme",
        CHANGELOG_REPOS: "site=acme-site, api",
        CHANGELOG_WEBAPPS: "site",
      }),
    );
    expect(read).toMatchObject({
      project: "ABC",
      component: null,
      label: "ABC",
      jiraBase: "https://acme.atlassian.net/browse/",
      org: "acme",
    });
    expect(read.repos).toEqual([
      { name: "site", full: "acme-site", kind: "web" },
      { name: "api", full: "api", kind: "service" },
    ]);
  });

  it("carries nothing over from another team: with nothing configured it refuses", () => {
    // A fallback on the component or the team would put this team's scope in another team's query.
    expect(problemsOf({})).toMatch(/CHANGELOG_COMPONENT or CHANGELOG_TEAM_ID/u);
  });

  it("carries nothing over in the repositories, web apps or organisation either", () => {
    // A fallback on any of them would send another team's lookups to this team's repositories.
    expect(problemsOf({ CHANGELOG_COMPONENT: "X" })).toMatch(/CHANGELOG_GITHUB_ORG/u);
    const read = readChangelogSettings(
      settingsWith({ CHANGELOG_COMPONENT: "X", CHANGELOG_GITHUB_ORG: "acme" }),
    );
    expect(read.repos).toEqual([]);
    expect(read.label).toBe("X");
  });

  it("refuses a team given by name, which Jira would answer with nothing", () => {
    expect(problemsOf({ ...THIS_TEAM, CHANGELOG_TEAM_ID: "SSX Advisor" })).toMatch(
      /UUID, not its name/u,
    );
  });

  it("refuses a web app that is not a listed repository", () => {
    // The plausible wrong version drops the name silently and the filter shows one web app fewer.
    expect(problemsOf({ ...THIS_TEAM, CHANGELOG_WEBAPPS: "advisor-web,typo-web" })).toMatch(
      /typo-web is not in CHANGELOG_REPOS/u,
    );
  });

  it("refuses a malformed repository, a repeated alias and a bad organisation", () => {
    expect(
      problemsOf({ ...THIS_TEAM, CHANGELOG_REPOS: "ok,bad name", CHANGELOG_WEBAPPS: "" }),
    ).toMatch(/expected alias=repository/u);
    expect(problemsOf({ ...THIS_TEAM, CHANGELOG_REPOS: "a=x,a=y", CHANGELOG_WEBAPPS: "" })).toMatch(
      /a is listed twice/u,
    );
    expect(problemsOf({ ...THIS_TEAM, CHANGELOG_GITHUB_ORG: "ac me" })).toMatch(
      /CHANGELOG_GITHUB_ORG/u,
    );
  });

  it("refuses a repository or organisation that is a path or a flag, not only one with odd characters", () => {
    // `..` is made of legal characters, and `-x` would be read by gh as an option.
    for (const repos of ["..", "-x", "a=..", "a=-x"]) {
      expect(
        problemsOf({ ...THIS_TEAM, CHANGELOG_REPOS: repos, CHANGELOG_WEBAPPS: "" }),
        repos,
      ).toMatch(/expected alias=repository/u);
    }
    expect(problemsOf({ ...THIS_TEAM, CHANGELOG_GITHUB_ORG: "-x" })).toMatch(
      /CHANGELOG_GITHUB_ORG/u,
    );
  });

  it("reports every problem at once", () => {
    expect(
      problemsOf({
        CHANGELOG_TEAM_ID: "nope",
        CHANGELOG_WEBAPPS: "ghost",
        CHANGELOG_GITHUB_ORG: "a b",
      }),
    ).toMatch(/CHANGELOG_TEAM_ID[\s\S]*CHANGELOG_GITHUB_ORG[\s\S]*ghost/u);
  });
});
