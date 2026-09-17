/**
 * Runs the intake-triage skill headlessly and parses the result.
 *
 * The ANALYST half of the pipeline: it never writes to Jira. It reads the issue, decides, and
 * returns the verdict with the mutation that verdict implies; `poster.ts` applies that mutation,
 * and only after `gate.ts` has agreed the verdict is coherent. There is deliberately no write path
 * here and no `--yes` — a second way to post would be a second way to post unchecked.
 *
 * Three non-obvious choices: `dontAsk` rather than `acceptEdits` (which stalls on MCP tool calls)
 * or `bypassPermissions` (which disables safety hooks); the MCP connection is checked explicitly,
 * since an expired Atlassian session still exits 0 and silently reports that it could not read the
 * issue; and the vault reaches the skill as an environment variable plus `--add-dir`, never as its
 * `--vault` flag (see `vaultPath` below).
 */

import { logger } from "../logger.ts";
import type { Verdict } from "../output/sink.ts";
import { TRIAGE_SCHEMA, TRIAGE_SCHEMA_JSON } from "./schema.ts";
import { DENIED_BUILTIN_TOOLS, runSession } from "./session.ts";

// Re-exported so callers reasoning about a triage run keep a single import; the
// machinery lives in `session.ts` because the poster shares it.
export {
  McpUnavailableError,
  SessionTimeoutError as TriageTimeoutError,
  assertMcpReady,
} from "./session.ts";

/**
 * Tools the skill legitimately needs, pre-approved so the run never stalls.
 *
 * This list does NOT restrict anything — omission from it is not denial. See `DENIED_BUILTIN_TOOLS`
 * in `session.ts` for the probe that established that, and `ANALYST_DENIED_TOOLS` below for the
 * list that does the restricting.
 */
export const ALLOWED_TOOLS: readonly string[] = [
  "mcp__atlassian__getJiraIssue",
  "mcp__atlassian__searchJiraIssuesUsingJql",
  "mcp__atlassian__search",
  "mcp__atlassian__getConfluencePage",
  "mcp__atlassian__searchConfluenceUsingCql",
  // Needed to validate a component name before setting it: with WRITE_BACK on, the component is a
  // real mutation, and the copy live on the issue does not confirm the name still exists.
  "mcp__atlassian__getAccessibleAtlassianResources",
  "Read",
  "Grep",
  "Glob",
];

/**
 * Tools withheld from the analyst. `--allowedTools` enforces nothing by itself, so "never writes to
 * Jira" rests on this list, not on omission from `ALLOWED_TOOLS` above.
 *
 * The Atlassian mutators are listed on the same principle but are NOT verified withheld — a bare
 * probe run has no MCP server connected, so nothing distinguishes "denied" from "absent" here.
 * Nobody should read this list as proof the analyst is mechanically unable to edit a Jira issue;
 * what keeps it from doing so today is `--no-write` in the prompt plus `gate.ts` sitting between it
 * and the poster.
 */
export const ANALYST_DENIED_TOOLS: readonly string[] = [
  ...DENIED_BUILTIN_TOOLS,
  // A picture is untrusted text `sanitiseUntrusted` cannot see; with no network tool there is no
  // in-session route from an instruction painted into a screenshot to a request leaving this machine.
  "WebFetch",
  "WebSearch",
  // Worth nothing while a subagent can be spawned with an unverified tool surface, but the triage
  // skill already treats subagents as unusable headlessly, so the run loses nothing it was using.
  "Task",
  "mcp__atlassian__editJiraIssue",
  "mcp__atlassian__addCommentToJiraIssue",
  "mcp__atlassian__createJiraIssue",
  "mcp__atlassian__transitionJiraIssue",
  "mcp__atlassian__createIssueLink",
];

