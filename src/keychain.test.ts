import { userInfo } from "node:os";

import { describe, expect, it } from "vitest";

import { KeychainError, LOOKUP_TIMEOUT_MS, describeFailure, lookupInKeychain } from "./keychain.ts";

/** What a failed `execFileSync` throws, stdout included, so a leak of it has something to find. */
function failed(fields: Record<string, unknown>): Error {
  return Object.assign(new Error("Command failed"), { stdout: "ATATT-the-secret", ...fields });
}

describe("lookupInKeychain", () => {
  it("asks /usr/bin/security, by absolute path, for the current user's item", () => {
    const calls: { file: string; args: readonly string[]; timeoutMs: number }[] = [];

    const secret = lookupInKeychain("the-jira-police.JIRA_AUTH", (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs });
      return "ATATT-the-secret\n";
    });

    expect(secret).toBe("ATATT-the-secret");
    expect(calls).toEqual([
      {
        file: "/usr/bin/security",
        args: [
          "find-generic-password",
          "-a",
          userInfo().username,
          "-s",
          "the-jira-police.JIRA_AUTH",
          "-w",
        ],
        timeoutMs: LOOKUP_TIMEOUT_MS,
      },
    ]);
  });

  it("turns a failed lookup into a KeychainError", () => {
    expect(() =>
      lookupInKeychain("missing", () => {
        throw failed({ status: 44 });
      }),
    ).toThrow(KeychainError);
  });
});

describe("describeFailure", () => {
  it("says what security said, and never what it printed on stdout", () => {
    const message = describeFailure(
      failed({
        status: 44,
        stderr:
          "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n",
      }),
      "the-jira-police.JIRA_AUTH",
      "someone",
    );

    expect(message).toContain("exit 44");
    expect(message).toContain("could not be found in the keychain");
    expect(message).toContain(
      "security find-generic-password -a someone -s the-jira-police.JIRA_AUTH",
    );
    expect(message).not.toContain("ATATT-the-secret");
    expect(message).not.toContain(" -w");
  });

  it("names an unanswered dialog as that, not as a missing item", () => {
    expect(describeFailure(failed({ code: "ETIMEDOUT", signal: "SIGTERM" }), "x", "someone")).toBe(
      `nobody answered the keychain dialog for "x" within ${String(LOOKUP_TIMEOUT_MS / 1000)}s`,
    );
  });

  it("names a machine without the keychain tool as that", () => {
    expect(describeFailure(failed({ code: "ENOENT" }), "x", "someone")).toContain(
      "keychain: references work only on macOS",
    );
  });
});
