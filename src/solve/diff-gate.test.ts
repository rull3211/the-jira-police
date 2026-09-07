import { describe, expect, it } from "vitest";

import {
  DiffParseError,
  type FileChange,
  checkDiff,
  parseNumstat,
  pathEscapes,
} from "./diff-gate.ts";

/**
 * Written out rather than inlined as `\0`, because `"\0"` immediately followed
 * by a digit is an octal escape and a syntax error in a strict-mode module.
 */
const NUL = "\u0000";

const ok = (path: string, added = 1, removed = 1): FileChange => ({ path, added, removed });

/** The reasons, joined, for tests that care that a rule fired rather than which. */
function reasonsFor(changes: readonly FileChange[]): string {
  const verdict = checkDiff(changes);
  return verdict.ok ? "" : verdict.reasons.join("\n");
}

describe("pathEscapes", () => {
  it("accepts the ordinary case", () => {
    expect(pathEscapes("src/solve/claim.ts")).toBe(false);
    expect(pathEscapes("a.ts")).toBe(false);
  });

  it("refuses anything that climbs out of the worktree", () => {
    for (const path of [
      "../secrets.txt",
      "src/../../elsewhere/file",
      "..",
      "src/../src/a.ts", // stays inside, but is still refused — see the doc comment
    ]) {
      expect(pathEscapes(path)).toBe(true);
    }
  });

  it("refuses absolute paths in every form git does not emit", () => {
    for (const path of ["/usr/local/thing", "//server/share/x", "C:/Windows/system32", "c:x"]) {
      expect(pathEscapes(path)).toBe(true);
    }
  });

  it("refuses a backslash rather than guessing what it separates", () => {
    // The attack this blocks: `.github\workflows\ci.yml` is one filename to a
    // POSIX regex and two path segments to Windows git, so a gate that let it
    // through would report "not a CI file" about a CI file.
    expect(pathEscapes(".github\\workflows\\ci.yml")).toBe(true);
  });

  it("refuses an embedded NUL and the empty path", () => {
    expect(pathEscapes(`a${NUL}b`)).toBe(true);
    expect(pathEscapes("")).toBe(true);
    expect(pathEscapes("./")).toBe(true);
  });
});

describe("parseNumstat", () => {
  it("reads ordinary records", () => {
    expect(parseNumstat(`3\t1\tsrc/a.ts${NUL}12\t0\tsrc/b.ts${NUL}`)).toEqual([
      { path: "src/a.ts", added: 3, removed: 1 },
      { path: "src/b.ts", added: 12, removed: 0 },
    ]);
  });

  it("returns nothing for an empty stream", () => {
    expect(parseNumstat("")).toEqual([]);
  });

  it("reads a rename as both of its paths", () => {
    // The source is kept so a run cannot move a forbidden file to an innocuous
    // name and have only the innocuous half inspected.
    expect(parseNumstat(`1\t1\t${NUL}old/x.ts${NUL}new/y.ts${NUL}`)).toEqual([
      { path: "old/x.ts", added: 0, removed: 0 },
      { path: "new/y.ts", added: 1, removed: 1 },
    ]);
  });

  it("marks a binary change rather than reading it as zero lines", () => {
    // numstat writes `-` for binary. Parsed as 0 it would look like the
    // smallest possible change instead of an unreviewable one.
    expect(parseNumstat(`-\t-\timg/logo.png${NUL}`)).toEqual([
      { path: "img/logo.png", added: null, removed: null },
    ]);
  });

  it("keeps a path containing a newline as one record", () => {
    // This is the whole reason for -z. Without it git would quote and escape
    // this name, and a line-oriented parser would see a second numstat record
    // whose contents the model chose.
    const changes = parseNumstat(`1\t0\tsrc/we\nird.ts${NUL}`);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.path).toBe("src/we\nird.ts");
  });

  it("throws rather than guessing at a malformed record", () => {
    // A numstat this cannot read is not a diff that failed the gate; it is a
    // gate that does not know what it is looking at, and the caller must be
    // able to tell those apart.
    expect(() => parseNumstat(`1\tsrc/a.ts${NUL}`)).toThrow(DiffParseError);
    expect(() => parseNumstat(`x\t1\tsrc/a.ts${NUL}`)).toThrow(DiffParseError);
    expect(() => parseNumstat(`1\t1\t${NUL}only-one-half${NUL}`)).toThrow(DiffParseError);
  });
});

