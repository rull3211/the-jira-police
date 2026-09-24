import { describe, expect, it } from "vitest";

import { judgeBumps, judgePomChange, textsFromFullDiff } from "./dependency-bump.ts";
import type { CommandResult, CommandRunner } from "./worktree.ts";

/** Every place a `<version>` can sit in a real POM, so each placement below is a line of this file. */
const BASE = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<project xmlns="http://maven.apache.org/POM/4.0.0">',
  "    <modelVersion>4.0.0</modelVersion>",
  "    <artifactId>insurance-commerce-rest-api</artifactId>",
  "    <version>1.321.0</version>",
  "    <!--",
  "        <version>0.1</version>",
  "    -->",
  "    <properties>",
  "        <lisa-services-api.version>3.181</lisa-services-api.version>",
  "        <shared.version>2.1</shared.version>",
  "        <unused.version>1.0</unused.version>",
  "        <maven.test.skip>false</maven.test.skip>",
  "        <aliased.version>4.0</aliased.version>",
  "        <alias.version>${aliased.version}</alias.version>",
  "        <guava.version>33.0</guava.version>",
  "    </properties>",
  "    <dependencyManagement>",
  "        <dependencies>",
  "            <dependency>",
  "                <groupId>com.example</groupId>",
  "                <artifactId>bom</artifactId>",
  "                <version>5.0</version>",
  "                <type>pom</type>",
  "                <scope>import</scope>",
  "            </dependency>",
  "        </dependencies>",
  "    </dependencyManagement>",
  "    <dependencies>",
  "        <dependency>",
  "            <groupId>storebrand.lisa.services</groupId>",
  "            <artifactId>lisa-services-api</artifactId>",
  "            <version>${lisa-services-api.version}</version>",
  "        </dependency>",
  "        <dependency>",
  "            <groupId>org.mockito</groupId>",
  "            <artifactId>mockito-core</artifactId>",
  "            <version>5.11.0</version>",
  "            <scope>test</scope>",
  "        </dependency>",
  "        <dependency>",
  "            <groupId>com.example</groupId>",
  "            <artifactId>shared</artifactId>",
  "            <version>${shared.version}</version>",
  "        </dependency>",
  "        <dependency>",
  "            <groupId>com.example</groupId>",
  "            <artifactId>aliased</artifactId>",
  "            <version>${aliased.version}</version>",
  "        </dependency>",
  "        <dependency>",
  "            <groupId>com.google.guava</groupId>",
  "            <artifactId>guava</artifactId>",
  "            <version>${guava.version}-jre</version>",
  "        </dependency>",
  "    </dependencies>",
  "    <build>",
  "        <plugins>",
  "            <plugin>",
  "                <groupId>org.apache.maven.plugins</groupId>",
  "                <artifactId>maven-surefire-plugin</artifactId>",
  "                <version>3.2.5</version>",
  "                <dependencies>",
  "                    <dependency>",
  "                        <groupId>com.example</groupId>",
  "                        <artifactId>shared-plugin-dep</artifactId>",
  "                        <version>${shared.version}</version>",
  "                    </dependency>",
  "                    <dependency>",
  "                        <groupId>org.junit.platform</groupId>",
  "                        <artifactId>junit-platform-launcher</artifactId>",
  "                        <version>1.10.2</version>",
  "                    </dependency>",
  "                </dependencies>",
  "            </plugin>",
  "        </plugins>",
  "    </build>",
  "    <profiles>",
  "        <profile>",
  "            <id>ci</id>",
  "            <dependencies>",
  "                <dependency>",
  "                    <groupId>com.example</groupId>",
  "                    <artifactId>ci-only</artifactId>",
  "                    <version>1.2</version>",
  "                </dependency>",
  "            </dependencies>",
  "        </profile>",
  "    </profiles>",
  "</project>",
  "",
].join("\n");

/** BASE under a parent, which can read any property BASE sets. SSX-3918's pom has none. */
const WITH_PARENT = BASE.replace(
  "    <modelVersion>4.0.0</modelVersion>\n",
  [
    "    <modelVersion>4.0.0</modelVersion>",
    "    <parent>",
    "        <groupId>org.springframework.boot</groupId>",
    "        <artifactId>spring-boot-starter-parent</artifactId>",
    "        <version>3.3.1</version>",
    "    </parent>",
    "",
  ].join("\n"),
);

/** BASE with one exact, unique line replaced. */
function changed(line: string, replacement: string, base = BASE): string {
  expect(base.split("\n").filter((candidate) => candidate === line)).toHaveLength(1);
  return base.replace(`${line}\n`, `${replacement}\n`);
}