export interface TriageRunOptions {
  readonly issueKey: string;
  /**
   * Skill to invoke, without the leading slash. Normally `intake-triage`;
   * `mock-triage` exercises the whole pipeline with no Jira and no vault.
   */
  readonly skillName: string;
  /** Path to the storecode executable. */
  readonly executable: string;
  /** Directory to run in — must be where the skill and vault are resolvable. */
  readonly workingDirectory: string;
  /** Silence budget for the run; see `SessionOptions.idleMs`. */
  readonly idleMs: number;
  /** Awake-time ceiling on the run; see `SessionOptions.maxRunMs`. */
  readonly maxRunMs: number;
  readonly deep: boolean;
  /**
   * Absolute path to the insurance-knowledge-vault clone. Passed two ways: as `$INSURANCE_VAULT`,
   * the skill's own resolution step, so it never reaches the "STOP and ask the user" branch a
   * headless run cannot answer; and as `--add-dir`, since the vault is a sibling of this repo, not
   * inside it. Never passed as `--vault` — that value would have to survive the model parsing it
   * out of a prompt string, and an environment variable does not.
   */
  readonly vaultPath?: string;
  /**
   * Suppresses the HTML roll-up dashboard the skill otherwise writes after every run. This service
   * has a sink of its own, and `Write` is withheld by `ANALYST_DENIED_TOOLS` — left on, it ends
   * every run with a denied call.
   */
  readonly noHtml?: boolean;
  /**
   * Servers that must be `connected`. Empty for the mock skill, which reads
   * nothing — requiring Atlassian there would fail runs for the wrong reason.
   */
  readonly requiredMcpServers: readonly string[];
  /** Tools the run may use. Defaults to ALLOWED_TOOLS. */
  readonly allowedTools?: readonly string[];
  /** The ticket's images, already on disk. Absent when `TRIAGE_IMAGES` is off. */
  readonly images?: StagedImagePrompt;
}

/**
 * Staged images as the two things a run needs to know: a block and a directory, rather than
 * `ImageStageResult` itself, so this module never learns how staging works. `directory` is null
 * whenever nothing was written, including on refusal — a `--add-dir` naming a path that does not
 * exist is a startup failure on a run that should have degraded to reading the text.
 */
export interface StagedImagePrompt {
  readonly block: string;
  readonly directory: string | null;
}

export type LinkType = "duplicates" | "relates to";

export interface IssueLink {
  readonly type: LinkType;
  readonly targetKey: string;
}

/**
 * The §11 mutation payload, as data rather than as printed text.
 *
 * `labelsAdd`/`labelsRemove` are a delta, not a final set, since §11 requires the write to union
 * against the labels live on the issue: a finished set would silently revert a human's edit made
 * between analysis and post.
 */
export interface Mutation {
  readonly commentBody: string;
  readonly labelsAdd: readonly string[];
  readonly labelsRemove: readonly string[];
  /** Empty when uncertain or already correct — never a guess. */
  readonly component: string;
  readonly links: readonly IssueLink[];
  readonly commentAction: "create" | "update";
}

export type Confidence = "low" | "med" | "high";

/**
 * Whether a coding agent could be trusted to fix this ticket unattended.
 *
 * A weak estimate by construction: the analyst has no `--deep`, `Task`, or checkout of the repo it
 * names, so it's a candidate signal for "worth looking at," not a warrant — whatever acts on it
 * reads the code first. `solvable` is the field with teeth and fails closed: absent means false.
 */
export interface AgentFitness {
  readonly solvable: boolean;
  /**
   * Not solvable today, but would be if `blockers` were filled in. The gate keeps this mutually
   * exclusive with `solvable` — a payload with both true is a contradiction. Fails closed for a
   * weaker reason than `solvable`: a wrong `true` puts the ticket on a watch list, authorising a
   * recurring triage run rather than a code change.
   */
  readonly plausible: boolean;
  readonly confidence: Confidence;
  /** Single repo the fix would land in; empty when unknown or spread across several. */
  readonly repo: string;
  readonly rationale: string;
  /** Empty iff `solvable`, and non-empty whenever `plausible`. */
  readonly blockers: readonly string[];
}

/**
 * An unfilled fill-in placeholder, and the DoR row it stands in for. `row` decides whether the
 * placeholder is evidence of a contradiction or merely a nudge — see `BLOCKING_DOR_ROWS`.
 */
export interface DorPlaceholder {
  /** The placeholder verbatim, as it appears in the ticket. */
  readonly text: string;
  /** The DoR checklist row it stands in for, or `UNATTRIBUTED_DOR_ROW`. */
  readonly row: number;
}