describe("checkDiff — the plan's named refusals", () => {
  it("refuses a lockfile", () => {
    expect(reasonsFor([ok("pnpm-lock.yaml")])).toContain("dependency change");
    expect(reasonsFor([ok("packages/web/package-lock.json")])).toContain("dependency change");
  });

  it("refuses the CI directory", () => {
    expect(reasonsFor([ok(".github/workflows/ci.yml")])).toContain("CI privilege");
  });

  it("refuses a path escape", () => {
    expect(reasonsFor([ok("../../somewhere/else")])).toContain("inside the worktree");
  });

  it("does not refuse on size, however wide the diff is", () => {
    // The fourth family, removed 2026-09-06. This is the mutation guard for its
    // absence: restore either cap and this test fails, which is the only way an
    // absent rule can be held in place by a test at all.
    //
    // The numbers are deliberately far past the caps that used to exist
    // (5 files, 200 lines) rather than one past them, so that a reinstated cap
    // is caught whatever value someone picks for it.
    const wide = Array.from({ length: 40 }, (_unused, index) =>
      ok(`src/f${String(index)}.ts`, 200),
    );

    expect(checkDiff(wide)).toEqual({ ok: true, files: 40, lines: 8040 });
  });

  it("still measures what it no longer refuses", () => {
    // The veto went; the measurement did not. `solve-outcome.ts` prints these
    // two numbers on every verified run, so a reviewer is still told how wide
    // the change was — which was the half of the cap worth keeping.
    const verdict = checkDiff([ok("src/a.ts", 10, 5), ok("src/b.ts", 1, 0)]);

    expect(verdict).toEqual({ ok: true, files: 2, lines: 16 });
  });
});

describe("checkDiff — verification integrity", () => {
  // The category that matters most, because tripping it means the run edited
  // the signal a reviewer would use to judge the run.

  it("refuses the manifest, which defines what the harness runs", () => {
    expect(reasonsFor([ok("package.json")])).toContain("definition of passing");
  });

  it("refuses a tsconfig, including the variant forms", () => {
    expect(reasonsFor([ok("tsconfig.json")])).toContain("without making the code correct");
    expect(reasonsFor([ok("tsconfig.build.json")])).toContain("without making the code correct");
  });

  it("refuses linter and test configuration", () => {
    expect(reasonsFor([ok(".oxlintrc.json")])).toContain("without making the code correct");
    expect(reasonsFor([ok("vitest.config.ts")])).toContain("which tests run");
  });

  it("refuses a POM, which is the Maven equivalent of the manifest", () => {
    expect(reasonsFor([ok("pom.xml")])).toContain("without making the code correct");
    expect(reasonsFor([ok("modules/api/pom.xml")])).toContain("without making the code correct");
  });

  it("refuses the Maven wrapper even though the harness does not run it", () => {
    // `verify.ts` invokes `mvn` from PATH, so editing `mvnw` cannot change this
    // run's verdict. It changes everyone else's, which is the wider blast
    // radius and the reason this is refused rather than merely ignored.
    for (const path of [
      "mvnw",
      "mvnw.cmd",
      "tools/mvnw",
      ".mvn/wrapper/maven-wrapper.properties",
    ]) {
      expect(reasonsFor([ok(path)])).toContain("which build actually runs");
    }
  });

  it("does not refuse a source file that merely mentions a build path", () => {
    // The Maven patterns are anchored to a whole path segment at both ends, and
    // this list is one path per anchor: drop any one of the four and the
    // corresponding entry here is refused for containing a build path's name as
    // a substring. `pom.xml.ts` is a fixture, `parent-pom.xml` is not the POM
    // the build reads, `mvnwrapper.ts` is not the wrapper, and `legacy-mvnw` is
    // not `mvnw`. Refusing any of them blocks an ordinary fix.
    for (const path of [
      "src/fixtures/pom.xml.ts",
      "src/fixtures/parent-pom.xml",
      "src/mvnwrapper.ts",
      "src/tools/legacy-mvnw",
      "src/gen.mvn/notes.md",
    ]) {
      expect(checkDiff([ok(path, 3, 1)]).ok).toBe(true);
    }
  });

  it("refuses these regardless of how small the change is", () => {
    // Size does not enter into it, and never did — this rule was exempt from
    // the caps back when there were caps. A one-line edit to the manifest is
    // the dangerous size, not the safe one, because the danger is what the line
    // says rather than how many there are.
    const verdict = checkDiff([ok("package.json", 1, 1)]);

    expect(verdict.ok).toBe(false);
  });
});