/** 1-based line of an exact line of BASE. */
function lineOf(line: string): number {
  return BASE.split("\n").indexOf(line) + 1;
}

function judge(current: string, otherPoms = false) {
  return judgePomChange("pom.xml", { base: BASE, current }, otherPoms);
}

function reasonOf(verdict: ReturnType<typeof judge>): string {
  return verdict.ok ? "" : verdict.reason;
}

describe("judgePomChange — what it allows", () => {
  it("allows SSX-3918's bump: a property used only as one dependency's version", () => {
    const line = "        <lisa-services-api.version>3.181</lisa-services-api.version>";
    const verdict = judge(changed(line, line.replace("3.181", "3.203")));

    expect(verdict).toEqual({
      ok: true,
      bumps: [
        {
          path: "pom.xml",
          line: lineOf(line),
          property: "lisa-services-api.version",
          dependencies: ["storebrand.lisa.services:lisa-services-api"],
          from: "3.181",
          to: "3.203",
        },
      ],
    });
  });

  it("allows a literal version inside a dependency, test scope included", () => {
    const line = "            <version>5.11.0</version>";
    const verdict = judge(changed(line, "            <version>5.12.0</version>"));

    expect(verdict).toMatchObject({
      ok: true,
      bumps: [{ property: null, dependencies: ["org.mockito:mockito-core"], from: "5.11.0" }],
    });
  });

  it("allows a version under dependencyManagement", () => {
    const line = "                <version>5.0</version>";
    expect(judge(changed(line, "                <version>5.1</version>")).ok).toBe(true);
  });

  it("allows a literal bump even when another pom.xml exists, since it names no property", () => {
    const line = "            <version>5.11.0</version>";
    expect(judge(changed(line, "            <version>5.12.0</version>"), true).ok).toBe(true);
  });

  it("allows a SNAPSHOT to be left for a release", () => {
    const base = changed(
      "        <lisa-services-api.version>3.181</lisa-services-api.version>",
      "        <lisa-services-api.version>3.182-SNAPSHOT</lisa-services-api.version>",
    );
    const current = changed(
      "        <lisa-services-api.version>3.182-SNAPSHOT</lisa-services-api.version>",
      "        <lisa-services-api.version>3.203</lisa-services-api.version>",
      base,
    );
    expect(judgePomChange("pom.xml", { base, current }, false).ok).toBe(true);
  });
});

