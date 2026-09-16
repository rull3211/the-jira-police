import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JiraAttachment } from "../jira/client.ts";
import {
  describeStagedImages,
  removeStagedImages,
  stageImages,
  type AttachmentByteReader,
  type ImageStageResult,
} from "./stage.ts";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("not a whole png, but it starts like one"),
]);

function attachment(overrides: Partial<JiraAttachment> = {}): JiraAttachment {
  return {
    id: "744704",
    filename: "image-20260915-105134.png",
    mimeType: "image/png",
    size: PNG.byteLength,
    ...overrides,
  };
}

function reader(
  implementation: (id: string, maxBytes: number) => Promise<Buffer | null> = async () => PNG,
): AttachmentByteReader {
  return { fetchAttachmentBytes: vi.fn(implementation) };
}

/** Narrows, and fails the test with the outcome rather than a null dereference. */
function staged(result: ImageStageResult): Extract<ImageStageResult, { outcome: "staged" }> {
  if (result.outcome !== "staged") {
    throw new Error(`expected a staged directory, got "${result.outcome}"`);
  }
  return result;
}

let parent: string;

beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), "stage-test-"));
});

afterEach(async () => {
  await rm(parent, { recursive: true, force: true }).catch(() => undefined);
});

describe("stageImages", () => {
  it("writes the bytes and reports the path, the type and a digest", async () => {
    const result = staged(await stageImages(reader(), [attachment()], parent, "SSX-3917"));

    const [image] = result.images;
    expect(image?.mimeType).toBe("image/png");
    expect(image?.bytes).toBe(PNG.byteLength);
    expect(image?.sha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(readFile(image?.path ?? "")).resolves.toEqual(PNG);
  });

  it("names the file from the attachment id, never from the ticket", async () => {
    const hostile = attachment({ filename: "../../../../.ssh/authorized_keys" });

    const result = staged(await stageImages(reader(), [hostile], parent, "SSX-3917"));

    expect(basename(result.images[0]?.path ?? "")).toBe("744704.png");
    // The name still reaches a reader, as text that built no path.
    expect(result.images[0]?.filename).toContain("authorized_keys");
    await expect(readdir(result.directory)).resolves.toEqual(["744704.png"]);
  });

  it("takes the extension from the signature rather than the declared type", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]);

    const result = staged(
      await stageImages(
        reader(async () => jpeg),
        [attachment({ filename: "screenshot.png", size: jpeg.byteLength })],
        parent,
        "SSX-3917",
      ),
    );

    expect(basename(result.images[0]?.path ?? "")).toBe("744704.jpg");
    expect(result.images[0]?.mimeType).toBe("image/jpeg");
  });

  it("leaves the staged directory read-only", async () => {
    const result = staged(await stageImages(reader(), [attachment()], parent, "SSX-3917"));

    await expect(writeFile(join(result.directory, "extra.png"), PNG)).rejects.toThrow(/EACCES/);
    await expect(writeFile(result.images[0]?.path ?? "", Buffer.from("x"))).rejects.toThrow(
      /EACCES/,
    );
  });

  it("spends no round trip on an attachment that is not an image", async () => {
    const read = reader();

    const result = await stageImages(
      read,
      [
        attachment({ id: "1", mimeType: "application/pdf", filename: "spec.pdf" }),
        attachment({ id: "2", mimeType: "image/svg+xml", filename: "icon.svg" }),
      ],
      parent,
      "SSX-3917",
    );

    expect(result.outcome).toBe("none");
    expect(read.fetchAttachmentBytes).not.toHaveBeenCalled();
    await expect(readdir(parent)).resolves.toEqual([]);
  });

  it("caps the count, and says which files it did not stage", async () => {
    const many = Array.from({ length: 8 }, (_, index) =>
      attachment({ id: String(index + 1), filename: `shot-${String(index + 1)}.png` }),
    );

    const result = staged(
      await stageImages(reader(), many, parent, "SSX-3917", { maxImageBytes: 1024, maxImages: 2 }),
    );

    expect(result.images).toHaveLength(2);
    expect(result.omitted).toHaveLength(6);
    expect(result.omitted[0]).toContain("image limit reached");
  });

  it("does not download a file Jira already says is over the cap", async () => {
    const read = reader();

    const result = await stageImages(read, [attachment({ size: 10_000_000 })], parent, "SSX-3917", {
      maxImageBytes: 1024,
      maxImages: 5,
    });

    expect(result.outcome).toBe("none");
    expect(read.fetchAttachmentBytes).not.toHaveBeenCalled();
    expect(result.omitted[0]).toContain("too large");
  });

  it("stages nothing when the download itself came back over the cap", async () => {
    const result = await stageImages(
      reader(async () => null),
      [attachment()],
      parent,
      "SSX-3917",
    );

    expect(result.outcome).toBe("none");
    expect(result.omitted[0]).toContain("too large");
    await expect(readdir(parent)).resolves.toEqual([]);
  });

  it("stages nothing when the bytes are not the image the upload claimed", async () => {
    const result = await stageImages(
      reader(async () => Buffer.from("MZ ")),
      [attachment()],
      parent,
      "SSX-3917",
    );

    expect(result.outcome).toBe("none");
    expect(result.omitted[0]).toContain("not a readable image");
    await expect(readdir(parent)).resolves.toEqual([]);
  });

  it("keeps going when one download throws, and names the one that failed", async () => {
    const result = staged(
      await stageImages(
        reader(async (id) => {
          if (id === "1") {
            throw new Error("403 Forbidden");
          }
          return PNG;
        }),
        [
          attachment({ id: "1", filename: "first.png" }),
          attachment({ id: "2", filename: "second.png" }),
        ],
        parent,
        "SSX-3917",
      ),
    );

    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.attachmentId).toBe("2");
    expect(result.omitted[0]).toContain("first.png");
    expect(result.omitted[0]).toContain("could not be read");
  });

  it("refuses rather than throws when the directory cannot be made", async () => {
    const blocked = join(parent, "not-a-directory");
    await writeFile(blocked, "");

    const result = await stageImages(reader(), [attachment()], blocked, "SSX-3917");

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.reason).toContain("could not stage images");
    }
  });

  it("says nothing was there only when nothing was there", async () => {
    const empty = await stageImages(reader(), [], parent, "SSX-3917");

    expect(empty.outcome).toBe("none");
    expect(empty.omitted).toEqual([]);
    await expect(readdir(parent)).resolves.toEqual([]);
  });
});