/**
 * The DoR rows a leftover placeholder can still fail an item on. Rows 1-3 describe whether the
 * ticket is understood; rows 4-7 are auto-filled from research, so a placeholder never stands in
 * for one; rows 8 and 9 are advisory and block nothing; row 10 is the human Trio gate.
 */
const BLOCKING_DOR_ROWS: ReadonlySet<number> = new Set([1, 2, 3]);

/**
 * The row of a placeholder the model did not attribute, or attributed to a row that does not
 * exist. Treated as blocking, deliberately: the escape is free and requires only honesty — a model
 * that believes the placeholder is the row 9 baseline says `row: 9` and the item passes.
 */
export const UNATTRIBUTED_DOR_ROW = 0;

export interface TriagePayload {
  readonly verdict: Verdict;
  readonly labels: readonly string[];
  /** Unfilled fill-in placeholders the skill found in the ticket, with their rows. */
  readonly dorPlaceholders: readonly DorPlaceholder[];
  readonly recommendedNextStep: string;
  readonly report: string;
  /** What a write WOULD send. Nothing in this module sends it. */
  readonly mutation: Mutation;
  /** Never absent here even when absent from the model's reply — see `parseAgentFitness`. */
  readonly agentFitness: AgentFitness;
}

export class TriageError extends Error {}

/**
 * The structured verdict contradicts the evidence in the same payload: a payload may not assert a
 * pass while its own evidence names a blocking row (`BLOCKING_DOR_ROWS`) as unmet.
 *
 * This is detection, not prevention — the skill posts its comment mid-run, before
 * `structured_output` arrives, so a write-enabled run has already commented by the time this
 * throws. What it buys: the contradiction is refused rather than compounded into the local report,
 * and since the poller does not record a failed key as seen, the next cycle retries; the comment is
 * idempotent on its footer sentinel, so a retry that gets it right updates in place.
 */
export class TriageContradictionError extends TriageError {
  readonly issueKey: string;
  readonly placeholders: readonly DorPlaceholder[];

  constructor(
    issueKey: string,
    placeholders: readonly DorPlaceholder[],
    claims: readonly string[],
  ) {
    const named = placeholders
      .map(
        (p) => `"${p.text}" (${p.row === UNATTRIBUTED_DOR_ROW ? "no row given" : `row ${p.row}`})`,
      )
      .join(", ");
    super(
      `${issueKey}: the ticket still contains ${named}, ` +
        `so a blocking DoR row does not hold — but the run returned ${claims.join(" and ")}. ` +
        `DOR_CHECKLIST.md: "Output dor:pass only if 1-7 hold." Refusing the verdict; ` +
        `if the run was write-enabled, a comment making the same claim is already on the issue.`,
    );
    this.name = "TriageContradictionError";
    this.issueKey = issueKey;
    this.placeholders = placeholders;
  }
}

/**
 * Variables withheld from the triage subprocess. The poller authenticates to Jira with a REST
 * credential to discover which tickets are new; the skill uses the Atlassian MCP session to read
 * what is in them and never needs the REST credential, so it does not get it.
 */
const WITHHELD_FROM_CHILD = /^JIRA_/;

/**
 * Undocumented switch that this service must never be the one to set. It appears in neither the
 * environment-variable nor the hooks reference, and the two plausible readings disagree about
 * `CLAUDE_SKIP_HOOKS=0`: a presence check reads it as "skip hooks," a value check as "do not skip."
 * Removing it from the child's environment is correct under both readings; hooks are turned off
 * deliberately via the documented `disableAllHooks` setting, never by an inherited variable.
 */
const HOOK_KILL_SWITCH = "CLAUDE_SKIP_HOOKS";

/**
 * The child's environment: ours, minus the Jira REST credential.
 *
 * Exported for testing — that the credential is absent is a property worth
 * asserting, not assuming.
 */
export function childEnv(
  parent: NodeJS.ProcessEnv = process.env,
  vaultPath?: string,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parent)) {
    if (WITHHELD_FROM_CHILD.test(key) || key === HOOK_KILL_SWITCH) {
      continue;
    }
    result[key] = value;
  }
  // Set last, so a stale value in the operator's own shell cannot win.
  if (vaultPath !== undefined && vaultPath !== "") {
    result["INSURANCE_VAULT"] = vaultPath;
  }
  return result;
}

