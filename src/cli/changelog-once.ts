/**
 * `pnpm changelog:once [days]`: what `@Bencebot changelog` would report, for the last `days` days. `usage()`
 * below says what it reads, writes and exits with.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ChangelogArgError, parseDays } from "../changelog/rules.ts";
import { runChangelog } from "../changelog/run.ts";
import { createLogger } from "../logger.ts";
import { readSettings, withConfigErrors } from "../settings.ts";
import { createChangelogDeps } from "../wiring.ts";

const log = createLogger("changelog-once");

const EXIT = { written: 0, refused: 1, usage: 2, threw: 3 } as const;

const TEMPLATE = new URL("../../.claude/skills/changelog/template.html", import.meta.url);

function usage(reason?: string): never {
  process.stderr.write(
    `${reason === undefined ? "" : `${reason}\n`}usage: pnpm changelog:once [days]\n` +
      "  days is a whole number from 1 to 31 and defaults to 7. Reads the issues resolved in that window\n" +
      "  that belong to CHANGELOG_COMPONENT or CHANGELOG_TEAM_ID (Jira over REST, the same credential\n" +
      "  discovery uses), then the pull requests that delivered them (`gh`, under CHANGELOG_GITHUB_ORG).\n" +
      "  Counts them, checks the report holds exactly the issues the query returned, and writes\n" +
      "  <OUTPUT_DIR>/changelog/<date>-<days>d.html, with the facts it was made from beside it as\n" +
      "  .facts.json. The titles and sentences are Jira's own summary and the first lines of its\n" +
      "  description: no model runs, so this costs nothing. The page is made to be opened in a browser.\n" +
      "  Nothing is written to Jira, GitHub or Slack.\n" +
      "  Exit: 0 written, 1 the check refused it (the facts are written, the page is not, and why is\n" +
      "  printed), 2 this usage, 3 the run threw, 78 a setting missing or mistyped.\n",
  );
  process.exit(EXIT.usage);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some((argument) => argument.startsWith("-"))) {
    usage();
  }
  let days: number;
  try {
    days = parseDays(args[0]);
  } catch (error) {
    if (error instanceof ChangelogArgError) {
      usage(error.message);
    }
    throw error;
  }

  const settings = readSettings();
  const { deps, scope } = createChangelogDeps(settings);
  const directory = join(settings.OUTPUT_DIR, "changelog");
  await mkdir(directory, { recursive: true });

  const outcome = await runChangelog(
    {
      collect: deps,
      scope,
      template: await readFile(TEMPLATE, "utf8"),
      write: (file, content) => writeFile(join(directory, file), content),
    },
    days,
  );

  if (outcome.kind === "refused") {
    log.error("changelog-once.refused", { name: outcome.name, problems: outcome.problems });
    process.stderr.write(
      `Not written: the check refused this report.\n${outcome.problems.map((problem) => `  - ${problem}`).join("\n")}\nThe facts it was made from are in ${join(directory, `${outcome.name}.facts.json`)}.\n`,
    );
    process.exitCode = EXIT.refused;
    return;
  }
  log.info("changelog-once.done", { ...outcome });
  process.stdout.write(
    `${String(outcome.issues)} issues finished, ${String(outcome.excluded)} resolved but not counted, ${String(outcome.pullRequests)} pull requests merged.\nWritten to ${join(directory, `${outcome.name}.html`)}.\n`,
  );
  process.exitCode = EXIT.written;
}

try {
  await withConfigErrors(main);
} catch (error) {
  log.error("changelog-once.failed", {
    reason: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = EXIT.threw;
}
