/**
 * What has to be true before the screen is taken over.
 *
 * A refusal has to be decided here rather than once the viewer is running: after the alternate
 * screen is entered, anything written to stderr is drawn on a surface that vanishes on exit, so a
 * late complaint is one the operator never sees.
 */

export interface Surroundings {
  /** True when stdin is the terminal itself, which is what "nothing was piped in" looks like. */
  readonly stdinIsTerminal: boolean;
}

const NO_INPUT = [
  "pnpm logs reads log lines from stdin, and nothing is being piped into it.",
  "",
  "Capture a run first, then read it as many times as you like:",
  "  pnpm poll:once --dry-run > run.ndjson 2>&1",
  "  pnpm logs < run.ndjson",
  "",
  "To watch a daemon, let it write a file and follow the file. A direct pipe from pnpm start",
  "kills the daemon when you quit the viewer:",
  "  pnpm start --interval 30s --for 10m > run.ndjson 2>&1 &",
  "  tail -f run.ndjson | pnpm logs",
  "",
].join("\n");

/**
 * The sentence to print before refusing, or `undefined` when the viewer can run.
 *
 * Running with stdin on the terminal is worse than empty, which is why it is refused rather than
 * tolerated: stdin and `/dev/tty` are then the same device, the line reader and the key reader race
 * for every byte, and `q` is as likely to be swallowed as a log line — leaving the operator on the
 * alternate screen with no way back except another terminal.
 */
export function refusal(surroundings: Surroundings): string | undefined {
  return surroundings.stdinIsTerminal ? NO_INPUT : undefined;
}
