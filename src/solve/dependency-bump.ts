/**
 * Whether a change to a `pom.xml` is nothing but a dependency version bump — the one change to a
 * file that defines what passing means which a run may make. See architecture/solve.md §15.
 *
 * The diff gate and `verify`'s refusal to grade a changed build file both ask this module, so they
 * cannot disagree about which change is allowed; the plan check leaves `pom.xml` to them.
 *
 * Text, not an XML library: this project has no parser dependency. Where Maven would read the file
 * differently than this text does — an internal DTD subset, a character reference, an unbalanced
 * tag — the change is refused rather than guessed at.
 */

import { isDependencyBumpPath } from "./diff-gate.ts";
import type { CommandRunner } from "./worktree.ts";

/** One version that moved, named in the pull request by the harness. */
export interface DependencyBump {
  readonly path: string;
  /** 1-based, in the base file. */
  readonly line: number;
  /** The property whose value changed; `null` for a literal `<version>`. */
  readonly property: string | null;
  /** `groupId:artifactId` of every dependency the change reaches. */
  readonly dependencies: readonly string[];
  readonly from: string;
  readonly to: string;
}

export type BumpVerdict =
  | { readonly ok: true; readonly bumps: readonly DependencyBump[] }
  | { readonly ok: false; readonly reason: string };

/** Both sides of the change, whole. */
export interface PomTexts {
  readonly base: string;
  readonly current: string;
}

/**
 * Starts with a digit, so a boolean or a property reference can never pass for a version: a
 * property a plugin reads, such as `maven.test.skip`, would otherwise flip on this path.
 */
const VERSION = /^[0-9][0-9A-Za-z._-]*$/u;

/** A version that can change after review is not a version a reviewer approved. */
const MUTABLE = /snapshot/iu;

/** Plugin, parent, profile and extension versions are absent on purpose: each changes the build. */
const DEPENDENCY_VERSION_CHAINS: ReadonlySet<string> = new Set([
  "project>dependencies>dependency>version",
  "project>dependencyManagement>dependencies>dependency>version",
]);

/** The whole of one element on one line, and nothing else on it. */
const ONE_ELEMENT_LINE = /^(\s*)<([A-Za-z_][\w.-]*)>([^<>&]*)<\/([A-Za-z_][\w.-]*)>(\s*)$/u;

/** Larger than any `pom.xml`, so the diff is one hunk holding the whole file. */
const FULL_CONTEXT = 1_000_000;

function refuse(reason: string): BumpVerdict {
  return { ok: false, reason };
}

interface ElementRecord {
  readonly chain: readonly string[];
  /** 0-based line of the start tag. */
  readonly line: number;
  readonly contentStart: number;
  contentEnd: number;
}

/** Index of the `>` closing the tag that opens at `lt`, skipping any inside a quoted attribute. */
function tagEnd(text: string, lt: number): number {
  let quote: string | null = null;
  for (let index = lt + 1; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index;
    }
  }
  return -1;
}

/** Every element and where its content sits, or `null` for anything this reader does not understand. */
function scanElements(text: string): readonly ElementRecord[] | null {
  const newlines: number[] = [];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    newlines.push(index);
  }
  const lineOf = (offset: number): number => {
    let low = 0;
    let high = newlines.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((newlines[middle] ?? Infinity) < offset) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  };
  const after = (terminator: string, from: number): number => {
    const end = text.indexOf(terminator, from);
    return end === -1 ? -1 : end + terminator.length;
  };

  const records: ElementRecord[] = [];
  const open: ElementRecord[] = [];
  let cursor = 0;
  for (;;) {
    const lt = text.indexOf("<", cursor);
    if (lt === -1) {
      break;
    }
    if (text.startsWith("<!--", lt)) {
      cursor = after("-->", lt + 4);
    } else if (text.startsWith("<![CDATA[", lt)) {
      cursor = after("]]>", lt);
    } else if (text.startsWith("<?", lt)) {
      cursor = after("?>", lt);
    } else if (text.startsWith("<!", lt)) {
      const end = text.indexOf(">", lt);
      // An internal DTD subset can declare entities that rewrite element text.
      cursor = end === -1 || text.slice(lt, end).includes("[") ? -1 : end + 1;
    } else {
      const gt = tagEnd(text, lt);
      if (gt === -1) {
        return null;
      }
      const tag = text.slice(lt + 1, gt);
      if (tag.startsWith("/")) {
        const top = open.pop();
        if (top === undefined || top.chain.at(-1) !== tag.slice(1).trim()) {
          return null;
        }
        top.contentEnd = lt;
      } else {
        const name = /^[^\s/>]+/u.exec(tag)?.[0];
        if (name === undefined) {
          return null;
        }
        const record: ElementRecord = {
          chain: [...(open.at(-1)?.chain ?? []), name],
          line: lineOf(lt),
          contentStart: gt + 1,
          contentEnd: gt + 1,
        };
        records.push(record);
        if (!tag.endsWith("/")) {
          open.push(record);
        }
      }
      cursor = gt + 1;
    }
    if (cursor === -1) {
      return null;
    }
  }
  return open.length === 0 ? records : null;
}

