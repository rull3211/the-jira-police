/**
 * Whether a change to a `pom.xml` is nothing but dependency version bumps and edits to the text of
 * its comments — the one change to a file that defines what passing means which a run may make.
 * See architecture/solve.md §15.
 *
 * The diff gate and `verify`'s refusal to grade a changed build file both ask this module, so they
 * cannot disagree about which change is allowed; the plan check leaves `pom.xml` to them.
 *
 * Text, not an XML library: this project has no parser dependency. Where Maven would read the file
 * differently than this text does — an internal DTD subset, a character reference, an unbalanced
 * tag — the change is refused rather than guessed at. Comments are found by the same scan that reads
 * the elements, so the two cannot disagree about where one ends.
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
  /** Offset of the start tag's `<`. */
  readonly start: number;
  readonly contentStart: number;
  contentEnd: number;
}

/** `[start, end)` of one comment, its `<!--` and `-->` included. */
type Span = readonly [start: number, end: number];

interface PomScan {
  readonly elements: readonly ElementRecord[];
  /** In file order, so none overlaps the next. */
  readonly comments: readonly Span[];
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

function lineIndex(text: string): (offset: number) => number {
  const newlines: number[] = [];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    newlines.push(index);
  }
  return (offset) => {
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
}

/** Every element, where its content sits, and every comment, or `null` for anything this reader does not understand. */
function scanPom(text: string): PomScan | null {
  const lineOf = lineIndex(text);
  const after = (terminator: string, from: number): number => {
    const end = text.indexOf(terminator, from);
    return end === -1 ? -1 : end + terminator.length;
  };

  const records: ElementRecord[] = [];
  const comments: Span[] = [];
  const open: ElementRecord[] = [];
  let cursor = 0;
  for (;;) {
    const lt = text.indexOf("<", cursor);
    if (lt === -1) {
      break;
    }
    if (text.startsWith("<!--", lt)) {
      cursor = after("-->", lt + 4);
      if (cursor !== -1) {
        comments.push([lt, cursor]);
      }
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
          start: lt,
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
  return open.length === 0 ? { elements: records, comments } : null;
}

/** A file with its comments cut out: what Maven reads, since it joins the text either side of one. */
interface Bare {
  readonly text: string;
  /** Per line of `text`: the 0-based line of the original holding its first non-blank character. */
  readonly lines: readonly number[];
  /** The original's elements, in the same order, at their offsets and lines in `text`. */
  readonly elements: readonly ElementRecord[];
}

/**
 * Cuts each comment out whole and nothing around it, so no text outside a comment changes unseen.
 * Elements are translated, not rescanned: cutting a comment the scan found moves nothing else it read.
 */
function withoutComments(text: string, scan: PomScan): Bare {
  const pieces: string[] = [];
  const origins: number[] = [];
  let from = 0;
  for (const [start, end] of [...scan.comments, [text.length, text.length] as const]) {
    pieces.push(text.slice(from, start));
    for (let offset = from; offset < start; offset += 1) {
      origins.push(offset);
    }
    from = end;
  }
  const bare = pieces.join("");

  const lineOf = lineIndex(text);
  const lines: number[] = [];
  let lineStart = 0;
  for (const line of bare.split("\n")) {
    const lead = line.length - line.trimStart().length;
    const origin = origins[lineStart + (lead < line.length ? lead : 0)];
    lines.push(lineOf(origin ?? text.length));
    lineStart += line.length + 1;
  }

  // Never called on an offset inside a comment: every one it gets is a tag's edge.
  const shift = (offset: number): number =>
    scan.comments.reduce(
      (cut, [start, end]) => (end <= offset ? cut - (end - start) : cut),
      offset,
    );
  const bareLineOf = lineIndex(bare);
  const elements = scan.elements.map((element) => ({
    chain: element.chain,
    line: bareLineOf(shift(element.start)),
    start: shift(element.start),
    contentStart: shift(element.contentStart),
    contentEnd: shift(element.contentEnd),
  }));
  return { text: bare, lines, elements };
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

/** A text and the elements scanned from it, at offsets into that text. */
interface View {
  readonly text: string;
  readonly elements: readonly ElementRecord[];
}

/** Where `name` is used other than as the whole of a dependency's `<version>`, or `null` when it is not. */
function strayUse(view: View, name: string): string | null {
  for (const offset of referencesTo(view.text, name)) {
    const user = enclosing(view.elements, offset);
    const used = user === undefined ? "" : user.chain.join(">");
    const whole =
      user !== undefined &&
      view.text.slice(user.contentStart, user.contentEnd).trim() === `\${${name}}`;
    if (user === undefined || !DEPENDENCY_VERSION_CHAINS.has(used) || !whole) {
      return used === "" ? "outside any element" : `in ${used}`;
    }
  }
  return null;
}

/**
 * The judgement itself, pure. `otherPoms` refuses a property bump when another `pom.xml` in the
 * repository could use the same property, since only this file is read.
 */
export function judgePomChange(path: string, texts: PomTexts, otherPoms: boolean): BumpVerdict {
  const baseScan = scanPom(texts.base);
  if (baseScan === null) {
    return refuse("the base file could not be read as XML");
  }
  const currentScan = scanPom(texts.current);
  if (currentScan === null) {
    return refuse("the changed file could not be read as XML");
  }
  // Under git's `ident` attribute, text inside `$Id: … $` never reaches the diff this judgement is made from — and a comment edit can add one.
  if (texts.base.includes("$Id") || texts.current.includes("$Id")) {
    return refuse("the file holds a $Id keyword, and git can hide text from the diff inside one");
  }
  if (texts.base === texts.current) {
    return refuse("nothing in the file changed, so there is no change to allow");
  }

  // Comments are judged by leaving them out: a change inside one never reaches the loop below.
  const base = withoutComments(texts.base, baseScan);
  const current = withoutComments(texts.current, currentScan);
  const baseLines = base.text.split("\n");
  const currentLines = current.text.split("\n");
  if (baseLines.length !== currentLines.length) {
    return refuse(
      "lines outside comments were added or removed, and outside a comment only a version value may change",
    );
  }

  const bumps: DependencyBump[] = [];
  for (const [index, before] of baseLines.entries()) {
    const after = currentLines[index] ?? "";
    if (before === after) {
      continue;
    }
    const line = (base.lines[index] ?? index) + 1;
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

    const element = base.elements.find(
      (record) => record.line === index && record.chain.at(-1) === name,
    );
    if (element === undefined) {
      return refuse(`line ${String(line)} could not be placed in the file's structure`);
    }
    const chain = element.chain.join(">");

    if (DEPENDENCY_VERSION_CHAINS.has(chain)) {
      bumps.push({
        path,
        line,
        property: null,
        dependencies: [coordinatesOf(base.elements, element, base.text)],
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
    const outside = base.elements.find((record) =>
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
    if (referencesTo(texts.base, name).length === 0) {
      // Nothing in the file names it, which is exactly how a property only a plugin reads looks.
      return refuse(`line ${String(line)} changes the property ${name}, which nothing here uses`);
    }
    // The original still refuses a use inside a comment; the bare text catches `$<!-- -->{name}`, which Maven joins and interpolates.
    for (const view of [{ text: texts.base, elements: baseScan.elements }, base]) {
      const stray = strayUse(view, name);
      if (stray !== null) {
        return refuse(
          `line ${String(line)} changes the property ${name}, which is also used ${stray}, not only as a dependency version`,
        );
      }
    }
    const dependencies = referencesTo(base.text, name).flatMap((offset) => {
      const user = enclosing(base.elements, offset);
      return user === undefined ? [] : [coordinatesOf(base.elements, user, base.text)];
    });
    bumps.push({ path, line, property: name, dependencies, from, to });
  }
  return { ok: true, bumps };
}

export interface BumpRequest {
  readonly worktreePath: string;
  readonly baseRef: string;
  readonly timeoutMs: number;
}

/**
 * Judges every changed path that only a dependency bump or a comment edit could excuse; every other
 * path is absent from the answer. Anything that cannot be read is refused, never assumed allowed.
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
