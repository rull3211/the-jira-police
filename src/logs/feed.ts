/**
 * Where lines come from, behind an interface with exactly one implementation today.
 *
 * Stdin is enough for `pnpm logs` and for replaying a saved file, and neither needs the daemon to
 * change. Attaching to a daemon already running — and eventually telling it to do something — is a
 * socket the daemon would have to listen on, which is a privilege with its own phasing rather than
 * something to smuggle in behind a viewer. `send` is the seam that keeps that possible: absent on a
 * one-way feed, so the viewer has to degrade rather than assume a channel it does not have.
 */

import type { Interface } from "node:readline";
import { createInterface } from "node:readline";

/** What a future control feed would carry. Nothing sends these yet. */
export interface DaemonCommand {
  readonly kind: string;
}

export interface FeedSink {
  readonly onLine: (text: string) => void;
  /** The feed will produce nothing further; the viewer stays up so the buffer can still be read. */
  readonly onEnd: () => void;
}

export interface LogFeed {
  readonly start: (sink: FeedSink) => void;
  readonly stop: () => void;
  readonly send?: (command: DaemonCommand) => void;
}

/**
 * Lines from a readable stream, one entry per newline.
 *
 * `readline` rather than a split on the chunk boundary: a JSON line long enough to arrive in two
 * chunks would otherwise be torn into two unparseable halves, and the settings line this daemon
 * writes at startup is already over two kilobytes.
 */
export function createStreamFeed(input: NodeJS.ReadableStream): LogFeed {
  let reader: Interface | undefined;

  return {
    start: (sink) => {
      reader = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
      reader.on("line", sink.onLine);
      reader.on("close", sink.onEnd);
    },
    stop: () => {
      reader?.close();
      reader = undefined;
    },
  };
}