/** The deepest element whose content holds `offset`. */
function enclosing(records: readonly ElementRecord[], offset: number): ElementRecord | undefined {
  let best: ElementRecord | undefined;
  for (const record of records) {
    const holds = record.contentStart <= offset && offset < record.contentEnd;
    if (holds && (best === undefined || record.chain.length > best.chain.length)) {
      best = record;
    }
  }
  return best;
}

/** `groupId:artifactId` of the dependency holding a `<version>` element, for the notice only. */
function coordinatesOf(
  records: readonly ElementRecord[],
  version: ElementRecord,
  text: string,
): string {
  const dependency = enclosing(records, version.contentStart - 1);
  const child = (name: string): string => {
    const found = records.find(
      (record) =>
        dependency !== undefined &&
        record.chain.length === dependency.chain.length + 1 &&
        record.chain.at(-1) === name &&
        record.contentStart > dependency.contentStart &&
        record.contentEnd <= dependency.contentEnd,
    );
    return found === undefined ? "?" : text.slice(found.contentStart, found.contentEnd).trim();
  };
  return `${child("groupId")}:${child("artifactId")}`;
}

/** Offsets of every `${name}`, and surefire's late-bound `@{name}`, in the text, comments included. */
function referencesTo(text: string, name: string): readonly number[] {
  const found: number[] = [];
  for (const needle of [`\${${name}}`, `@{${name}}`]) {
    for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + 1)) {
      found.push(index);
    }
  }
  return found.toSorted((left, right) => left - right);
}

/**
 * Reads the output of a `git diff` with enough context to hold the whole file back into both
 * sides, or says why it cannot. Anything but one ordinary modification is refused: a new or
 * deleted file, a mode change, a binary diff.
 */
export function textsFromFullDiff(diff: string): PomTexts | string {
  const lines = diff.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const hunks = lines.flatMap((line, index) => (line.startsWith("@@") ? [index] : []));
  const first = hunks[0];
  if (first === undefined) {
    return "git reported no readable change to it";
  }
  if (hunks.length > 1) {
    return "the diff did not hold the whole file in one piece";
  }
  const header = lines.slice(0, first);
  if (
    !header.every(
      (line) =>
        line.startsWith("diff --git ") ||
        line.startsWith("index ") ||
        line.startsWith("--- a/") ||
        line.startsWith("+++ b/"),
    )
  ) {
    return "it is not an ordinary modification of a file that exists on both sides";
  }
  const counts = /^@@ -1(?:,(\d+))? \+1(?:,(\d+))? @@/u.exec(lines[first] ?? "");
  if (counts === null) {
    return "the diff did not start at the file's first line";
  }

  const base: string[] = [];
  const current: string[] = [];
  let baseEnds = true;
  let currentEnds = true;
  let last = "";
  for (const line of lines.slice(first + 1)) {
    const kind = line.slice(0, 1);
    const content = line.slice(1);
    if (kind === " ") {
      base.push(content);
      current.push(content);
    } else if (kind === "-") {
      base.push(content);
    } else if (kind === "+") {
      current.push(content);
    } else if (kind === "\\") {
      // "\ No newline at end of file", about the line before it.
      baseEnds = baseEnds && last === "+";
      currentEnds = currentEnds && last === "-";
      continue;
    } else {
      return "the diff held a line this reader does not understand";
    }
    last = kind;
  }
  const baseCount = Number(counts[1] ?? "1");
  const currentCount = Number(counts[2] ?? "1");
  if (base.length !== baseCount || current.length !== currentCount || baseCount >= FULL_CONTEXT) {
    return "the diff did not hold the whole file";
  }
  return {
    base: `${base.join("\n")}${baseEnds ? "\n" : ""}`,
    current: `${current.join("\n")}${currentEnds ? "\n" : ""}`,
  };
}

/**
 * The judgement itself, pure. `otherPoms` refuses a property bump when another `pom.xml` in the
 * repository could use the same property, since only this file is read.
 */
