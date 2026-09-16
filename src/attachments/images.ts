/**
 * Which attachments are images, asked twice because the two answers come from
 * different people.
 *
 * The declared MIME type is chosen by whoever uploaded the file. It decides one
 * thing only: whether a download is worth spending. What arrived is decided by
 * the file's own leading bytes, and that is the answer the stager acts on — the
 * extension a staged file gets comes from the signature, never from the
 * ticket, so a `.png` that is really something else is staged as what it is or
 * not at all.
 *
 * Four formats, because a screenshot pasted or dragged into Jira arrives as one
 * of them and each is understood by the `Read` tool the sessions already hold.
 * A format outside the list is not refused on suspicion; it is simply something
 * this service has never seen on a ticket and has no evidence a session can
 * read.
 */

export interface ImageKind {
  readonly mimeType: string;
  /** No leading dot. Chosen by the signature, so it cannot be steered. */
  readonly extension: string;
}

interface ImageSignature extends ImageKind {
  readonly magic: readonly number[];
  readonly offset: number;
}

const SIGNATURES: readonly ImageSignature[] = [
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
  SIGNATURES.map((signature) => signature.mimeType),
);

/**
 * Is this worth downloading?
 *
 * `image/svg+xml` is deliberately absent: it is text, it is already inlined
 * into the prompt by `solve/ticket.ts`, and staging it as a file would give one
 * attachment two routes to the model.
 */
export function isStageableImage(mimeType: string): boolean {
  const bare = (mimeType.split(";")[0] ?? "").trim().toLowerCase();
  return STAGEABLE_MIME_TYPES.has(bare);
}

/** What the bytes actually are, or `null` if they are not an image we stage. */
export function sniffImage(bytes: Buffer): ImageKind | null {
  for (const signature of SIGNATURES) {
    const end = signature.offset + signature.magic.length;
    if (bytes.byteLength < end) {
      continue;
    }
    const candidate = bytes.subarray(signature.offset, end);
    if (candidate.equals(Buffer.from(signature.magic))) {
      return { mimeType: signature.mimeType, extension: signature.extension };
    }
  }
  return null;
}
