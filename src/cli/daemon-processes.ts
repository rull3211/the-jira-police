/**
 * Picking the daemon out of the process table.
 *
 * Kept out of `daemon-status.ts` because that file ends in a top-level `await`, so importing it runs the command.
 */

/** The daemon's entry point and the only string that identifies it; both `pnpm start` and `pnpm dev` end their command line with it. */
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
 * The executable is checked, not just the string: matching `src/index.ts` anywhere in the line
 * also matches the `sh -c` wrapper pnpm interposes and any `grep`/`pgrep`/editor naming the file.
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
    // A version manager's shim still basenames to `node`; `sh`, `pgrep` and `vim` do not.
    if (program.split("/").pop() !== "node") {
      continue;
    }

    found.push({ pid, command, watched: command.includes("--watch") });
  }

  return found;
}
