/**
 * Declarative settings table plus a generic reader.
 *
 * Every setting the service understands is declared once, here, as data. The
 * reader is generic over that table, which buys three things over hand-written
 * `process.env` lookups scattered across modules:
 *
 *   - one place to see everything the service needs to run;
 *   - a single validation pass at startup, so a misconfigured deployment fails
 *     immediately with a complete list rather than one error at a time, hours
 *     in, when some code path is first reached;
 *   - a `sensitive` marker, so diagnostics can print the resolved config
 *     without leaking the values that matter.
 *
 * No values live in this file. Sensitive ones are supplied at runtime through
 * the environment; see .env.example for the template.
 */

export interface SettingSpec {
  readonly name: string;
  readonly description: string;
  /** Used when the environment does not supply a value. */
  readonly fallback?: string;
  /** When true and there is no fallback, startup fails without a value. */
  readonly required?: boolean;
  /** Never print the resolved value. */
  readonly sensitive?: boolean;
}

export const SETTINGS = [
  {
    name: "JIRA_BASE_URL",
    description: "Atlassian site root, no trailing slash.",
    fallback: "https://storebrand.atlassian.net",
  },
  {
    name: "JIRA_EMAIL",
    description: "Account the service authenticates as.",
    required: true,
  },
  {
    name: "JIRA_AUTH",
    description: "Atlassian API credential for the account above.",
    required: true,
    sensitive: true,
  },
  {
    name: "JIRA_PROJECT",
    description: "Board to watch.",
    fallback: "SSX",
  },
  {
    name: "JIRA_COMPONENTS",
    description:
      'Comma-separated components to watch, by name or id. The SSX board is shared by several teams, so this is what keeps the service off other teams\' tickets. "SSX Advisor" is id 12644 — not to be confused with "App Buy Insurance Advisor" (11408). Blank watches the whole board.',
    fallback: "SSX Advisor",
  },
  {
    name: "JIRA_EXCLUDED_TYPES",
    description:
      "Comma-separated issue type ids to skip. Defaults to Deloppgave (sub-tasks), which arrive attached to a parent that was triaged already.",
    fallback: "10009",
  },
  {
    name: "POLL_INTERVAL_MS",
    description: "Gap between polls.",
    fallback: "300000",
  },
  {
    name: "CURSOR_OVERLAP_MS",
    description:
      "How far back to re-scan each poll. Jira's date filters are minute-precision, so a strict cursor can miss issues created in the same minute as the last one seen; the key-level dedupe absorbs the resulting overlap.",
    fallback: "120000",
  },
  {
    name: "FIRST_RUN_LOOKBACK_MINUTES",
    description:
      "Window used when no state file exists. Deliberately short: a wide first window would trigger a triage run per historical issue.",
    fallback: "60",
  },
  {
    name: "STATE_PATH",
    description: "Where poll state is persisted.",
    fallback: "state/poll.json",
  },
  {
    name: "OUTPUT_DIR",
    description: "Where triage reports are written.",
    fallback: "groomed",
  },
  {
    name: "SKILL_NAME",
    description:
      "Skill to run per issue. Defaults to the mock so an unconfigured service cannot post real verdicts.",
    fallback: "mock-triage",
  },
  {
    name: "VAULT_PATH",
    description:
      "Absolute path to the insurance-knowledge-vault clone. intake-triage stops and asks a human if it cannot find one, which in a headless run means exiting successfully having done nothing — so this is set explicitly rather than left to the skill's own search. Blank for skills that need no vault.",
    fallback: "",
  },
  {
    name: "WRITE_BACK",
    description:
      "Whether the skill may post its verdict to the Jira issue itself: a comment, a label union and, on a duplicate, an issue link. Never a transition — the skill refuses to change status even when asked. Off by default, because this is the only setting whose effect the whole team can see, and an unattended service that starts commenting on shared tickets should be an explicit decision rather than a default. Off still writes the local markdown report.",
    fallback: "false",
  },
  {
    name: "STORECODE_PATH",
    description: "Executable used to run the skill.",
    fallback: "storecode",
  },
  {
    name: "TRIAGE_TIMEOUT_MS",
    description: "Per-issue budget before the run is killed.",
    fallback: "600000",
  },
  {
    name: "LOG_LEVEL",
    description: "debug | info | warn | error",
    fallback: "info",
  },
] as const satisfies readonly SettingSpec[];

/**
 * Widened view used for iteration.
 *
 * `as const` above is what makes SettingName a union of literals, but it also
 * means each element's type lists only the properties it actually declares —
 * so `spec.fallback` is a type error on entries that have no fallback. Reading
 * through the interface restores uniform access without losing the literals.
 */
const SPECS: readonly SettingSpec[] = SETTINGS;

export type SettingName = (typeof SETTINGS)[number]["name"];

export type Settings = Readonly<Record<SettingName, string>>;

export class SettingsError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      `Missing required configuration: ${missing.join(", ")}. Copy .env.example to .env and fill it in.`,
    );
    this.name = "SettingsError";
    this.missing = missing;
  }
}

/**
 * Resolves every declared setting, reporting all missing ones at once.
 *
 * Blank strings count as absent. An empty value in a .env file is almost always
 * an unfilled template line rather than a deliberate choice, and treating it as
 * present produces a confusing downstream failure instead of a clear one here.
 */
export function readSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const resolved: Record<string, string> = {};
  const missing: string[] = [];

  for (const spec of SPECS) {
    const supplied = env[spec.name]?.trim();
    if (supplied !== undefined && supplied !== "") {
      resolved[spec.name] = supplied;
      continue;
    }
    if (spec.fallback !== undefined) {
      resolved[spec.name] = spec.fallback;
      continue;
    }
    if (spec.required === true) {
      missing.push(spec.name);
      continue;
    }
    resolved[spec.name] = "";
  }

  if (missing.length > 0) {
    throw new SettingsError(missing);
  }

  return resolved as Settings;
}

/**
 * Runs an entry point, turning a configuration problem into a message.
 *
 * Wraps the whole of `main` rather than just `readSettings`, because not every
 * such problem is visible from one setting alone: `SKILL_NAME=intake-triage`
 * with no `VAULT_PATH` is only wrong as a pair, and it is caught at wiring
 * time. A misconfiguration is the operator's to fix either way, so it earns a
 * sentence and EX_CONFIG rather than a stack trace.
 */
export async function withConfigErrors(main: () => Promise<void>): Promise<void> {
  try {
    await main();
  } catch (error) {
    if (!(error instanceof SettingsError)) {
      throw error;
    }
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 78; // EX_CONFIG
  }
}

/** Resolved settings with sensitive values masked, safe to log. */
export function describeSettings(settings: Settings): Record<string, string> {
  const described: Record<string, string> = {};
  for (const spec of SPECS) {
    const value = settings[spec.name as SettingName];
    described[spec.name] =
      spec.sensitive === true ? (value === "" ? "<unset>" : "<redacted>") : value;
  }
  return described;
}

export function numeric(settings: Settings, name: SettingName): number {
  const parsed = Number(settings[name]);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Setting ${name} must be a number, got "${settings[name]}"`);
  }
  return parsed;
}

/**
 * Reads a boolean setting.
 *
 * Only "true" enables — deliberately strict rather than truthy. The one flag
 * this reads today decides whether the service writes to shared Jira tickets,
 * and a typo there should fail closed, not open.
 */
export function flag(settings: Settings, name: SettingName): boolean {
  return settings[name].trim().toLowerCase() === "true";
}

export function list(settings: Settings, name: SettingName): readonly string[] {
  return settings[name]
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}