/**
 * `--no-write` is unconditional — a pure dry-run that still renders the full §11 mutation payload
 * but never offers to write it. Any staged-image block follows the command on its own lines,
 * because the skill takes a slash command and this service has no other channel into the session.
 */
export function buildPrompt(options: TriageRunOptions): string {
  const flags = [
    "--no-write",
    options.deep ? "--deep" : "",
    options.noHtml === true ? "--no-html" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const command = `/${options.skillName} ${options.issueKey} ${flags}`;
  const block = options.images?.block ?? "";
  return block === "" ? command : `${command}\n\n${block}`;
}

/**
 * The tools pre-approved for a run. Omitting a write tool from this list never denies it — that's
 * `ANALYST_DENIED_TOOLS`, passed alongside as `--disallowedTools`.
 */
export function toolsFor(options: TriageRunOptions): readonly string[] {
  return options.allowedTools ?? ALLOWED_TOOLS;
}

export function buildArgs(options: TriageRunOptions): string[] {
  const vaultPath = options.vaultPath ?? "";
  const imageDir = options.images?.directory ?? null;
  return [
    "-p",
    buildPrompt(options),
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    toolsFor(options).join(","),
    // Not a duplicate of the line above: the allowlist pre-approves, only this withholds.
    "--disallowedTools",
    ANALYST_DENIED_TOOLS.join(","),
    ...(vaultPath === "" ? [] : ["--add-dir", vaultPath]),
    // Declared intent, not a grant — a probe showed the session can open a staged file whether or
    // not it's named here, so this keeps the transcript honest about intended directories.
    ...(imageDir === null ? [] : ["--add-dir", imageDir]),
    "--json-schema",
    TRIAGE_SCHEMA_JSON,
  ];
}

/**
 * The accepted verdicts, read off the schema the model was given, so the check and the contract
 * cannot disagree.
 */
const VERDICTS: readonly Verdict[] = TRIAGE_SCHEMA.properties.verdict.enum;

function isVerdict(value: unknown): value is Verdict {
  return typeof value === "string" && VERDICTS.includes(value as Verdict);
}

/**
 * `assertDorCoherent` below checks both the label and the verdict deliberately: the label is what
 * the skill's own rule is written about, but the verdict is what this service actually consumes.
 * Exported for testing — the point is not that it exists but that it fires.
 */
export function blockingPlaceholders(
  placeholders: readonly DorPlaceholder[],
): readonly DorPlaceholder[] {
  return placeholders.filter(
    (placeholder) =>
      placeholder.row === UNATTRIBUTED_DOR_ROW || BLOCKING_DOR_ROWS.has(placeholder.row),
  );
}

export function assertDorCoherent(payload: TriagePayload, issueKey: string): void {
  const blocking = blockingPlaceholders(payload.dorPlaceholders);
  if (blocking.length === 0) {
    return;
  }

  const claims = [
    payload.labels.includes("dor:pass") ? "the label dor:pass" : "",
    payload.verdict === "ready-ish" ? 'the verdict "ready-ish"' : "",
  ].filter((claim) => claim !== "");

  if (claims.length === 0) {
    return;
  }

  throw new TriageContradictionError(issueKey, blocking, claims);
}

/**
 * Turns the run's structured output into a payload, or refuses it. Calls `assertDorCoherent` here
 * rather than only testing it in isolation, since the check has to be exercised through the path
 * the run actually takes.
 */
export function parsePayload(value: unknown, issueKey: string): TriagePayload {
  if (typeof value !== "object" || value === null) {
    throw new TriageError(`No structured output returned for ${issueKey}`);
  }
  const candidate = value as Record<string, unknown>;
  const verdict = candidate["verdict"];
  if (!isVerdict(verdict)) {
    throw new TriageError(`Unrecognised verdict for ${issueKey}: ${String(verdict)}`);
  }

  const payload: TriagePayload = {
    verdict,
    labels: strings(candidate["labels"]),
    dorPlaceholders: dorPlaceholders(candidate["dorPlaceholders"]),
    recommendedNextStep: String(candidate["recommendedNextStep"] ?? ""),
    report: String(candidate["report"] ?? ""),
    mutation: parseMutation(candidate["mutation"]),
    agentFitness: parseAgentFitness(candidate["agentFitness"]),
  };

  assertDorCoherent(payload, issueKey);
  return payload;
}

/**
 * Reads the mutation leniently, because the gate reads it strictly: an absent comment body becomes
 * `""`, which `assertPostable` then refuses by name, rather than throwing twice in two places.
 */
function parseMutation(value: unknown): Mutation {
  const source =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    commentBody: String(source["commentBody"] ?? ""),
    labelsAdd: strings(source["labelsAdd"]),
    labelsRemove: strings(source["labelsRemove"]),
    component: String(source["component"] ?? ""),
    links: parseLinks(source["links"]),
    commentAction: source["commentAction"] === "update" ? "update" : "create",
  };
}

