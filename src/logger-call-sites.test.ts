import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LOG_SOURCES } from "./logger.ts";
import { agrees, maskComments, scanLogCallSites } from "./logger-call-sites.ts";

const SRC = import.meta.dirname;

function productionFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...productionFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      found.push(full);
    }
  }
  return found;
}

function relative(file: string): string {
  return file.slice(SRC.length + 1);
}

describe("agrees", () => {
  it("accepts the namespace itself and anything under it", () => {
    expect(agrees("solve", "solve")).toBe(true);
    expect(agrees("solve", "solve.claim.failed")).toBe(true);
  });

  it("rejects a different namespace, including one that merely starts the same way", () => {
    expect(agrees("solve", "watch.sweep.done")).toBe(false);
    // The dot matters: `solve-once` is a separate source, not a message under `solve`.
    expect(agrees("solve", "solve-once.dry_run")).toBe(false);
  });
});

describe("maskComments", () => {
  it("blanks comments while preserving offsets, so line numbers survive", () => {
    const masked = maskComments('const a = 1; // logger.info("x")\nconst b = 2;');

    expect(masked).toHaveLength('const a = 1; // logger.info("x")\nconst b = 2;'.length);
    expect(masked).not.toContain("logger.info");
    expect(masked.split("\n")[1]).toBe("const b = 2;");
  });

  it("leaves string literals alone, including one holding comment syntax", () => {
    expect(maskComments('const a = "// not a comment";')).toBe('const a = "// not a comment";');
  });
});

describe("scanLogCallSites", () => {
  it("measures a call against the source its logger was created with", () => {
    const scan = scanLogCallSites(
      'const log = createLogger("solve");\nlog.info("solve.claim.failed", {});',
    );

    expect(scan.bindings.get("log")).toBe("solve");
    expect(scan.disagreements).toHaveLength(0);
    expect(scan.calls[0]?.message).toBe("solve.claim.failed");
  });

  it("reports a message that belongs to another source", () => {
    const scan = scanLogCallSites(
      'const log = createLogger("solve");\nlog.info("watch.sweep.done", {});',
    );

    expect(scan.disagreements).toHaveLength(1);
    expect(scan.disagreements[0]).toMatchObject({
      line: 2,
      source: "solve",
      message: "watch.sweep.done",
    });
  });

  it("follows a level aliased to a variable, which `receiver.level(` cannot see", () => {
    // `solve-run.ts` picks warn-or-info at runtime and then calls the result as a bare function.
    const scan = scanLogCallSites(
      'const log = createLogger("solve");\nconst record = quiet ? log.warn : log.info;\nrecord("watch.chain.finished", {});',
    );

    expect(scan.disagreements).toHaveLength(1);
    expect(scan.disagreements[0]?.message).toBe("watch.chain.finished");
  });

  it("reports rather than guesses when a message is not a literal", () => {
    const scan = scanLogCallSites(
      'const log = createLogger("solve");\nlog.info(`solve.${kind}`, {});',
    );

    expect(scan.calls).toHaveLength(0);
    expect(scan.unchecked[0]).toMatchObject({ reason: "non-literal-message" });
  });

  it("ignores a call inside a comment", () => {
    const scan = scanLogCallSites(
      'const log = createLogger("solve");\n// log.info("watch.nope", {});',
    );

    expect(scan.calls).toHaveLength(0);
    expect(scan.disagreements).toHaveLength(0);
  });
});

describe("the tree", () => {
  const files = productionFiles(SRC);
  const scans = files.map((file) => ({
    file,
    scan: scanLogCallSites(readFileSync(file, "utf8")),
  }));

  it("has every log message under the source its logger declared", () => {
    const wrong = scans.flatMap(({ file, scan }) =>
      scan.disagreements.map(
        (d) => `${relative(file)}:${String(d.line)} src="${d.source}" message="${d.message}"`,
      ),
    );

    expect(wrong).toEqual([]);
  });

  it("leaves nothing the scan could not decide", () => {
    // An unchecked call is a hole in this guard, not a pass. If one turns up legitimately, the
    // scanner is what changes — suppressing it here would make the whole check advisory.
    const holes = scans.flatMap(({ file, scan }) =>
      scan.unchecked.map((u) => `${relative(file)}:${String(u.line)} ${u.reason} (${u.text})`),
    );

    expect(holes).toEqual([]);
  });

  it("finds every log call the raw text contains, so masking cannot drop one silently", () => {
    // Independent count over unmasked text. Masking can only remove matches, so a shortfall here
    // means the scan lost a call site and every assertion above it is weaker than it looks.
    for (const { file, scan } of scans) {
      const bindings = [...scan.bindings.keys()];
      if (bindings.length === 0) {
        continue;
      }

      const raw = readFileSync(file, "utf8");
      const crude = [
        ...raw.matchAll(
          new RegExp(String.raw`\b(?:${bindings.join("|")})\.(?:debug|info|warn|error)\s*\(`, "gu"),
        ),
      ].length;

      const seen = scan.calls.filter((c) => bindings.includes(c.binding)).length;
      expect(`${relative(file)}: ${String(seen)}`).toBe(`${relative(file)}: ${String(crude)}`);
    }
  });

  it("declares no source that nothing emits", () => {
    const used = new Set(scans.flatMap(({ scan }) => Array.from(scan.bindings.values())));

    expect([...LOG_SOURCES].filter((source) => !used.has(source))).toEqual([]);
  });
});
