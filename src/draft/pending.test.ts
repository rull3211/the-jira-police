import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PENDING_ID_PATTERN,
  PendingDraftError,
  type NewPendingDraft,
  discardingStore,
  fileStore,
  newPendingId,
  parsePending,
} from "./pending.ts";

const ID = "d-0123456789abcdef01234567";
const NOW = new Date("2026-10-14T12:00:00.000Z");

function draft(overrides: Partial<NewPendingDraft> = {}): NewPendingDraft {
  return {
    asker: "U0ASKER1",
    thread: { channel: "C0THREAD1", threadTs: "1712345678.000100" },
    ticket: {
      summary: "commerce-rest: raise the export timeout",
      project: "SSX",
      component: "SSX Advisor",
      issueType: "Oppgave",
      description: "## Where\n\n- `Export.ts:12`",
    },
    ...overrides,
  };
}

let root: string;
let directory: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pending-drafts-"));
  directory = join(root, "pending-drafts");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function store(): ReturnType<typeof fileStore> {
  return fileStore(directory, { id: () => ID, now: () => NOW });
}

describe("fileStore", () => {
  it("keeps a draft under its id and reads back exactly what was kept", async () => {
    const kept = await store().create(draft());

    expect(kept).toEqual({ ...draft(), id: ID, createdAt: NOW.toISOString() });
    expect(await store().get(ID)).toEqual(kept);
  });

  it("writes the record whole, leaving no temporary file beside it", async () => {
    await store().create(draft());

    expect(await readdir(directory)).toEqual([`${ID}.json`]);
  });

  it("makes ids no one can guess, and of the one shape a file name may take", () => {
    const ids = new Set(Array.from({ length: 50 }, newPendingId));

    expect(ids.size).toBe(50);
    expect([...ids].every((id) => PENDING_ID_PATTERN.test(id))).toBe(true);
  });

  it("refuses to keep a draft under an id that is not of that shape", async () => {
    const bad = fileStore(directory, { id: () => "../../escape" });

    await expect(bad.create(draft())).rejects.toThrow(PendingDraftError);
    expect(await readdir(root)).toEqual([]);
  });

  it("answers null for a draft it never kept", async () => {
    expect(await store().get(ID)).toBeNull();
  });

  it.each(["", "../outside", "d-xyz", `${ID}/../${ID}`, ID.toUpperCase(), `${ID}.json`])(
    "reads the id %j, which is not one of its own, as no draft without touching a file",
    async (id) => {
      await writeFile(join(root, "outside.json"), "{}", "utf8");
      await mkdir(directory, { recursive: true });

      expect(await store().get(id)).toBeNull();
    },
  );

  it("removes a draft, and removing one that is gone is not an error", async () => {
    await store().create(draft());

    await store().remove(ID);
    await store().remove(ID);

    expect(await store().get(ID)).toBeNull();
  });

  it("does not let a removal leave the directory", async () => {
    const outside = join(root, "outside.json");
    await writeFile(outside, "{}", "utf8");

    await store().remove("../outside");

    expect(await readFile(outside, "utf8")).toBe("{}");
  });

  it("throws, rather than answering null, for a file it cannot trust", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${ID}.json`), "{not json", "utf8");

    await expect(store().get(ID)).rejects.toThrow(PendingDraftError);
  });
});

const raw = (value: unknown): string => JSON.stringify(value);

describe("parsePending", () => {
  const kept = { ...draft(), id: ID, createdAt: NOW.toISOString() };

  it("takes what create wrote", () => {
    expect(parsePending(raw(kept), ID)).toEqual(kept);
  });

  it("refuses a record kept under another draft's file name", () => {
    expect(() => parsePending(raw({ ...kept, id: "d-ffffffffffffffffffffffff" }), ID)).toThrow(
      /id missing or wrong/u,
    );
  });

  it.each([
    ["no asker", { asker: undefined }],
    ["an asker that is not a member ID", { asker: "someone" }],
    ["an asker that is a channel", { asker: "C0THREAD1" }],
  ])("refuses a record with %s, since the asker is who may file it", (_name, change) => {
    expect(() => parsePending(raw({ ...kept, ...change }), ID)).toThrow(/asker/u);
  });

  it.each([
    ["thread", { thread: {} }, "thread.channel, thread.threadTs"],
    ["summary", { ticket: { ...kept.ticket, summary: "" } }, "ticket.summary"],
    ["description", { ticket: { ...kept.ticket, description: "" } }, "ticket.description"],
    ["created time", { createdAt: undefined }, "createdAt"],
  ])("refuses a record with no %s", (_name, change, named) => {
    expect(() => parsePending(raw({ ...kept, ...change }), ID)).toThrow(named);
  });

  it("holds a draft that chose no project, component or type, for the gate to refuse", () => {
    const bare = { ...kept, ticket: { ...kept.ticket, project: "", component: "", issueType: "" } };

    expect(parsePending(raw(bare), ID).ticket).toMatchObject({
      project: "",
      component: "",
      issueType: "",
    });
  });

  it.each([
    ["null", "null"],
    ["a list", "[]"],
    ["a string", '"x"'],
  ])("refuses JSON that is %s", (_name, text) => {
    expect(() => parsePending(text, ID)).toThrow(PendingDraftError);
  });
});

describe("discardingStore", () => {
  it("hands back a draft with an id and keeps nothing", async () => {
    const dry = discardingStore(() => ID);

    const made = await dry.create(draft());

    expect(made).toMatchObject({ ...draft(), id: ID });
    expect(await dry.get(ID)).toBeNull();
    await expect(dry.remove(ID)).resolves.toBeUndefined();
  });
});
