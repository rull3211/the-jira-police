/**
 * Answers one question, for a person or an agent about to edit this tree:
 * **is the daemon running right now?**
 *
 *   pnpm daemon:status
 *
 * It matters because there is no build step. `pnpm dev` is
 * `node --watch src/index.ts`, so the working tree is not a source that gets
 * compiled into a running program — it **is** the running program's text, and
 * saving a file re-executes it. Neither `git status` nor a green suite says a
 * word about that.
 *
 * **The restart itself is not the hazard, and saying so would be wrong.** Node
 * sends one SIGTERM (`--watch-kill-signal`, default SIGTERM) and then waits
 * indefinitely, with no SIGKILL escalation; `createShutdown` in `src/index.ts`
 * catches it and drains the cycle in flight. The dangerous part is what that
 * costs in wall-clock: draining can mean finishing an entire solve, which is
 * several model passes, while Node prints "Waiting for graceful termination".
 * **The second signal is the one that hurts** — `src/index.ts:104` answers it
 * with `process.exit(130)`, which skips every `finally` in the service, and
 * the `agent:solving` claim released by one of those has no TTL, no lease and
 * no reaper. At `MAX_CONCURRENT_SOLVES=1` that halts the solve half until a
 * human edits the label by hand.
 *
 * Even a clean restart is not free: the attempt ledger and the watch memo are
 * per-process by design, so every save re-grants a solve attempt on a failing
 * ticket. Editing often against a live daemon spends money without stranding
 * anything at all.
 *
 * **It reads `ps` and nothing else.** The daemon writes no pidfile, and giving
 * it one would mean changing the service to support a development check —
 * adding a write path, and a stale-pidfile failure mode, to the thing being
 * protected. A probe that cannot perturb what it measures is the one to have
 * here, and `ps` is already on every machine that runs this.
 *
 * **What it cannot tell you**, stated because a check trusted past its evidence
 * is worse than no check: two checkouts of this repository on one machine
 * produce identical `ps` lines, so a daemon running out of a *different* clone
 * is reported as running here. That is the direction to be wrong in. A false
 * "running" costs a question to the operator; a false "not running" costs a hot
 * reload into a live tick. The full command line is printed so a human can make
 * the call the probe cannot.
 *
 * **Exit status is 0 whether or not a daemon is up** — the answer is the line it
 * prints, not `$?`. A status command that failed when the daemon was healthy
 * would be read as broken tooling, and the one thing this must not do is train
 * anyone to ignore it. The single non-zero exit is `ps` itself failing, which
 * is not an answer to the question at all, and is the one case where the
 * printed line must not be believed.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { findDaemons } from "./daemon-processes.ts";

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  let stdout: string;
  try {
    // `-A` every process, `-o pid=,command=` two columns and no header, so
    // there is no localised heading row to parse around.
    ({ stdout } = await execFileAsync("ps", ["-Ao", "pid=,command="], {
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (error) {
    // **A probe that could not look must never read as "nothing there".** That
    // is the whole failure this command exists to prevent, and printing the
    // reassuring line on an error would build it into the tool. `ps` failing at
    // all means something odd — it missing, or output past `maxBuffer` on a host
    // with an enormous process table — so it says what it could not do and
    // exits non-zero, which is the one case where `$?` carries information.
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
