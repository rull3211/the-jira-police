import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { stopOnBrokenPipe } from "./broken-pipe.ts";

function epipe(): NodeJS.ErrnoException {
  return Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
}

describe("stopOnBrokenPipe", () => {
  it("stops the daemon when the reader closes the pipe", () => {
    const stream = new EventEmitter();
    const stop = vi.fn();

    stopOnBrokenPipe([stream], stop);
    stream.emit("error", epipe());

    expect(stop).toHaveBeenCalledOnce();
  });

  it("watches every stream it is given, because 2>&1 breaks both at once", () => {
    const out = new EventEmitter();
    const err = new EventEmitter();
    const stop = vi.fn();

    stopOnBrokenPipe([out, err], stop);
    out.emit("error", epipe());
    err.emit("error", epipe());

    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("rethrows a write failure that is not a broken pipe, rather than swallowing it", () => {
    const stream = new EventEmitter();
    const stop = vi.fn();
    const disk = Object.assign(new Error("write ENOSPC"), { code: "ENOSPC" });

    stopOnBrokenPipe([stream], stop);

    expect(() => stream.emit("error", disk)).toThrow("ENOSPC");
    expect(stop).not.toHaveBeenCalled();
  });

  // Attaching the listener is the whole guard; a module that exports it and is never called is the
  // failure this cannot otherwise see, and the daemon's wiring is not reachable from a unit test.
  it("is wired into the daemon's shutdown", () => {
    const entry = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

    expect(entry).toContain("stopOnBrokenPipe");
    expect(entry).toMatch(/stopOnBrokenPipe\(\s*\[process\.stdout, process\.stderr\]/);
  });
});
