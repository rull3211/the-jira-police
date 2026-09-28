/**
 * `keychain:<name>` setting values, resolved against the macOS login keychain inside this process,
 * so a secret never passes through a file or through the environment a process was launched with.
 */

import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";

import { oneLine, shorten } from "./text.ts";

export const KEYCHAIN_PREFIX = "keychain:";

/** Absolute, so a `security` earlier on `PATH` cannot choose what the secret is. */
const SECURITY = "/usr/bin/security";

/** Long enough to find and answer the dialog; nobody answering must fail the start, not hang it. */
export const LOOKUP_TIMEOUT_MS = 120_000;

export type SecretLookup = (name: string) => string;

export type SecurityRunner = (file: string, args: readonly string[], timeoutMs: number) => string;

export class KeychainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeychainError";
  }
}

const runSecurity: SecurityRunner = (file, args, timeoutMs) =>
  execFileSync(file, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });

/** Trimmed, since `security -w` ends the value with a newline and a token never holds whitespace. */
export function lookupInKeychain(name: string, run: SecurityRunner = runSecurity): string {
  const account = userInfo().username;
  try {
    return run(
      SECURITY,
      ["find-generic-password", "-a", account, "-s", name, "-w"],
      LOOKUP_TIMEOUT_MS,
    ).trim();
  } catch (error) {
    throw new KeychainError(describeFailure(error, name, account));
  }
}

/** Built from the exit status and stderr only: stdout is where the secret would be. */
export function describeFailure(error: unknown, name: string, account: string): string {
  const failure = (typeof error === "object" && error !== null ? error : {}) as {
    readonly code?: unknown;
    readonly status?: unknown;
    readonly signal?: unknown;
    readonly stderr?: unknown;
  };
  if (failure.code === "ENOENT") {
    return `${SECURITY} does not exist, so keychain: references work only on macOS`;
  }
  if (failure.code === "ETIMEDOUT" || failure.signal === "SIGTERM") {
    return `nobody answered the keychain dialog for "${name}" within ${String(LOOKUP_TIMEOUT_MS / 1000)}s`;
  }
  const said = shorten(oneLine(typeof failure.stderr === "string" ? failure.stderr : ""), 200);
  const status = typeof failure.status === "number" ? String(failure.status) : "unknown";
  return (
    `keychain lookup of "${name}" failed (exit ${status}${said === "" ? "" : `: ${said}`}); ` +
    `look at the item without revealing it: security find-generic-password -a ${account} -s ${name}`
  );
}
