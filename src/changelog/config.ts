import { TEAM_ID } from "../jira/jql.ts";
import { type Settings, SettingsError, list } from "../settings.ts";
import { isRepoName } from "../solve/labels.ts";
import type { ChangelogSettings } from "./collect.ts";
import type { RepoInfo } from "./types.ts";

const ORG = /^[A-Za-z0-9][A-Za-z0-9-]*$/u;

/** Every refusal is a startup error, so a mistyped scope never becomes a report about the wrong thing. */
export function readChangelogSettings(settings: Settings): ChangelogSettings {
  const problems: string[] = [];

  const component =
    settings.CHANGELOG_COMPONENT.trim() === "" ? null : settings.CHANGELOG_COMPONENT.trim();
  const teamId =
    settings.CHANGELOG_TEAM_ID.trim() === "" ? null : settings.CHANGELOG_TEAM_ID.trim();
  if (component === null && teamId === null) {
    problems.push(
      "CHANGELOG_COMPONENT or CHANGELOG_TEAM_ID (a changelog needs one of them, or it would be the whole project)",
    );
  }
  if (teamId !== null && !TEAM_ID.test(teamId)) {
    problems.push(
      `CHANGELOG_TEAM_ID (expected the team's UUID, not its name, got ${JSON.stringify(teamId)})`,
    );
  }

  const org = settings.CHANGELOG_GITHUB_ORG.trim();
  if (!ORG.test(org)) {
    problems.push(
      `CHANGELOG_GITHUB_ORG (expected an organisation name, got ${JSON.stringify(org)})`,
    );
  }

  const known = new Map<string, string>();
  for (const entry of list(settings, "CHANGELOG_REPOS")) {
    const parts = entry.split("=").map((part) => part.trim());
    const alias = parts[0] ?? "";
    const full = parts.length === 1 ? alias : (parts[1] ?? "");
    if (parts.length > 2 || !isRepoName(alias) || !isRepoName(full)) {
      problems.push(
        `CHANGELOG_REPOS (expected alias=repository or a repository name, got ${JSON.stringify(entry)})`,
      );
    } else if (known.has(alias)) {
      problems.push(`CHANGELOG_REPOS (${alias} is listed twice)`);
    } else {
      known.set(alias, full);
    }
  }

  const web = new Set(list(settings, "CHANGELOG_WEBAPPS"));
  for (const name of web) {
    if (!known.has(name)) {
      problems.push(`CHANGELOG_WEBAPPS (${name} is not in CHANGELOG_REPOS)`);
    }
  }

  if (problems.length > 0) {
    throw new SettingsError(problems);
  }

  const repos: RepoInfo[] = [...known].map(([name, full]) => ({
    name,
    full,
    kind: web.has(name) ? "web" : "service",
  }));
  const label = settings.CHANGELOG_LABEL.trim();
  return {
    project: settings.JIRA_PROJECT,
    component,
    teamId,
    label: label === "" ? (component ?? settings.JIRA_PROJECT) : label,
    jiraBase: `${settings.JIRA_BASE_URL.replace(/\/+$/u, "")}/browse/`,
    org,
    repos,
  };
}
