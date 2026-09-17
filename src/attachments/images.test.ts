import { describe, expect, it } from "vitest";

import { IMAGE_SIGNATURES, isStageableImage, sniffImage, type ImageSignature } from "./images.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x11]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

function riff(payload: string): Buffer {
  return Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from(payload),
    Buffer.from([0x00, 0x00]),
  ]);
}

/** A shortest file the signature would accept, built from the table itself. */
function minimalFile(signature: ImageSignature): Buffer {
  const file = Buffer.alloc(signature.offset + signature.magic.length);
  Buffer.from(signature.magic).copy(file, signature.offset);
  return file;
}

describe("the two questions, against the one table they come from", () => {
  // Derived rather than listed, so a fifth format added to `IMAGE_SIGNATURES`
  // is covered here automatically.
  it.each(IMAGE_SIGNATURES)("$mimeType is both fetched and recognised", (signature) => {
    expect(isStageableImage(signature.mimeType)).toBe(true);
    expect(sniffImage(minimalFile(signature))).toEqual({
      mimeType: signature.mimeType,
      extension: signature.extension,
    });
  });

  it("gives every format a distinct extension, so one id cannot mean two files", () => {
    const extensions = IMAGE_SIGNATURES.map((signature) => signature.extension);
    expect(new Set(extensions).size).toBe(extensions.length);
  });
});

describe("isStageableImage", () => {
  it("ignores the parameter Jira sometimes appends", () => {
    expect(isStageableImage("image/png; charset=binary")).toBe(true);
    expect(isStageableImage("IMAGE/PNG")).toBe(true);
  });

  it("leaves SVG to the text path, so one attachment cannot take two routes", () => {
    expect(isStageableImage("image/svg+xml")).toBe(false);
  });

  it("refuses what is not an image at all", () => {
    for (const type of ["application/pdf", "text/plain", "", "image/tiff"]) {
      expect(isStageableImage(type)).toBe(false);
    }
  });
});

describe("sniffImage", () => {
  it("names each format from the leading bytes of a real file", () => {
    expect(sniffImage(PNG)).toEqual({ mimeType: "image/png", extension: "png" });
    expect(sniffImage(JPEG)).toEqual({ mimeType: "image/jpeg", extension: "jpg" });
    expect(sniffImage(GIF)).toEqual({ mimeType: "image/gif", extension: "gif" });
    expect(sniffImage(riff("WEBP"))).toEqual({ mimeType: "image/webp", extension: "webp" });
  });

  it("does not take every RIFF container for a WEBP", () => {
    expect(sniffImage(riff("WAVE"))).toBeNull();
  });

  it("returns null for bytes that are not an image, whatever the upload claimed", () => {
    expect(sniffImage(Buffer.from("#!/bin/sh\nrm -rf /\n"))).toBeNull();
    expect(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
  });

  it("does not read past the end of a truncated file", () => {
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
    expect(sniffImage(PNG.subarray(0, 4))).toBeNull();
    expect(sniffImage(Buffer.from("RIFF"))).toBeNull();
  });
});
