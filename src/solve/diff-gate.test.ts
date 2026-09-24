import { describe, expect, it } from "vitest";

import {
  DiffParseError,
  FORBIDDEN_PATHS,
  type FileChange,
  VERIFICATION_PATHS,
  checkDiff,
  parseNumstat,
  pathEscapes,
  plannedPathRefusals,
} from "./diff-gate.ts";

/** Written out rather than inlined as `\0`: `"\0"` immediately followed by a digit is an octal escape and a syntax error in strict mode. */
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
    // One filename to a POSIX regex, two path segments to Windows git; letting it through would misreport a CI file.
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
    // The source is kept so a run cannot move a forbidden file to an innocuous name and have only that half inspected.
    expect(parseNumstat(`1\t1\t${NUL}old/x.ts${NUL}new/y.ts${NUL}`)).toEqual([
      { path: "old/x.ts", added: 0, removed: 0 },
      { path: "new/y.ts", added: 1, removed: 1 },
    ]);
  });

  it("marks a binary change rather than reading it as zero lines", () => {
    // numstat writes `-` for binary; parsed as 0 it would look like the smallest change instead of an unreviewable one.
    expect(parseNumstat(`-\t-\timg/logo.png${NUL}`)).toEqual([
      { path: "img/logo.png", added: null, removed: null },
    ]);
  });

  it("keeps a path containing a newline as one record", () => {
    // The whole reason for -z: without it a line-oriented parser would see a second numstat record whose contents the model chose.
    const changes = parseNumstat(`1\t0\tsrc/we\nird.ts${NUL}`);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.path).toBe("src/we\nird.ts");
  });

  it("throws rather than guessing at a malformed record", () => {
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
    // Far past any cap that used to exist, so a reinstated cap is caught whatever value someone picks.
    const wide = Array.from({ length: 40 }, (_unused, index) =>
      ok(`src/f${String(index)}.ts`, 200),
    );

    expect(checkDiff(wide)).toEqual({ ok: true, files: 40, lines: 8040, bumps: [] });
  });

  it("still measures what it no longer refuses", () => {
    const verdict = checkDiff([ok("src/a.ts", 10, 5), ok("src/b.ts", 1, 0)]);

    expect(verdict).toEqual({ ok: true, files: 2, lines: 16, bumps: [] });
  });
});

describe("checkDiff — verification integrity", () => {
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
    // Editing `mvnw` cannot change this run's verdict, but it changes everyone else's.
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
    // The Maven patterns are anchored to a whole path segment at both ends.
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
    // The danger is what the line says, not how many there are.
    const verdict = checkDiff([ok("package.json", 1, 1)]);

    expect(verdict.ok).toBe(false);
  });
});

describe("checkDiff — the dependency-bump exception", () => {
  const bump = {
    path: "pom.xml",
    line: 15,
    property: "lisa-services-api.version",
    dependencies: ["storebrand.lisa.services:lisa-services-api"],
    from: "3.181",
    to: "3.203",
  };
  const allowed = (path: string) => new Map([[path, { ok: true, bumps: [bump] } as const]]);

  it("passes a pom.xml the judge found to be only a bump, and carries the bump out", () => {
    const verdict = checkDiff([ok("src/Main.java"), ok("pom.xml")], allowed("pom.xml"));

    expect(verdict).toEqual({ ok: true, files: 2, lines: 4, bumps: [bump] });
  });

  it("refuses a pom.xml the judge refused, and says why in both voices", () => {
    const verdict = checkDiff(
      [ok("pom.xml")],
      new Map([["pom.xml", { ok: false, reason: "line 7 is project>parent>version" } as const]]),
    );

    expect(verdict.ok ? "" : verdict.reasons.join("\n")).toBe(
      "pom.xml: the Maven build is defined here — a skipped test, a dropped module or a relaxed plugin makes the build pass without making the code correct — and this change is more than a dependency version: line 7 is project>parent>version",
    );
  });

  it("lends the exception to no rule but the one that carries it", () => {
    for (const path of ["package.json", "mvnw", "tsconfig.json"]) {
      expect(checkDiff([ok(path)], allowed(path)).ok).toBe(false);
    }
  });

  it("still refuses a pom.xml somewhere no file may be, whatever the judge said", () => {
    expect(checkDiff([ok(".claude/pom.xml")], allowed(".claude/pom.xml")).ok).toBe(false);
  });
});

