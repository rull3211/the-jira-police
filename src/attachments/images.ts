/**
 * Which attachments are images. The declared MIME type decides whether a
 * download is worth spending; the file's own leading bytes decide what it
 * actually is, and a staged file's extension comes from the signature, never
 * from the ticket.
 */

export interface ImageKind {
  readonly mimeType: string;
  /** No leading dot. Chosen by the signature, so it cannot be steered. */
  readonly extension: string;
}

export interface ImageSignature extends ImageKind {
  readonly magic: readonly number[];
  readonly offset: number;
}

/**
 * Every image format this service recognises.
 *
 * Exported so `isStageableImage` and `sniffImage` both derive from this one
 * list rather than each keeping their own.
 */
export const IMAGE_SIGNATURES: readonly ImageSignature[] = [
  {
    mimeType: "image/png",
    extension: "png",
    offset: 0,
    magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  { mimeType: "image/jpeg", extension: "jpg", offset: 0, magic: [0xff, 0xd8, 0xff] },
  { mimeType: "image/gif", extension: "gif", offset: 0, magic: [0x47, 0x49, 0x46, 0x38] },
  // WEBP is a RIFF container: the four bytes at 8 are what distinguish it from
  // every other RIFF payload, and the four at 0 are shared with all of them.
  { mimeType: "image/webp", extension: "webp", offset: 8, magic: [0x57, 0x45, 0x42, 0x50] },
];

/** The declared types worth a round trip. */
const STAGEABLE_MIME_TYPES: ReadonlySet<string> = new Set(
  IMAGE_SIGNATURES.map((signature) => signature.mimeType),
);

/**
 * Is this worth downloading? `image/svg+xml` is deliberately absent: it is
 * already inlined as text by `solve/ticket.ts`, and staging it too would give
 * one attachment two routes to the model.
 */
export function isStageableImage(mimeType: string): boolean {
  const bare = (mimeType.split(";")[0] ?? "").trim().toLowerCase();
  return STAGEABLE_MIME_TYPES.has(bare);
}

/**
 * What the bytes actually are, or `null` if they are not an image we stage.
 *
 * A truncated file needs no explicit length check: `subarray` clamps to what
 * exists and `equals` is false for a different length.
 */
export function sniffImage(bytes: Buffer): ImageKind | null {
  for (const signature of IMAGE_SIGNATURES) {
    const end = signature.offset + signature.magic.length;
    const candidate = bytes.subarray(signature.offset, end);
    if (candidate.equals(Buffer.from(signature.magic))) {
      return { mimeType: signature.mimeType, extension: signature.extension };
    }
  }
  return null;
}