describe("judgePomChange — what it refuses", () => {
  it("refuses the version of a plugin, which is part of the build", () => {
    const line = "                <version>3.2.5</version>";
    expect(reasonOf(judge(changed(line, "                <version>3.3.0</version>")))).toContain(
      "project>build>plugins>plugin>version",
    );
  });

  it("refuses the parent's version and the project's own", () => {
    const parent = changed(
      "        <version>3.3.1</version>",
      "        <version>3.4.0</version>",
      WITH_PARENT,
    );
    expect(
      reasonOf(judgePomChange("pom.xml", { base: WITH_PARENT, current: parent }, false)),
    ).toContain("project>parent>version");
    const own = changed("    <version>1.321.0</version>", "    <version>1.322.0</version>");
    expect(reasonOf(judge(own))).toContain("project>version");
  });

  it("refuses a property bump under a parent, which can read the property too", () => {
    const line = "        <lisa-services-api.version>3.181</lisa-services-api.version>";
    const current = changed(line, line.replace("3.181", "3.203"), WITH_PARENT);
    expect(reasonOf(judgePomChange("pom.xml", { base: WITH_PARENT, current }, false))).toContain(
      "parent could use it too",
    );
  });

  it("still allows a literal bump under a parent, since it names no property", () => {
    const current = changed(
      "            <version>5.11.0</version>",
      "            <version>5.12.0</version>",
      WITH_PARENT,
    );
    expect(judgePomChange("pom.xml", { base: WITH_PARENT, current }, false).ok).toBe(true);
  });

  it("refuses a dependency inside a plugin or a profile", () => {
    for (const [line, replacement, chain] of [
      [
        "                    <version>1.2</version>",
        "                    <version>1.3</version>",
        "project>profiles>profile>dependencies>dependency>version",
      ],
      [
        "                        <version>1.10.2</version>",
        "                        <version>1.11.0</version>",
        "project>build>plugins>plugin>dependencies>dependency>version",
      ],
    ] as const) {
      expect(reasonOf(judge(changed(line, replacement)))).toContain(chain);
    }
  });

  it("refuses a property that a plugin also uses", () => {
    const line = "        <shared.version>2.1</shared.version>";
    expect(reasonOf(judge(changed(line, line.replace("2.1", "2.2"))))).toContain(
      "project>build>plugins>plugin>dependencies>dependency>version",
    );
  });

  it("refuses a property that another property uses", () => {
    const line = "        <aliased.version>4.0</aliased.version>";
    expect(reasonOf(judge(changed(line, line.replace("4.0", "4.1"))))).toContain(
      "project>properties>alias.version",
    );
  });

  it("refuses a property used as only part of a version", () => {
    // `${guava.version}-jre` is still a version, but not one this reader proved is nothing else.
    const line = "        <guava.version>33.0</guava.version>";
    expect(judge(changed(line, line.replace("33.0", "33.1"))).ok).toBe(false);
  });

  it("refuses a property nothing in the file uses, which is how a plugin's own setting looks", () => {
    const line = "        <unused.version>1.0</unused.version>";
    expect(reasonOf(judge(changed(line, line.replace("1.0", "1.1"))))).toContain(
      "nothing here uses",
    );
  });

  it("refuses to flip a setting that is not a version, like maven.test.skip", () => {
    const line = "        <maven.test.skip>false</maven.test.skip>";
    expect(reasonOf(judge(changed(line, line.replace("false", "true"))))).toContain(
      "does not change one version number to another",
    );
  });

  it("refuses a version that can change after review", () => {
    const line = "        <lisa-services-api.version>3.181</lisa-services-api.version>";
    expect(reasonOf(judge(changed(line, line.replace("3.181", "3.204-SNAPSHOT"))))).toContain(
      "can change after review",
    );
  });

  it("refuses a property bump when another pom.xml could use the property", () => {
    const line = "        <lisa-services-api.version>3.181</lisa-services-api.version>";
    expect(reasonOf(judge(changed(line, line.replace("3.181", "3.203")), true))).toContain(
      "another pom.xml",
    );
  });

  it("refuses a line added or removed, even beside a real bump", () => {
    const line = "        <lisa-services-api.version>3.181</lisa-services-api.version>";
    const bumped = changed(line, line.replace("3.181", "3.203"));
    const added = bumped.replace(
      "    <build>\n",
      "    <build>\n        <skipTests>true</skipTests>\n",
    );
    expect(reasonOf(judge(added))).toContain("added or removed");
  });

  it("refuses a second change on the same line as a version", () => {
    const line = "            <version>5.11.0</version>";
    expect(
      reasonOf(
        judge(changed(line, "            <version>5.12.0</version><optional>true</optional>")),
      ),
    ).toContain("more than the value");
  });

  it("refuses a renamed element even when the value looks like a version", () => {
    const line = "            <version>5.11.0</version>";
    expect(reasonOf(judge(changed(line, "            <versio>5.12.0</versio>")))).toContain(
      "more than the value",
    );
  });

  it("refuses a change inside a comment rather than reading it as an element", () => {
    const line = "        <version>0.1</version>";
    expect(reasonOf(judge(changed(line, "        <version>0.2</version>")))).toContain(
      "could not be placed",
    );
  });

  it("refuses when the base cannot be read, rather than guessing its structure", () => {
    const unbalanced = BASE.replace("    </properties>\n", "");
    expect(unbalanced).not.toBe(BASE);
    const line = "            <version>5.11.0</version>";
    const current = changed(line, "            <version>5.12.0</version>", unbalanced);
    expect(reasonOf(judgePomChange("pom.xml", { base: unbalanced, current }, false))).toContain(
      "could not be read as XML",
    );

    const subset = BASE.replace("<project ", '<!DOCTYPE project [<!ENTITY v "9">]>\n<project ');
    const withSubset = changed(line, "            <version>5.12.0</version>", subset);
    expect(judgePomChange("pom.xml", { base: subset, current: withSubset }, false).ok).toBe(false);
  });

  describe("where Maven would read the file differently than this text does", () => {
    const line = "        <lisa-services-api.version>3.181</lisa-services-api.version>";
    const bumpIn = (base: string) =>
      judgePomChange(
        "pom.xml",
        { base, current: changed(line, line.replace("3.181", "3.203"), base) },
        false,
      );
    const withSurefire = (setting: string) =>
      BASE.replace(
        "                <version>3.2.5</version>\n",
        `                <version>3.2.5</version>\n                <configuration>\n                    ${setting}\n                </configuration>\n`,
      );

    it("refuses a property bump when a character reference could spell the property's use", () => {
      // Found by a review from a fresh context: Maven decodes &#36; to $ before it interpolates.
      const base = withSurefire(
        "<skipAfterFailureCount>&#36;{lisa-services-api.version}</skipAfterFailureCount>",
      );
      expect(reasonOf(bumpIn(base))).toContain("character references");
    });

    it("counts surefire's late-bound @{name} as a use", () => {
      const base = withSurefire("<argLine>@{lisa-services-api.version}</argLine>");
      expect(reasonOf(bumpIn(base))).toContain(
        "project>build>plugins>plugin>configuration>argLine",
      );
    });

    it("refuses a property bump in a pom that declares modules, whose files need not be named pom.xml", () => {
      const base = BASE.replace(
        "    <properties>\n",
        "    <modules>\n        <module>child</module>\n    </modules>\n    <properties>\n",
      );
      expect(reasonOf(bumpIn(base))).toContain("modules could use it too");
      const literal = changed(
        "            <version>5.11.0</version>",
        "            <version>5.12.0</version>",
        base,
      );
      expect(judgePomChange("pom.xml", { base, current: literal }, false).ok).toBe(true);
    });

    it("refuses any bump in a file holding a $Id keyword, which git can fill with text the diff never shows", () => {
      const base = BASE.replace("    <!--\n", "    <!-- $Id$ -->\n    <!--\n");
      const literal = changed(
        "            <version>5.11.0</version>",
        "            <version>5.12.0</version>",
        base,
      );
      expect(reasonOf(judgePomChange("pom.xml", { base, current: literal }, false))).toContain(
        "$Id",
      );
    });
  });

  it("reads a quoted > inside an attribute as part of the attribute", () => {
    // Without quote handling this self-closing tag reads as an element that is never closed.
    const base = BASE.replace("    <properties>\n", '    <marker note=">"/>\n    <properties>\n');
    const line = "            <version>5.11.0</version>";
    const current = changed(line, "            <version>5.12.0</version>", base);
    expect(judgePomChange("pom.xml", { base, current }, false).ok).toBe(true);
  });

  it("refuses a base whose close tag names a different element, or that never closes one", () => {
    const line = "            <version>5.11.0</version>";
    for (const base of [
      BASE.replace("    </dependencyManagement>\n", "    </dependencies>\n"),
      BASE.replace("</project>\n", ""),
    ]) {
      expect(base).not.toBe(BASE);
      const current = changed(line, "            <version>5.12.0</version>", base);
      expect(reasonOf(judgePomChange("pom.xml", { base, current }, false))).toContain(
        "could not be read as XML",
      );
    }
  });

  it("refuses a change to the final newline alone", () => {
    expect(judge(BASE.slice(0, -1)).ok).toBe(false);
  });
});

