/**
 * `pnpm draft:probe [--run] [--only <case>]`: whether a session's tool lists keep it off a Jira
 * mutator. `usage()` below says what it reads, writes and exits with.
 */

import { join } from "node:path";

import {
  PROBE_PROJECT,
  buildProbeArgs,
  collectEvidence,
  probeCases,
  projectUnused,
  verdictOf,
} from "../draft/probe.ts";
import { createLogger } from "../logger.ts";
import { numeric, readSettings, withConfigErrors } from "../settings.ts";
import { writeJson } from "../slack/store.ts";
import { childEnv } from "../triage/runner.ts";
import { runSession } from "../triage/session.ts";
import { createJiraClient } from "../wiring.ts";

const log = createLogger("draft-probe");

const EXIT = { held: 0, refuted: 1, usage: 2, threw: 3, unsafe: 4 } as const;

/** A probe session is one tool call; a hung one is stopped well before a draft's own ceiling. */
const MAX_RUN_MS = 300_000;

function usage(): never {
  process.stderr.write(
    "usage: pnpm draft:probe [--run] [--only <case>]\n" +
      "  Measures whether the tool lists a session is started with keep it off a Jira mutator: six\n" +
      "  one-call sessions, each told to call one Atlassian tool, in pairs of a case and its control.\n" +
      "  The verdict is read from the event stream (the tool call, its result, permission_denials),\n" +
      "  never from what the model says.\n" +
      "  Dry by default: prints each case, what it asks and what it is predicted to show, and runs\n" +
      "  nothing. --run runs them, which is paid, and first checks over REST that the project key the\n" +
      "  calls name, " +
      PROBE_PROJECT +
      ", does not exist, so a call that goes through has nothing to write to.\n" +
      "  Each result is written to <OUTPUT_DIR>/probe/draft-tools.<case>.json, tool result included.\n" +
      "  Exit: 0 every verdict was predicted, 1 one was not (read the file), 2 this usage, 3 a session\n" +
      "  threw, 4 the key exists or could not be shown not to, 78 a setting missing.\n",
  );
  process.exit(EXIT.usage);
}

function parse(args: readonly string[]): { readonly run: boolean; readonly only: string | null } {
  let run = false;
  let only: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--run") {
      run = true;
    } else if (argument === "--only" && only === null && args[index + 1] !== undefined) {
      only = args[index + 1] ?? null;
      index += 1;
    } else {
      usage();
    }
  }
  return { run, only };
}

async function main(): Promise<void> {
  const { run, only } = parse(process.argv.slice(2));
  const settings = readSettings();
  const cases = probeCases(new URL(settings.JIRA_BASE_URL).hostname).filter(
    (probe) => only === null || probe.name === only,
  );
  if (cases.length === 0) {
    usage();
  }

  if (!run) {
    for (const probe of cases) {
      process.stdout.write(
        `\n${probe.name}: ${probe.question}\n` +
          `  predicts: ${probe.predicts.join(" or ")}\n` +
          `  allowed: ${probe.allowed.join(", ")}\n` +
          `  denied:  ${probe.denied.join(", ")}\n` +
          `  asks:    call ${probe.tool} with ${JSON.stringify(probe.args)}\n`,
      );
    }
    process.stdout.write("\n(dry run, nothing run; --run runs these, paid)\n");
    return;
  }

  // Before any session is paid for: a key that exists would turn a leaked call into a real write.
  const jira = createJiraClient(settings);
  const refusal = await projectUnused((project) => jira.projectFacts(project));
  if (refusal !== null) {
    process.stderr.write(`refusing to run: ${refusal}\n`);
    process.exitCode = EXIT.unsafe;
    return;
  }

  const directory = join(settings.OUTPUT_DIR, "probe");
  let refuted = 0;
  for (const probe of cases) {
    const collector = collectEvidence(probe.tool);
    try {
      await runSession(
        {
          executable: settings.STORECODE_PATH,
          args: buildProbeArgs(probe),
          workingDirectory: process.cwd(),
          idleMs: numeric(settings, "SESSION_IDLE_TIMEOUT_MS", 1),
          maxRunMs: MAX_RUN_MS,
          env: childEnv(process.env, settings.VAULT_PATH),
          requiredMcpServers: ["atlassian"],
          label: `Probe ${probe.name}`,
          onEvent: collector.observe,
        },
        (output) => output,
      );
    } catch (error) {
      log.error("draft-probe.threw", {
        case: probe.name,
        reason: error instanceof Error ? error.message : String(error),
      });
      process.exitCode = EXIT.threw;
      return;
    }
    const evidence = collector.evidence();
    const verdict = verdictOf(evidence);
    const held = probe.predicts.includes(verdict);
    refuted += held ? 0 : 1;
    await writeJson(directory, `draft-tools.${probe.name}.json`, {
      case: probe.name,
      question: probe.question,
      tool: probe.tool,
      allowed: probe.allowed,
      denied: probe.denied,
      predicted: probe.predicts,
      verdict,
      held,
      evidence,
    });
    const spent = evidence.cost?.costUsd;
    process.stdout.write(
      `${held ? "held   " : "REFUTED"} ${probe.name}: ${verdict} (predicted ${probe.predicts.join(" or ")})${spent === null || spent === undefined ? "" : ` $${spent.toFixed(2)}`}\n`,
    );
  }
  process.stdout.write(`\nWritten to ${directory}/draft-tools.<case>.json.\n`);
  process.exitCode = refuted === 0 ? EXIT.held : EXIT.refuted;
}

try {
  await withConfigErrors(main);
} catch (error) {
  log.error("draft-probe.failed", {
    reason: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = EXIT.threw;
}