export function judgePomChange(path: string, texts: PomTexts, otherPoms: boolean): BumpVerdict {
  const baseLines = texts.base.split("\n");
  const currentLines = texts.current.split("\n");
  if (baseLines.length !== currentLines.length) {
    return refuse("lines were added or removed, and only a version value may change");
  }
  const records = scanElements(texts.base);
  if (records === null) {
    return refuse("the base file could not be read as XML");
  }
  // Under git's `ident` attribute, text inside `$Id: … $` never reaches the diff this judgement is made from.
  if (texts.base.includes("$Id")) {
    return refuse("the file holds a $Id keyword, and git can hide text from the diff inside one");
  }

  const bumps: DependencyBump[] = [];
  for (const [index, before] of baseLines.entries()) {
    const after = currentLines[index] ?? "";
    if (before === after) {
      continue;
    }
    const line = index + 1;
    const was = ONE_ELEMENT_LINE.exec(before);
    const now = ONE_ELEMENT_LINE.exec(after);
    if (
      was === null ||
      now === null ||
      was[2] !== was[4] ||
      now[2] !== now[4] ||
      was[1] !== now[1] ||
      was[2] !== now[2] ||
      was[5] !== now[5]
    ) {
      return refuse(`line ${String(line)} changes more than the value of one element`);
    }
    const name = was[2] ?? "";
    const from = (was[3] ?? "").trim();
    const to = (now[3] ?? "").trim();
    if (!VERSION.test(from) || !VERSION.test(to)) {
      return refuse(`line ${String(line)} does not change one version number to another`);
    }
    if (MUTABLE.test(to)) {
      return refuse(`line ${String(line)} moves to ${to}, which can change after review`);
    }

    const element = records.find((record) => record.line === index && record.chain.at(-1) === name);
    if (element === undefined) {
      return refuse(`line ${String(line)} could not be placed in the file's structure`);
    }
    const chain = element.chain.join(">");

    if (DEPENDENCY_VERSION_CHAINS.has(chain)) {
      bumps.push({
        path,
        line,
        property: null,
        dependencies: [coordinatesOf(records, element, texts.base)],
        from,
        to,
      });
      continue;
    }

    if (chain !== `project>properties>${name}`) {
      return refuse(`line ${String(line)} is ${chain}, which is not a dependency version`);
    }
    if (otherPoms) {
      return refuse(
        `line ${String(line)} changes the property ${name}, and another pom.xml here could use it too`,
      );
    }
    // A parent reads the properties its children set, and a module's POM need not be named pom.xml; neither is in this file.
    const outside = records.find((record) =>
      ["project>parent", "project>modules"].includes(record.chain.join(">")),
    );
    if (outside !== undefined) {
      return refuse(
        `line ${String(line)} changes the property ${name}, and this pom's ${outside.chain.at(-1) ?? ""} could use it too`,
      );
    }
    // A character reference is decoded before Maven interpolates, so `&#36;{name}` is a use this text search cannot see.
    if (texts.base.includes("&#")) {
      return refuse(
        `line ${String(line)} changes the property ${name}, in a file with character references this reader does not decode`,
      );
    }
    const references = referencesTo(texts.base, name);
    if (references.length === 0) {
      // Nothing in the file names it, which is exactly how a property only a plugin reads looks.
      return refuse(`line ${String(line)} changes the property ${name}, which nothing here uses`);
    }
    const dependencies: string[] = [];
    for (const offset of references) {
      const user = enclosing(records, offset);
      const used = user === undefined ? "" : user.chain.join(">");
      const whole =
        user === undefined
          ? ""
          : texts.base.slice(user.contentStart, user.contentEnd).trim() === `\${${name}}`;
      if (user === undefined || !DEPENDENCY_VERSION_CHAINS.has(used) || !whole) {
        return refuse(
          `line ${String(line)} changes the property ${name}, which is also used ${used === "" ? "outside any element" : `in ${used}`}, not only as a dependency version`,
        );
      }
      dependencies.push(coordinatesOf(records, user, texts.base));
    }
    bumps.push({ path, line, property: name, dependencies, from, to });
  }

  if (bumps.length === 0) {
    return refuse("no version changed, so the change is something else");
  }
  return { ok: true, bumps };
}

export interface BumpRequest {
  readonly worktreePath: string;
  readonly baseRef: string;
  readonly timeoutMs: number;
}

/**
 * Judges every changed path that only a dependency bump could excuse; every other path is absent
 * from the answer. Anything that cannot be read is refused, never assumed to be a bump.
 */
export async function judgeBumps(
  runner: CommandRunner,
  request: BumpRequest,
  paths: readonly string[],
): Promise<ReadonlyMap<string, BumpVerdict>> {
  const verdicts = new Map<string, BumpVerdict>();
  const candidates = paths.filter((path) => isDependencyBumpPath(path));
  if (candidates.length === 0) {
    return verdicts;
  }
  const { worktreePath, baseRef, timeoutMs } = request;
  const git = async (args: readonly string[]) =>
    await runner.run(["git", "--literal-pathspecs", "-C", worktreePath, ...args], {
      cwd: worktreePath,
      timeoutMs,
    });

  const tree = await git(["ls-tree", "-r", "--name-only", "-z", baseRef]);
  const poms =
    tree.timedOut || tree.exitCode !== 0
      ? null
      : tree.stdout.split("\0").filter((path) => isDependencyBumpPath(path));

  for (const path of candidates) {
    const diffed = await git([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      `--unified=${String(FULL_CONTEXT)}`,
      baseRef,
      "--",
      path,
    ]);
    if (diffed.timedOut || diffed.exitCode !== 0) {
      verdicts.set(path, refuse("the change could not be read"));
      continue;
    }
    const texts = textsFromFullDiff(diffed.stdout);
    if (typeof texts === "string") {
      verdicts.set(path, refuse(texts));
      continue;
    }
    // Unreadable counts as "there may be others", which refuses a property bump rather than allowing it.
    const otherPoms = poms === null || poms.some((pom) => pom !== path);
    verdicts.set(path, judgePomChange(path, texts, otherPoms));
  }
  return verdicts;
}