/** A two-line file whose last line lost or gained its final newline on the `marked` side. */
const lastLineDiff = (marked: "-" | "+"): string =>
  [
    "diff --git a/pom.xml b/pom.xml",
    "index b9ea0a898e..8fa9bfcdcc 100644",
    "--- a/pom.xml",
    "+++ b/pom.xml",
    "@@ -1,2 +1,2 @@",
    " <project>",
    ...(marked === "+"
      ? ["-</project>", "+</project>", "\\ No newline at end of file"]
      : ["-</project>", "\\ No newline at end of file", "+</project>"]),
    "",
  ].join("\n");

describe("textsFromFullDiff", () => {
  const diff = [
    "diff --git a/pom.xml b/pom.xml",
    "index b9ea0a898e..8fa9bfcdcc 100644",
    "--- a/pom.xml",
    "+++ b/pom.xml",
    "@@ -1,3 +1,3 @@",
    " <project>",
    "-  <x.version>1</x.version>",
    "+  <x.version>2</x.version>",
    " </project>",
    "",
  ].join("\n");

  it("rebuilds both sides of an ordinary modification", () => {
    expect(textsFromFullDiff(diff)).toEqual({
      base: "<project>\n  <x.version>1</x.version>\n</project>\n",
      current: "<project>\n  <x.version>2</x.version>\n</project>\n",
    });
  });

  it("keeps a missing final newline on the side that lacks it", () => {
    const noNewline = diff.replace(" </project>\n", " </project>\n\\ No newline at end of file\n");
    expect(textsFromFullDiff(noNewline)).toEqual({
      base: "<project>\n  <x.version>1</x.version>\n</project>",
      current: "<project>\n  <x.version>2</x.version>\n</project>",
    });
  });

  it("gives the missing final newline to the one side that lost it, not to both", () => {
    expect(textsFromFullDiff(lastLineDiff("+"))).toEqual({
      base: "<project>\n</project>\n",
      current: "<project>\n</project>",
    });
    expect(textsFromFullDiff(lastLineDiff("-"))).toEqual({
      base: "<project>\n</project>",
      current: "<project>\n</project>\n",
    });
  });

  it("refuses anything but one modification of a file present on both sides", () => {
    for (const refused of [
      diff.replace("index b9ea0a898e..8fa9bfcdcc 100644", "new file mode 100644"),
      diff.replace("index b9ea0a898e..8fa9bfcdcc 100644", "old mode 100644\nnew mode 100755"),
      diff.replace("--- a/pom.xml", "--- /dev/null"),
      diff.replace("@@ -1,3 +1,3 @@", "@@ -5,3 +5,3 @@"),
      `${diff}@@ -40,1 +40,1 @@\n-a\n+b\n`,
      diff.replace("@@ -1,3 +1,3 @@", "@@ -1,4 +1,3 @@"),
      "",
    ]) {
      expect(typeof textsFromFullDiff(refused)).toBe("string");
    }
  });
});

