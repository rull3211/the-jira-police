/**
 * Runs the intake-triage skill headlessly and parses the result.
 *
 * Invocation shape, with every flag verified against the local arg parser
 * rather than assumed:
 *
 *   storecode -p "/intake-triage SSX-1234 --no-write|--yes --no-html"
 *             --output-format stream-json --verbose
 *             --permission-mode dontAsk
 *             --allowedTools <explicit list>
 *             --add-dir <vault>
 *             --json-schema '<inline draft-07>'
 *
 * with `INSURANCE_VAULT=<vault>` in the child's environment.
 *
 * Three non-obvious decisions:
 *
 * 1. `dontAsk` rather than `acceptEdits`. acceptEdits does not auto-approve MCP
 *    tool calls, so a run would stall waiting for input that never comes.
 *    bypassPermissions would also work but disables the safety hooks, which is
 *    not a trade worth making for a background job.
 *
 * 2. The MCP connection is checked explicitly. If the Atlassian OAuth session
 *    has expired, the run still exits 0 — it simply reports that it could not
 *    read the issue. That failure is silent, indistinguishable from a real
 *    verdict downstream, and is the single most likely production bug in this
 *    service. The init event carries per-server status, so we fail loudly.
 *
 * 3. The vault reaches the skill as an environment variable and an extra
 *    working directory, never as its `--vault` flag. See `vaultPath` below.
 */

import { spawn } from "node:child_process";

import { logger } from "../logger.ts";
import type { Verdict } from "../output/sink.ts";
import { TRIAGE_SCHEMA, TRIAGE_SCHEMA_JSON } from "./schema.ts";

/** Tools the skill legitimately needs. Anything absent here will not run. */
export const ALLOWED_TOOLS: readonly string[] = [
  "mcp__atlassian__getJiraIssue",
  "mcp__atlassian__searchJiraIssuesUsingJql",
  "mcp__atlassian__search",
  "mcp__atlassian__getConfluencePage",
  "mcp__atlassian__searchConfluenceUsingCql",
  // Denying this one is not free. A live run reported it: "Component
  // create-metadata could not be fetched (getAccessibleAtlassianResources
  // denied); SSX Advisor was validated against the copy live on the issue,
  // which does not re-confirm that all four policy streams still exist." That
  // was a caveat in a preview; with WRITE_BACK on, the component is a real
  // mutation, so the run needs to be able to check the name before setting it.
  "mcp__atlassian__getAccessibleAtlassianResources",
  "Read",
  "Grep",
  "Glob",
];

/**
 * Additionally granted when the run may write back to the issue.
 *
 * This is the exact set named in `INTAKE_INSTRUCTIONS.md` §11 — labels and
 * component via `editJiraIssue`, the idempotent report comment, and an issue
 * link on a duplicate. `atlassianUserInfo` is here because it is what makes the
 * comment idempotent: the skill updates a prior comment in place only when it
 * matches BOTH the footer sentinel AND its own Jira account, so without a way
 * to learn who it is, a re-run appends a second copy instead of refreshing.
 *
 * Conspicuously absent: `transitionJiraIssue`. The skill promises never to
 * change status — "not after a `y`, not for a close-as-duplicate" — and
 * withholding the tool turns that promise into something the service enforces
 * rather than something it trusts.
 */
export const WRITE_TOOLS: readonly string[] = [
  "mcp__atlassian__editJiraIssue",
  "mcp__atlassian__addCommentToJiraIssue",
  "mcp__atlassian__createIssueLink",
  "mcp__atlassian__getIssueLinkTypes",
  "mcp__atlassian__atlassianUserInfo",
];

