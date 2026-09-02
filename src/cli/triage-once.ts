/**
 * Runs one triage and writes the result to the local sink.
 *
 *   node src/cli/triage-once.ts SSX-1234
 *   node src/cli/triage-once.ts SSX-1234 --skill intake-triage
 *
 * Defaults to the mock skill so this is safe to run before the real skill and
 * its knowledge vault are installed.
 */

import { logger } from "../logger.ts";
import { FileSink, type TriageResult } from "../output/sink.ts";
import { runTriage } from "../triage/runner.ts";

function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const issueKey = argv[0];

  if (issueKey === undefined || issueKey.startsWith("-")) {
    process.stderr.write("usage: triage-once <ISSUE-KEY> [--skill <name>]\n");
    process.exitCode = 2;
    return;
  }

  const skillName = flagValue(argv, "--skill") ?? "mock-triage";
  const isMock = skillName === "mock-triage";

  const payload = await runTriage({
    issueKey,
    skillName,
    executable: "storecode",
    workingDirectory: process.cwd(),
    timeoutMs: 10 * 60 * 1000,
    noWrite: true,
    deep: false,
    // The mock reads nothing, so demanding a live Atlassian session would fail
    // runs for a reason unrelated to what is being tested.
    requiredMcpServers: isMock ? [] : ["atlassian"],
    ...(isMock ? { allowedTools: [] as readonly string[] } : {}),
  });

  const result: TriageResult = {
    issueKey,
    issueUrl: `https://storebrand.atlassian.net/browse/${issueKey}`,
    summary: `${issueKey} (summary not fetched in single-run mode)`,
    verdict: payload.verdict,
    labels: payload.labels,
    recommendedNextStep: payload.recommendedNextStep,
    report: payload.report,
  };

  const sink = new FileSink("groomed");
  await sink.write(result);

  logger.info("triage-once.written", {
    issueKey,
    verdict: result.verdict,
    path: `groomed/${issueKey}.md`,
    mocked: isMock,
  });
}

await main();
