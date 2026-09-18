/**
 * `pnpm logs` — the interactive reader for this service's own log.
 *
 * Lines arrive on stdin, keystrokes come from `/dev/tty`. Those are two descriptors on purpose:
 * stdin is already the pipe carrying the daemon's output, so the terminal has to be opened
 * separately or the viewer would have no way to be typed at.
 *
 * Everything decidable lives in `logs/*.ts`; this file is the part a test cannot reach — raw mode,
 * the alternate screen and cursor visibility are process-global state, and a run that exits without
 * putting them back hands the operator a shell with no cursor and no echo. `restore` is therefore
 * registered on `exit`, on the signals, and on an unhandled throw, and is safe to run twice.
 */

import { closeSync, openSync } from "node:fs";
import { ReadStream, WriteStream } from "node:tty";

import { createStreamFeed } from "../logs/feed.ts";
import { decodeKeys } from "../logs/input.ts";
import { render } from "../logs/render.ts";
import type { Action, ViewerState } from "../logs/state.ts";
import { initialState, reduce } from "../logs/state.ts";

const ALT_SCREEN_ON = "\u001B[?1049h";
const ALT_SCREEN_OFF = "\u001B[?1049l";
const CURSOR_HIDE = "\u001B[?25l";
const CURSOR_SHOW = "\u001B[?25h";
const HOME = "\u001B[H";
const CLEAR_LINE = "\u001B[K";
const CLEAR_BELOW = "\u001B[J";

/** Fallback window when the terminal reports nothing, which is what a pipe on both ends does. */
const DEFAULT_ROWS = 24;
const DEFAULT_COLUMNS = 100;

/** Repaint budget, about one frame at 60Hz. Short enough that a keystroke still feels immediate. */
const FRAME_MS = 16;

/**
 * The terminal to draw on, or a sentence saying why there is not one.
 *
 * `openSync` throws `ENXIO` wherever no controlling terminal exists — cron, CI, a detached process —
 * and the bare stack names `node:fs` rather than the thing the operator did wrong.
 */
function openTerminal(): number {
  try {
    // `r+` rather than two opens: one descriptor keeps the read and write halves on the same
    // terminal even when stdout has been redirected somewhere else.
    return openSync("/dev/tty", "r+");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `pnpm logs needs a terminal to draw on, and there is none here: ${reason}\n` +
        "It reads log lines from stdin and keystrokes from /dev/tty, so it has to be run from a\n" +
        "shell rather than from cron, CI or a detached process. To read a captured run instead,\n" +
        "open a terminal and use: pnpm logs < run.ndjson\n",
    );
    process.exit(2);
  }
}

function main(): void {
  const fd = openTerminal();
  const keyboard = new ReadStream(fd);
  const screen = new WriteStream(fd);

  let state: ViewerState = initialState(
    screen.rows || DEFAULT_ROWS,
    screen.columns || DEFAULT_COLUMNS,
  );

  let restored = false;
  const restore = (): void => {
    if (restored) {
      return;
    }
    restored = true;
    if (keyboard.isTTY) {
      keyboard.setRawMode(false);
    }
    screen.write(`${CURSOR_SHOW}${ALT_SCREEN_OFF}`);
  };

  let pending: NodeJS.Timeout | undefined;

  const draw = (): void => {
    pending = undefined;
    const lines = render(state).map((line) => `${line}${CLEAR_LINE}`);
    screen.write(`${HOME}${lines.join("\r\n")}${CLEAR_BELOW}`);
  };

  /**
   * At most one repaint per frame.
   *
   * Drawing on every action repaints the whole window per arriving line, which a daemon mid-cycle
   * produces faster than a terminal can consume — a real capture showed one full repaint per line.
   * Coalescing bounds the cost to the frame rate however fast the feed runs. The timer is unref'd
   * so a pending repaint cannot be the only thing holding the process open.
   */
  const scheduleDraw = (): void => {
    pending ??= setTimeout(draw, FRAME_MS).unref();
  };

  const dispatch = (action: Action): void => {
    state = reduce(state, action);
    if (state.quit) {
      restore();
      process.exit(0);
    }
    scheduleDraw();
  };

  process.on("exit", restore);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      restore();
      process.exit(130);
    });
  }
  // Without this the stack trace prints onto the alternate screen and vanishes with it.
  process.on("uncaughtException", (error: unknown) => {
    restore();
    process.stderr.write(`${String(error instanceof Error ? error.stack : error)}\n`);
    process.exit(1);
  });

  if (keyboard.isTTY) {
    keyboard.setRawMode(true);
  }
  keyboard.setEncoding("utf8");
  keyboard.on("data", (chunk: string) => {
    for (const key of decodeKeys(chunk)) {
      dispatch({ kind: "key", key });
    }
  });

  screen.on("resize", () => {
    dispatch({
      kind: "resize",
      rows: screen.rows || DEFAULT_ROWS,
      columns: screen.columns || DEFAULT_COLUMNS,
    });
  });

  screen.write(`${ALT_SCREEN_ON}${CURSOR_HIDE}`);
  draw();

  const feed = createStreamFeed(process.stdin);
  feed.start({
    onLine: (text) => {
      dispatch({ kind: "line", text });
    },
    // The viewer stays up after the feed closes: a replayed file is finite, and its last screen is
    // the one worth reading. `q` is what ends the session.
    onEnd: () => {
      dispatch({ kind: "end" });
    },
  });

  process.on("exit", () => {
    feed.stop();
    closeSync(fd);
  });
}

main();