describe("checkDiff — the rest", () => {
  it("accepts a small, ordinary fix", () => {
    const verdict = checkDiff([
      ok("src/app/favicon.ts", 4, 2),
      ok("src/app/favicon.test.ts", 20, 0),
    ]);

    expect(verdict).toEqual({ ok: true, files: 2, lines: 26 });
  });

  it("refuses an empty diff", () => {
    // A run that edits a file and reverts it arrives here looking exactly like
    // success, and would otherwise open a PR containing nothing.
    expect(reasonsFor([])).toContain("nothing was fixed");
  });

  it("refuses a binary change", () => {
    expect(reasonsFor([{ path: "img/logo.png", added: null, removed: null }])).toContain("binary");
  });

  it("refuses the agent's own configuration", () => {
    // A run that may edit these can widen what the next run is allowed to do,
    // which makes the sandbox a formality.
    expect(reasonsFor([ok(".claude/settings.json")])).toContain("next run");
    expect(reasonsFor([ok(".storecode/some-config")])).toContain("next run");
  });

  it("refuses a secrets file without needing to read it", () => {
    expect(reasonsFor([ok(".env")])).toContain("credentials");
    expect(reasonsFor([ok("apps/web/.env.production")])).toContain("credentials");
  });

  it("does not mistake the CI directory for the git database", () => {
    // `.git` and `.github` are separate rules and neither may shadow the other;
    // if the first pattern matched both, the CI reason would never be given.
    expect(reasonsFor([ok(".github/workflows/ci.yml")])).not.toContain("rewrites history");
    expect(reasonsFor([ok(".git/config")])).toContain("rewrites history");
  });

  it("does not refuse an ordinary file whose name merely contains a forbidden word", () => {
    // The rules are anchored to path segments. Over-refusing is cheap but it is
    // still wrong, and a gate that cries wolf gets widened by whoever is on call.
    const verdict = checkDiff([ok("src/github-client.ts"), ok("src/env-parser.ts")]);

    expect(verdict.ok).toBe(true);
  });

  it("reports every reason at once, not just the first", () => {
    // One review, not four.
    const verdict = checkDiff([ok("package.json"), ok("pnpm-lock.yaml"), ok("../x")]);

    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? [] : verdict.reasons).toHaveLength(3);
  });

  it("says nothing about the contents of a path it refused as unsafe", () => {
    // The pattern rules assume a normal relative path. Running them on one that
    // escaped would produce a reason implying the path had been understood.
    const verdict = checkDiff([ok("../../.github/workflows/ci.yml")]);

    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? [] : verdict.reasons).toHaveLength(1);
  });

  it("counts both halves of a rename, via the parser", () => {
    const verdict = checkDiff(parseNumstat(`40\t10\t${NUL}src/old.ts${NUL}src/new.ts${NUL}`));

    expect(verdict).toEqual({ ok: true, files: 2, lines: 50 });
  });

  it("catches a forbidden file being renamed out of the way", () => {
    expect(
      reasonsFor(parseNumstat(`0\t0\t${NUL}.github/workflows/ci.yml${NUL}docs/ci.yml${NUL}`)),
    ).toContain("CI privilege");
  });
});