/** MCP servers that must report `connected` before the run is trusted. */
export const REQUIRED_MCP_SERVERS: readonly string[] = ["atlassian"];

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
  readonly timeoutMs: number;
  /**
   * When true, passes `--no-write` so nothing is published to the Jira issue.
   *
   * When false the run passes `--yes` instead, and that pairing is not a
   * choice — it is the only coherent one. Left to itself the skill renders the
   * mutation payload and stops at `[y] post · [n] skip · [e] edit`, which in a
   * headless run is a prompt nobody can answer: the process would sit there
   * until the timeout killed it, having done the expensive part and published
   * nothing. `--yes` exists in the skill precisely for "non-interactive /
   * scheduled (cron) runs", which is what this service is.
   *
   * So there is no separate "confirm" mode to model, and deriving `--yes` from
   * this one field rather than adding a second one means the two can never be
   * set to disagree.
   */
  readonly noWrite: boolean;
  readonly deep: boolean;
  /**
   * Absolute path to the insurance-knowledge-vault clone.
   *
   * Passed two ways, because one is not enough. As `$INSURANCE_VAULT`, which is
   * the skill's own second resolution step, so it never reaches the "STOP and
   * ask the user" branch that a headless run cannot answer. And as `--add-dir`,
   * because the vault is a sibling of this repo rather than inside it, and
   * without that the Read tool has no business being there.
   *
   * Deliberately not passed as the skill's `--vault` flag: that value would
   * have to survive the model parsing it out of a prompt string, and an
   * environment variable does not.
   */
  readonly vaultPath?: string;
  /**
   * Suppresses the HTML roll-up dashboard the skill otherwise writes after
   * every run. This service has a sink of its own, and `Write` is not a tool
   * the run is granted — so left on, it ends every run with a denied call.
   */
  readonly noHtml?: boolean;
  /**
   * Servers that must be `connected`. Empty for the mock skill, which reads
   * nothing — requiring Atlassian there would fail runs for the wrong reason.
   */
  readonly requiredMcpServers: readonly string[];
  /** Tools the run may use. Defaults to ALLOWED_TOOLS. */
  readonly allowedTools?: readonly string[];
}

export interface TriagePayload {
  readonly verdict: Verdict;
  readonly labels: readonly string[];
  readonly recommendedNextStep: string;
  readonly report: string;
}

export class TriageError extends Error {}

/** An MCP server the skill depends on was not connected. */
export class McpUnavailableError extends TriageError {
  readonly server: string;
  readonly status: string;

  constructor(server: string, status: string) {
    super(
      `MCP server "${server}" reported status "${status}" — the run would have produced a verdict without reading the issue.`,
    );
    this.name = "McpUnavailableError";
    this.server = server;
    this.status = status;
  }
}

export class TriageTimeoutError extends TriageError {
  constructor(issueKey: string, timeoutMs: number) {
    super(`Triage of ${issueKey} exceeded ${timeoutMs}ms`);
    this.name = "TriageTimeoutError";
  }
}

interface McpServerStatus {
  readonly name: string;
  readonly status: string;
}

/**
 * Variables withheld from the triage subprocess.
 *
 * The two halves of this service authenticate to Jira by different means and
 * deliberately so: the poller uses a REST credential to discover *which*
 * tickets are new, and the skill uses the Atlassian MCP session to read what
 * is *in* them. The skill therefore never needs the REST credential, so it
 * does not get it. Inheriting the whole environment would hand it over for no
 * reason, and least privilege is cheap here.
 */
const WITHHELD_FROM_CHILD = /^JIRA_/;

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
    if (!WITHHELD_FROM_CHILD.test(key)) {
      result[key] = value;
    }
  }
  // Safety hooks must stay active in headless runs.
  result["CLAUDE_SKIP_HOOKS"] = "0";
  // Set last, so a stale value in the operator's own shell cannot win.
  if (vaultPath !== undefined && vaultPath !== "") {
    result["INSURANCE_VAULT"] = vaultPath;
  }
  return result;
}

export function buildPrompt(options: TriageRunOptions): string {
  const flags = [
    // Never neither, never both: see `noWrite`.
    options.noWrite ? "--no-write" : "--yes",
    options.deep ? "--deep" : "",
    options.noHtml === true ? "--no-html" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `/${options.skillName} ${options.issueKey}${flags === "" ? "" : ` ${flags}`}`;
}

/**
 * The tool allowlist for a run.
 *
 * Write tools are granted only to a run that is actually going to write. The
 * prompt already says `--no-write`, so this is belt and braces — but the belt
 * is a sentence in a prompt the model could misread, and the braces are a
 * permission check it cannot. On a preview run the write tools are simply not
 * there to call.
 */
export function toolsFor(options: TriageRunOptions): readonly string[] {
  if (options.allowedTools !== undefined) {
    return options.allowedTools;
  }
  return options.noWrite ? ALLOWED_TOOLS : [...ALLOWED_TOOLS, ...WRITE_TOOLS];
}

export function buildArgs(options: TriageRunOptions): string[] {
  const vaultPath = options.vaultPath ?? "";
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
    ...(vaultPath === "" ? [] : ["--add-dir", vaultPath]),
    "--json-schema",
    TRIAGE_SCHEMA_JSON,
  ];
}