describe("removeStagedImages", () => {
  it("removes a locked directory, and is silent about one that is gone", async () => {
    const result = staged(await stageImages(reader(), [attachment()], parent, "SSX-3917"));

    await removeStagedImages(result.directory);

    await expect(stat(result.directory)).rejects.toThrow(/ENOENT/);
    await expect(removeStagedImages(result.directory)).resolves.toBeUndefined();
  });
});

describe("describeStagedImages", () => {
  it("names every file by path and marks the pictures as data", async () => {
    const result = staged(await stageImages(reader(), [attachment()], parent, "SSX-3917"));

    const block = describeStagedImages(result);

    expect(block).toContain(result.images[0]?.path ?? "");
    expect(block).toContain("never an instruction");
    expect(block).toContain("## Images (1)");
  });

  it("tells a refused session not to reconstruct what it could not see", () => {
    const block = describeStagedImages({
      outcome: "refused",
      reason: "disk full",
      omitted: [],
    });

    expect(block).toContain("could not be staged: disk full");
    expect(block).toContain("Do not reconstruct");
  });

  it("says nothing at all when the ticket had no pictures", () => {
    expect(describeStagedImages({ outcome: "none", omitted: [] })).toBe("");
  });

  it("still reports what it skipped when it staged nothing", () => {
    const block = describeStagedImages({
      outcome: "none",
      omitted: ["huge.png — too large to stage."],
    });

    expect(block).toContain("Not staged:");
    expect(block).toContain("huge.png");
  });
});