/** Answers `ls-tree` with `tree` and every other command with `diff`. */
function runner(replies: {
  readonly diff?: Partial<CommandResult>;
  readonly tree?: Partial<CommandResult>;
}): { readonly runner: CommandRunner; readonly calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = [];
  const ok: CommandResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  return {
    calls,
    runner: {
      run: (argv) => {
        calls.push([...argv]);
        const reply = argv.includes("ls-tree") ? replies.tree : replies.diff;
        return Promise.resolve({ ...ok, ...reply });
      },
    },
  };
}

describe("judgeBumps", () => {
  const bumpDiff = (from: string, to: string): string =>
    [
      "diff --git a/pom.xml b/pom.xml",
      "index 1111111..2222222 100644",
      "--- a/pom.xml",
      "+++ b/pom.xml",
      `@@ -1,${String(BASE.split("\n").length - 1)} +1,${String(BASE.split("\n").length - 1)} @@`,
      ...BASE.split("\n")
        .slice(0, -1)
        .flatMap((line) =>
          line.includes(`<lisa-services-api.version>${from}<`)
            ? [`-${line}`, `+${line.replace(from, to)}`]
            : [` ${line}`],
        ),
      "",
    ].join("\n");

  const request = { worktreePath: "/tmp/solve/SSX-3918", baseRef: "origin/main", timeoutMs: 1000 };

  it("judges a changed pom.xml and nothing else", async () => {
    const { runner: fake, calls } = runner({
      diff: { stdout: bumpDiff("3.181", "3.203") },
      tree: { stdout: "pom.xml\0src/Main.java\0" },
    });

    const verdicts = await judgeBumps(fake, request, ["pom.xml", "src/Main.java", "package.json"]);

    expect([...verdicts.keys()]).toEqual(["pom.xml"]);
    expect(verdicts.get("pom.xml")).toMatchObject({ ok: true, bumps: [{ to: "3.203" }] });
    // An external diff driver or textconv filter would decide what this reads, so both are off.
    const diffCall = calls.find((argv) => argv.includes("diff")) ?? [];
    expect(diffCall).toEqual(
      expect.arrayContaining(["--no-ext-diff", "--no-textconv", "--literal-pathspecs"]),
    );
  });

  it("asks nothing of git when no changed path is a pom.xml", async () => {
    const { runner: fake, calls } = runner({});

    expect((await judgeBumps(fake, request, ["src/Main.java"])).size).toBe(0);
    expect(calls).toEqual([]);
  });

  it("refuses what it could not read, never assuming a bump", async () => {
    const { runner: fake } = runner({ diff: { exitCode: 128 }, tree: { stdout: "pom.xml\0" } });

    expect((await judgeBumps(fake, request, ["pom.xml"])).get("pom.xml")).toEqual({
      ok: false,
      reason: "the change could not be read",
    });
  });

  it("treats an unreadable tree as possibly holding other poms, which refuses a property bump", async () => {
    const { runner: fake } = runner({
      diff: { stdout: bumpDiff("3.181", "3.203") },
      tree: { exitCode: 128 },
    });

    expect((await judgeBumps(fake, request, ["pom.xml"])).get("pom.xml")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("another pom.xml"),
    });
  });

  it("sees a second pom.xml in the tree", async () => {
    const { runner: fake } = runner({
      diff: { stdout: bumpDiff("3.181", "3.203") },
      tree: { stdout: "pom.xml\0module/pom.xml\0" },
    });

    expect((await judgeBumps(fake, request, ["pom.xml"])).get("pom.xml")?.ok).toBe(false);
  });
});
