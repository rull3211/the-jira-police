import { access, mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runSweep } from "./sweep.ts";

let skillParent: string;
let imageParent: string;

const HOUR = 3_600_000;
const MAX_AGE_MS = 24 * HOUR;
const NOW = Date.now();

beforeEach(async () => {
  skillParent = await mkdtemp(join(tmpdir(), "sweep-test-skill-"));
  imageParent = await mkdtemp(join(tmpdir(), "sweep-test-image-"));
});

afterEach(async () => {
  await rm(skillParent, { recursive: true, force: true });
  await rm(imageParent, { recursive: true, force: true });
});

/** A directory aged to `ageMs` old by backdating both its atime and mtime. */
async function ageEntry(parentDirectory: string, name: string, ageMs: number): Promise<string> {
  const path = join(parentDirectory, name);
  await mkdir(path);
  const seconds = (NOW - ageMs) / 1000;
  await utimes(path, seconds, seconds);
  return path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("runSweep", () => {
  it("walks every parent directory given, not just the first", async () => {
    await ageEntry(skillParent, "SSX-1-skill-a1b2c3", MAX_AGE_MS);
    await ageEntry(imageParent, "SSX-1-img-a1b2c3", MAX_AGE_MS);

    const result = await runSweep([skillParent, imageParent], NOW, MAX_AGE_MS, false);

    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]?.parentDirectory).toBe(skillParent);
    expect(result.groups[0]?.verdicts).toHaveLength(1);
    expect(result.groups[1]?.parentDirectory).toBe(imageParent);
    expect(result.groups[1]?.verdicts).toHaveLength(1);
  });

  it("never removes a live worktree, however old, because it never matches", async () => {
    const worktree = await ageEntry(skillParent, "SSX-1", 1000 * HOUR);

    const result = await runSweep([skillParent], NOW, MAX_AGE_MS, true);

    expect(result.removed).toBe(0);
    expect(await exists(worktree)).toBe(true);
    // Not even reported: a name outside the two staging shapes is not this
    // sweep's to explain.
    expect(result.groups[0]?.verdicts).toHaveLength(0);
  });

  it("does not remove a matching directory younger than the threshold, dry or write", async () => {
    const young = await ageEntry(skillParent, "SSX-1-skill-a1b2c3", HOUR);

    const dry = await runSweep([skillParent], NOW, MAX_AGE_MS, false);
    expect(dry.groups[0]?.verdicts[0]?.sweep).toBe(false);
    expect(await exists(young)).toBe(true);

    const write = await runSweep([skillParent], NOW, MAX_AGE_MS, true);
    expect(write.removed).toBe(0);
    expect(await exists(young)).toBe(true);
  });

  it("reports an old matching directory in a dry run but only removes it with write", async () => {
    const old = await ageEntry(skillParent, "SSX-1-skill-a1b2c3", MAX_AGE_MS + HOUR);

    const dry = await runSweep([skillParent], NOW, MAX_AGE_MS, false);
    expect(dry.groups[0]?.verdicts[0]?.sweep).toBe(true);
    expect(dry.removed).toBe(0);
    expect(await exists(old)).toBe(true);

    const write = await runSweep([skillParent], NOW, MAX_AGE_MS, true);
    expect(write.removed).toBe(1);
    expect(await exists(old)).toBe(false);
  });

  it("leaves a malformed or foreign entry alone regardless of age", async () => {
    const foreign = await ageEntry(skillParent, "notes", 1000 * HOUR);
    const almost = await ageEntry(skillParent, "SSX-1-skill-", 1000 * HOUR); // no random suffix

    const result = await runSweep([skillParent], NOW, MAX_AGE_MS, true);

    expect(result.removed).toBe(0);
    expect(result.groups[0]?.verdicts).toHaveLength(0);
    expect(await exists(foreign)).toBe(true);
    expect(await exists(almost)).toBe(true);
  });

  it("reports an empty group for a parent directory that does not exist yet", async () => {
    const result = await runSweep([join(skillParent, "never-created")], NOW, MAX_AGE_MS, true);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.verdicts).toHaveLength(0);
    expect(result.removed).toBe(0);
  });
});