/**
 * Inspects an init event and throws if a required server is not connected.
 *
 * Exported so this can be unit-tested against recorded events without spawning
 * a real run.
 */
export function assertMcpReady(
  servers: readonly McpServerStatus[],
  requiredServers: readonly string[] = REQUIRED_MCP_SERVERS,
): void {
  for (const required of requiredServers) {
    const found = servers.find((server) => server.name === required);
    const status = found?.status ?? "absent";
    if (status !== "connected") {
      throw new McpUnavailableError(required, status);
    }
  }
}

/**
 * The accepted verdicts, read off the schema the model was given.
 *
 * Deriving them rather than restating them means the check and the contract
 * cannot disagree — and the annotation makes it a compile error for the schema
 * to offer a verdict `Verdict` has no name for.
 */
const VERDICTS: readonly Verdict[] = TRIAGE_SCHEMA.properties.verdict.enum;

function isVerdict(value: unknown): value is Verdict {
  return typeof value === "string" && VERDICTS.includes(value as Verdict);
}

function parsePayload(value: unknown, issueKey: string): TriagePayload {
  if (typeof value !== "object" || value === null) {
    throw new TriageError(`No structured output returned for ${issueKey}`);
  }
  const candidate = value as Record<string, unknown>;
  const verdict = candidate["verdict"];
  if (!isVerdict(verdict)) {
    throw new TriageError(`Unrecognised verdict for ${issueKey}: ${String(verdict)}`);
  }

  const rawLabels = candidate["labels"];
  return {
    verdict,
    labels: Array.isArray(rawLabels)
      ? rawLabels.filter((label): label is string => typeof label === "string")
      : [],
    recommendedNextStep: String(candidate["recommendedNextStep"] ?? ""),
    report: String(candidate["report"] ?? ""),
  };
}

export async function runTriage(options: TriageRunOptions): Promise<TriagePayload> {
  const args = buildArgs(options);
  logger.info("triage.start", { issueKey: options.issueKey });

  return await new Promise<TriagePayload>((resolve, reject) => {
    const child = spawn(options.executable, args, {
      cwd: options.workingDirectory,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv(process.env, options.vaultPath),
    });

    let settled = false;
    let buffered = "";
    let stderr = "";
    let payload: TriagePayload | null = null;
    let failure: Error | null = null;

    const finish = (error: Error | null, value?: TriagePayload): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error !== null) {
        reject(error);
      } else if (value !== undefined) {
        resolve(value);
      }
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new TriageTimeoutError(options.issueKey, options.timeoutMs));
    }, options.timeoutMs);

    const handleEvent = (event: Record<string, unknown>): void => {
      if (event["type"] === "system" && event["subtype"] === "init") {
        const servers = Array.isArray(event["mcp_servers"])
          ? (event["mcp_servers"] as McpServerStatus[])
          : [];
        try {
          assertMcpReady(servers, options.requiredMcpServers);
        } catch (error) {
          failure = error as Error;
          // No point letting the run continue; it cannot read the issue.
          child.kill("SIGTERM");
        }
        return;
      }

      if (event["type"] === "result") {
        if (event["subtype"] !== "success" || event["is_error"] === true) {
          failure ??= new TriageError(
            `Triage of ${options.issueKey} failed: ${String(event["subtype"])}`,
          );
          return;
        }
        try {
          payload = parsePayload(event["structured_output"], options.issueKey);
        } catch (error) {
          failure ??= error as Error;
        }
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "") {
          continue;
        }
        try {
          handleEvent(JSON.parse(trimmed) as Record<string, unknown>);
        } catch {
          logger.debug("triage.unparsed_line", { line: trimmed.slice(0, 200) });
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      finish(error);
    });

    child.on("close", (code) => {
      if (failure !== null) {
        finish(failure);
        return;
      }
      if (payload === null) {
        finish(
          new TriageError(
            `Triage of ${options.issueKey} exited ${String(code)} without structured output. stderr: ${stderr.slice(0, 500)}`,
          ),
        );
        return;
      }
      logger.info("triage.done", {
        issueKey: options.issueKey,
        verdict: payload.verdict,
      });
      finish(null, payload);
    });
  });
}
