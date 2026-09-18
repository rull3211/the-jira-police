/**
 * What a closed output pipe means to the daemon.
 *
 * `pnpm start` runs the daemon into the viewer, so quitting the viewer closes the daemon's stdout.
 * Left alone that is fatal: the next write raises an unhandled `error` event, Node exits 1, and the
 * `finally` that releases an `agent:solving` claim never runs. Treating it as a shutdown request
 * instead lets the current cycle unwind normally.
 */

/** Narrowed to what this needs, so a test can pass a plain `EventEmitter`. */
export interface FailableStream {
  readonly on: (event: "error", listener: (error: NodeJS.ErrnoException) => void) => unknown;
}

/**
 * Turn a broken pipe on any of `streams` into a call to `stop`.
 *
 * `stop` must not log: stdout is gone, and under `2>&1` stderr is the same pipe, so a parting
 * message would raise the very error being handled. Anything that is not `EPIPE` is rethrown,
 * because attaching this listener otherwise swallows every write failure the stream can report.
 */
export function stopOnBrokenPipe(streams: readonly FailableStream[], stop: () => void): void {
  for (const stream of streams) {
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") {
        throw error;
      }
      stop();
    });
  }
}
