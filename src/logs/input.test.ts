import { describe, expect, it } from "vitest";

import { decodeKeys } from "./input.ts";

describe("decodeKeys", () => {
  it("reads an arrow as one key, not as three characters", () => {
    // Read character by character, `ESC [ A` would toggle whichever source was handed `A`.
    expect(decodeKeys("\u001B[A")).toEqual(["up"]);
    expect(decodeKeys("\u001B[B")).toEqual(["down"]);
  });

  it("reads the paging keys, which end in a tilde rather than a letter", () => {
    expect(decodeKeys("\u001B[5~")).toEqual(["pageup"]);
    expect(decodeKeys("\u001B[6~")).toEqual(["pagedown"]);
  });

  it("splits a chunk holding several keystrokes, in order", () => {
    // Raw mode delivers whatever arrived together; a fast typist produces exactly this.
    expect(decodeKeys("1\u001B[A2")).toEqual(["1", "up", "2"]);
  });

  it("treats ctrl-c as quit, since raw mode raises no signal", () => {
    expect(decodeKeys("\u0003")).toEqual(["q"]);
  });

  it("reads a lone escape as escape rather than waiting for a sequence that may not come", () => {
    expect(decodeKeys("\u001B")).toEqual(["escape"]);
  });

  it("resolves a truncated sequence towards the key that closes the viewer", () => {
    // A viewer that will not close is worse than one that closes a keystroke early.
    expect(decodeKeys("\u001B[")).toEqual(["escape"]);
  });

  it("swallows a CSI sequence it has no meaning for, rather than typing it", () => {
    // A mouse report or a cursor-position answer must not toggle filters on its way through.
    expect(decodeKeys("\u001B[200~")).toEqual([]);
    expect(decodeKeys("a\u001B[H b")).toEqual(["a", " ", "b"]);
  });

  it("passes ordinary characters through, which is what makes the filter keys work", () => {
    expect(decodeKeys("q")).toEqual(["q"]);
    expect(decodeKeys("1f")).toEqual(["1", "f"]);
  });

  it("returns nothing for an empty chunk", () => {
    expect(decodeKeys("")).toEqual([]);
  });
});
