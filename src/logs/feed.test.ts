import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { createStreamFeed } from "./feed.ts";

/** Lines and the end signal, in the order the feed produced them. */
function collect(input: NodeJS.ReadableStream): { lines: string[]; ended: boolean[] } {
  const lines: string[] = [];
  const ended: boolean[] = [];
  const feed = createStreamFeed(input);
  feed.start({
    onLine: (text) => {
      lines.push(text);
    },
    onEnd: () => {
      ended.push(true);
    },
  });
  return { lines, ended };
}

/** One tick of the stream machinery; `readline` delivers on the next turn, not on `write`. */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
};

describe("createStreamFeed", () => {
  it("delivers one line per newline", async () => {
    const input = new PassThrough();
    const seen = collect(input);

    input.write('{"message":"a"}\n{"message":"b"}\n');
    await settle();

    expect(seen.lines).toEqual(['{"message":"a"}', '{"message":"b"}']);
  });

  it("rejoins a line that arrives in two chunks", async () => {
    // The reason this uses `readline` at all: the daemon's startup settings line is over two
    // kilobytes, so it crosses a chunk boundary and a split on the chunk would hand the viewer two
    // unparseable halves — which the viewer would faithfully show as two raw lines.
    const input = new PassThrough();
    const seen = collect(input);
    const long = `{"message":"poll-once.settings","jql":"${"x".repeat(4000)}"}`;

    input.write(long.slice(0, 1000));
    await settle();
    expect(seen.lines).toEqual([]);

    input.write(`${long.slice(1000)}\n`);
    await settle();

    expect(seen.lines).toEqual([long]);
  });

  it("holds a line that has no newline yet rather than emitting half of it", async () => {
    const input = new PassThrough();
    const seen = collect(input);

    input.write('{"message":"unterminated"}');
    await settle();

    expect(seen.lines).toEqual([]);
  });

  it("emits a trailing line with no newline once the stream closes", async () => {
    // A captured file whose last line lost its newline still has a last line worth reading.
    const input = new PassThrough();
    const seen = collect(input);

    input.end('{"message":"last"}');
    await settle();

    expect(seen.lines).toEqual(['{"message":"last"}']);
  });

  it("signals the end exactly once when the stream closes", async () => {
    const input = new PassThrough();
    const seen = collect(input);

    input.end('{"message":"a"}\n');
    await settle();

    expect(seen.ended).toEqual([true]);
  });

  it("delivers nothing after stop, so a shutting-down viewer cannot be re-entered", async () => {
    const input = new PassThrough();
    const lines: string[] = [];
    const feed = createStreamFeed(input);
    feed.start({
      onLine: (text) => {
        lines.push(text);
      },
      onEnd: () => {},
    });

    feed.stop();
    input.write('{"message":"after"}\n');
    await settle();

    expect(lines).toEqual([]);
  });

  it("can be stopped twice", async () => {
    // `stop` runs from the `exit` handler, which may follow a stop the quit path already did.
    const feed = createStreamFeed(new PassThrough());
    feed.start({ onLine: () => {}, onEnd: () => {} });

    expect(() => {
      feed.stop();
      feed.stop();
    }).not.toThrow();
  });

  it("offers no control channel, so the viewer cannot assume one", () => {
    // `send` is the seam a socket feed would fill. A stdin feed must leave it absent rather than
    // present and silent, or a caller would have no way to tell that nothing is listening.
    expect(createStreamFeed(new PassThrough()).send).toBeUndefined();
  });
});