describe("checkDiff — the rest", () => {
  it("accepts a small, ordinary fix", () => {
    const verdict = checkDiff([
      ok("src/app/favicon.ts", 4, 2),
      ok("src/app/favicon.test.ts", 20, 0),
    ]);

    expect(verdict).toEqual({ ok: true, files: 2, lines: 26, bumps: [] });
  });

  it("refuses an empty diff", () => {
    expect(reasonsFor([])).toContain("nothing was fixed");
  });

  it("refuses a binary change", () => {
    expect(reasonsFor([{ path: "img/logo.png", added: null, removed: null }])).toContain("binary");
  });

  it("refuses the agent's own configuration", () => {
    expect(reasonsFor([ok(".claude/settings.json")])).toContain("next run");
    expect(reasonsFor([ok(".storecode/some-config")])).toContain("next run");
  });

  it("refuses a secrets file without needing to read it", () => {
    expect(reasonsFor([ok(".env")])).toContain("credentials");
    expect(reasonsFor([ok("apps/web/.env.production")])).toContain("credentials");
  });

  it("does not mistake the CI directory for the git database", () => {
    expect(reasonsFor([ok(".github/workflows/ci.yml")])).not.toContain("rewrites history");
    expect(reasonsFor([ok(".git/config")])).toContain("rewrites history");
  });

  it("does not refuse an ordinary file whose name merely contains a forbidden word", () => {
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
    const verdict = checkDiff([ok("../../.github/workflows/ci.yml")]);

    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? [] : verdict.reasons).toHaveLength(1);
  });

  it("counts both halves of a rename, via the parser", () => {
    const verdict = checkDiff(parseNumstat(`40\t10\t${NUL}src/old.ts${NUL}src/new.ts${NUL}`));

    expect(verdict).toEqual({ ok: true, files: 2, lines: 50, bumps: [] });
  });

  it("catches a forbidden file being renamed out of the way", () => {
    expect(
      reasonsFor(parseNumstat(`0\t0\t${NUL}.github/workflows/ci.yml${NUL}docs/ci.yml${NUL}`)),
    ).toContain("CI privilege");
  });
});

describe("plannedPathRefusals", () => {
  const worktreePath = "/tmp/solve/SSX-3918";

  it("names each path refused by name in a plan, and only those", () => {
    const reasons = plannedPathRefusals(
      [
        "mvnw",
        "src/main/java/no/storebrand/orders/f2100/adapter/F2100Service.java",
        "docs/integrations/f2100.md",
      ],
      worktreePath,
    );

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/^mvnw: the Maven wrapper/u);
  });

  it("leaves pom.xml to the gate, since only its diff can show a dependency bump", () => {
    // SSX-3918's plan: the pom change it needed is a bump, which a path cannot reveal.
    expect(
      plannedPathRefusals(
        ["pom.xml", "src/main/java/no/storebrand/orders/f2100/adapter/F2100Service.java"],
        worktreePath,
      ),
    ).toEqual([]);
    expect(checkDiff([ok("pom.xml")]).ok).toBe(false);
  });

  it("refuses nothing in an ordinary plan", () => {
    expect(
      plannedPathRefusals(["src/app/head.tsx", "src/app/head.test.tsx"], worktreePath),
    ).toEqual([]);
  });

  it("gives the same answer as the gate, for every rule that refuses by name alone", () => {
    // One path per rule; the first loop fails when a rule is added without one.
    const samples = [
      ".git/config",
      ".github/workflows/ci.yml",
      ".circleci/config.yml",
      "Jenkinsfile",
      ".env.local",
      ".claude/settings.json",
      "pnpm-lock.yaml",
      "package.json",
      "tsconfig.base.json",
      "eslint.config.js",
      "vitest.config.ts",
      "mvnw",
      // Both lists at once, so a plan reports both reasons exactly as the gate does.
      ".claude/package.json",
    ];
    for (const rule of [...FORBIDDEN_PATHS, ...VERIFICATION_PATHS]) {
      if (rule.unless === undefined) {
        expect(samples.some((sample) => rule.pattern.test(sample))).toBe(true);
      }
    }
    for (const sample of samples) {
      const gate = checkDiff([ok(sample)]);
      expect(plannedPathRefusals([sample], worktreePath)).toEqual(gate.ok ? [] : gate.reasons);
    }
  });

  it("reads a path under the worktree the same as the relative one", () => {
    // Models name a file by the absolute path they read it at; that is the same file, not an escape.
    expect(plannedPathRefusals([`${worktreePath}/src/app/head.tsx`], worktreePath)).toEqual([]);
    expect(plannedPathRefusals([`${worktreePath}/mvnw`], `${worktreePath}/`)).toEqual(
      plannedPathRefusals(["mvnw"], worktreePath),
    );
  });

  it("refuses a plan to change a file outside the worktree", () => {
    for (const planned of [
      "/repos/lisa-services-api/pom.xml",
      "../lisa-services-api/src/Reason.java",
      `${worktreePath}-salvaged/src/app/head.tsx`,
    ]) {
      expect(plannedPathRefusals([planned], worktreePath)).toEqual([
        `${JSON.stringify(planned)}: not a path inside the worktree`,
      ]);
    }
  });
});
