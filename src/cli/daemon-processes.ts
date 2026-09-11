/**
 * Picking the daemon out of the process table.
 *
 * Kept out of `daemon-status.ts`, which ends in a top-level `await`, for the
 * same reason `watch-args.ts` is kept out of `watch-once.ts`: importing the
 * entry point to test one function would run the command.
 */

/**
 * The daemon's entry point, and the only string that identifies it. Both
 * `pnpm start` and `pnpm dev` end their command line with it.
 */
export const DAEMON_ENTRY_POINT = "src/index.ts";

export interface DaemonProcess {
  readonly pid: number;
  /** The full command line, as `ps` reported it. */
  readonly command: string;
  /** `node --watch`, so saving a file in this tree restarts it. */
  readonly watched: boolean;
}

/**
 * Picks the daemon processes out of `ps -Ao pid=,command=` output.
 *
 * **The executable is checked, not just the string.** Matching
 * `src/index.ts` anywhere in the line is what a first attempt does, and it
 * matches the wrong things in a specific and self-confirming way: the `sh -c`
 * wrapper that pnpm interposes carries the entry point in its own arguments,
 * and so does any `grep`, `pgrep` or editor invocation that happens to name the
 * file — including the probe's own shell. Requiring `node` as the program turns
 * "a line mentioning the daemon" into "a process that is the daemon".
 *
 * That failure is the one this repository keeps having in another costume:
 * a search that answers a question about a **name** and is read as answering
 * one about **behaviour**. Here it would have answered "yes, running" to a
 * `grep`.
 */
export function findDaemons(psOutput: string, selfPid: number): readonly DaemonProcess[] {
  const found: DaemonProcess[] = [];

  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (match === null) {
      continue;
    }

    const pid = Number(match[1]);
    const command = match[2] ?? "";

    if (pid === selfPid || !command.includes(DAEMON_ENTRY_POINT)) {
      continue;
    }

    const program = command.split(/\s+/)[0] ?? "";
    // `node`, `/opt/homebrew/bin/node`, a version manager's shim — all of them
    // basename to `node`. `sh`, `pgrep` and `vim` do not.
    if (program.split("/").pop() !== "node") {
      continue;
    }

    found.push({ pid, command, watched: command.includes("--watch") });
  }

  return found;
}
