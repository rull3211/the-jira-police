/**
 * The daemon's `/bencebot` listener: decided before any loop starts, like `createReviewLoop`, and in
 * its own file because `index.ts` runs `main` on import and so cannot be asserted about.
 */

import { createLogger } from "./logger.ts";
import { type Settings, slackListen } from "./settings.ts";
import { type ListenDeps, type ListenSummary, listen } from "./slack/socket.ts";
import { listenerFor, rosterWhere } from "./wiring.ts";

const log = createLogger("slack");

/**
 * A bad SLACK_APP_TOKEN throws here, at startup, not inside a loop; the runner it returns never
 * rejects, so a broken listener cannot take the daemon's `Promise.all` with it.
 */
export function createSlackListener(
  settings: Settings,
  signal: AbortSignal,
  run: (deps: ListenDeps) => Promise<ListenSummary> = listen,
): (() => Promise<ListenSummary | null>) | null {
  const mode = slackListen(settings);
  if (mode === "off") {
    return null;
  }
  const start = listenerFor(settings, mode, signal, run);
  log.info("slack.listen_enabled", { mode, list: rosterWhere(settings) });
  return async () => {
    try {
      return await start();
    } catch (error) {
      log.error("slack.listen_crashed", {
        reason: error instanceof Error ? error.message : String(error),
        note: "the other loops carry on; /bencebot goes unanswered until a restart",
      });
      return null;
    }
  };
}