/** Read off the schema, so the parser cannot accept a level the model was never offered. */
const CONFIDENCES: readonly Confidence[] =
  TRIAGE_SCHEMA.properties.agentFitness.properties.confidence.enum;

/**
 * Reads the fitness object, defaulting every way out (missing, malformed, or `solvable` not
 * literally `true`) to `false`: this field's `true` eventually authorises a subprocess to edit
 * source, and a wrong `false` (a human triages instead) is far cheaper than a wrong `true`.
 * `confidence` falls back to `low` rather than the model's raw string, so an unrecognised level
 * cannot be read downstream as a strong one. `plausible` gets the same `=== true` treatment but
 * isn't schema-required, so an older skill that has never heard of it reads as "not watching this
 * ticket" rather than a parse failure — the reason the field could be added to a live schema at all.
 */
export function parseAgentFitness(value: unknown): AgentFitness {
  const source =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const confidence = source["confidence"];
  return {
    solvable: source["solvable"] === true,
    plausible: source["plausible"] === true,
    confidence: CONFIDENCES.includes(confidence as Confidence) ? (confidence as Confidence) : "low",
    repo: String(source["repo"] ?? ""),
    rationale: String(source["rationale"] ?? ""),
    blockers: strings(source["blockers"]),
  };
}

/**
 * Unknown link types are dropped rather than coerced: the two §11 types differ in consequence —
 * `duplicates` invites a human to close a ticket — so guessing which was meant is worse than
 * creating no link at all.
 */
function parseLinks(value: unknown): readonly IssueLink[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const links: IssueLink[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const type = record["type"];
    const targetKey = record["targetKey"];
    if (
      (type === "duplicates" || type === "relates to") &&
      typeof targetKey === "string" &&
      targetKey !== ""
    ) {
      links.push({ type, targetKey });
    }
  }
  return links;
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Reads the placeholder list, tolerating a model that answers in the old bare-string shape (the
 * skill is prose the model interprets, not code deployed with this file, so a stale skill can still
 * return one). A bare string parses to `UNATTRIBUTED_DOR_ROW`, which `blockingPlaceholders` treats
 * as blocking — so a stale skill fails the guard too strictly rather than silently switching it off.
 */
function dorPlaceholders(value: unknown): readonly DorPlaceholder[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const parsed: DorPlaceholder[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      parsed.push({ text: entry, row: UNATTRIBUTED_DOR_ROW });
      continue;
    }
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    const text = candidate["text"];
    if (typeof text !== "string" || text === "") {
      continue;
    }
    const row = candidate["row"];
    const valid = typeof row === "number" && Number.isInteger(row) && row >= 1 && row <= 10;
    parsed.push({ text, row: valid ? row : UNATTRIBUTED_DOR_ROW });
  }
  return parsed;
}

export async function runTriage(options: TriageRunOptions): Promise<TriagePayload> {
  logger.info("triage.start", { issueKey: options.issueKey });

  const payload = await runSession(
    {
      executable: options.executable,
      args: buildArgs(options),
      workingDirectory: options.workingDirectory,
      idleMs: options.idleMs,
      maxRunMs: options.maxRunMs,
      env: childEnv(process.env, options.vaultPath),
      requiredMcpServers: options.requiredMcpServers,
      label: `Triage of ${options.issueKey}`,
    },
    (structuredOutput) => parsePayload(structuredOutput, options.issueKey),
  );

  logger.info("triage.done", { issueKey: options.issueKey, verdict: payload.verdict });
  return payload;
}
