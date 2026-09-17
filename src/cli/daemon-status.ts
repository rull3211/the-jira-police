/**
 * Answers one question, for a person or an agent about to edit this tree: is the daemon running
 * right now? There is no build step — `pnpm dev` is `node --watch src/index.ts`, so saving a file
 * re-executes the running program, and neither `git status` nor a green suite warns of that.
 *
 *   pnpm daemon:status
 *
 * Reads `ps` only (no pidfile, so nothing here can perturb what it measures); two checkouts of
 * this repo look identical to it, and a false "running" is the direction to err in, so the full
 * command line is printed for a human to judge. Exit status is 0 whether or not a daemon is up —
 * the answer is the printed line, not `$?` — except when `ps` itself fails, which exits non-zero.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { findDaemons } from "./daemon-processes.ts";

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  let stdout: string;
  try {
    // `-o pid=,command=` omits the header, so there's no localised heading row to parse around.
    ({ stdout } = await execFileAsync("ps", ["-Ao", "pid=,command="], {
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (error) {
    // A probe that could not look must never read as "nothing there".
    process.stderr.write(
      `could not read the process table, so this says nothing about the daemon: ${String(error)}\n` +
        "Check by hand before editing:  ps -Ao pid=,command= | grep '[s]rc/index.ts'\n",
    );
    process.exitCode = 1;
    return;
  }

  const daemons = findDaemons(stdout, process.pid);

  if (daemons.length === 0) {
    process.stdout.write("daemon: not running — safe to edit\n");
    return;
  }

  const plural = daemons.length === 1 ? "process" : "processes";
  process.stdout.write(`daemon: RUNNING — ${String(daemons.length)} ${plural}\n`);
  for (const daemon of daemons) {
    process.stdout.write(`  ${String(daemon.pid)}  ${daemon.command}\n`);
  }

  if (daemons.some((daemon) => daemon.watched)) {
    process.stdout.write(
      "\n--watch is on: saving a file here sends SIGTERM and the daemon then drains\n" +
        "the cycle in flight, which can take several model passes. Let it finish.\n" +
        "Do NOT Ctrl-C the wait — the second signal exits at once, skipping the\n" +
        "finally that releases agent:solving, and nothing reclaims a stranded one.\n",
    );
  } else {
    process.stdout.write(
      "\nNo --watch, so a save will not restart it — but it stages a skill root from\n" +
        "this tree on every pass, so a branch switch changes what the next tick runs.\n",
    );
  }
}

await main();
