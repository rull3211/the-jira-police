/**
 * Does each log call's message agree with the `src` its logger was created with?
 *
 * The type checker forces a call site to name a source; it cannot tell whether the name is the
 * right one. A wrong `src` is worse than no `src`, because the viewer's source filter would then
 * hide a line the operator explicitly asked to see — a silent wrong answer rather than a visible
 * gap. So the agreement is checked by `logger-call-sites.test.ts` across the tree.
 *
 * Text, not a TypeScript parse: this project has no parser dependency and no build step. What that
 * cannot see is reported as `unchecked` rather than passed, and the test fails on a non-empty list.
 */

/** `message` belongs to `source` if it is the namespace itself or sits under it. */
export function agrees(source: string, message: string): boolean {
  return message === source || message.startsWith(`${source}.`);
}

export interface LogCall {
  readonly line: number;
  readonly binding: string;
  readonly source: string;
  readonly message: string;
}

/** A call the text scan could not decide, which is a hole in the guard rather than a pass. */
export interface UncheckedCall {
  readonly line: number;
  readonly reason: "unknown-binding" | "non-literal-message";
  readonly text: string;
}

export interface Scan {
  /** Local const name → the source it was created with. */
  readonly bindings: ReadonlyMap<string, string>;
  readonly calls: readonly LogCall[];
  readonly unchecked: readonly UncheckedCall[];
  readonly disagreements: readonly LogCall[];
}

/** Receivers that are a logger by convention here, so a call on one is in scope even unbound. */
const LOGGER_RECEIVERS = new Set(["log", "logger"]);

/**
 * Comments blanked, string literals kept, offsets and newlines preserved so line numbers survive.
 *
 * A regex literal containing `//` or `/*` would be masked wrongly. That direction loses call sites
 * rather than inventing them, so the tree-wide test cross-checks the count against an unmasked
 * scan and fails if masking dropped one.
 */
export function maskComments(source: string): string {
  const out = [...source];
  let mode: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  let i = 0;

  while (i < source.length) {
    const c = source[i] ?? "";
    const next = source[i + 1] ?? "";

    if (mode === "code") {
      if (c === "/" && next === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        mode = "line";
        i += 2;
      } else if (c === "/" && next === "*") {
        out[i] = " ";
        out[i + 1] = " ";
        mode = "block";
        i += 2;
      } else {
        if (c === '"') {
          mode = "double";
        } else if (c === "'") {
          mode = "single";
        } else if (c === "`") {
          mode = "template";
        }
        i += 1;
      }
      continue;
    }

    if (mode === "line") {
      if (c === "\n") {
        mode = "code";
      } else {
        out[i] = " ";
      }
      i += 1;
      continue;
    }

    if (mode === "block") {
      if (c === "*" && next === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        mode = "code";
        i += 2;
      } else {
        if (c !== "\n") {
          out[i] = " ";
        }
        i += 1;
      }
      continue;
    }

    // Inside a string literal: only the escape and the matching quote matter.
    if (c === "\\") {
      i += 2;
    } else {
      if (
        (mode === "double" && c === '"') ||
        (mode === "single" && c === "'") ||
        (mode === "template" && c === "`")
      ) {
        mode = "code";
      }
      i += 1;
    }
  }

  return out.join("");
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text[i] === "\n") {
      line += 1;
    }
  }
  return line;
}

const BINDING = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*createLogger\(\s*"([^"]+)"\s*\)/gu;
const CALL = /\b([A-Za-z_$][\w$]*)\.(?:debug|info|warn|error)\s*\(/gu;
const LITERAL_MESSAGE = /^\s*"([^"]*)"/u;

/**
 * `const record = x ? solveLog.warn : solveLog.info;` — a level picked at runtime, then called as a
 * bare function. `solve-run.ts` does this, and without the alias the call is invisible to `CALL`.
 */
const ALIAS = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;=][^;]*?);/gu;
const ALIAS_USES = /\b([A-Za-z_$][\w$]*)\.(?:debug|info|warn|error)\b/gu;

/**
 * The initialiser has to *be* a level, not merely mention one.
 *
 * Without this, `const stop = (reason) => { shutdownLog.warn(…) }` reads as an alias and every
 * `stop("SIGINT")` is reported as a log message in the wrong namespace — which is what the first
 * run of this guard did, four times in `index.ts` and twice in `orchestrator.ts`.
 */
function isLevelReference(initialiser: string): boolean {
  const text = initialiser.trim();
  return !text.includes("=>") && !text.includes("{") && /\.(?:debug|info|warn|error)$/u.test(text);
}

/** Every `createLogger` binding in one file's text, and every log call measured against it. */
export function scanLogCallSites(text: string): Scan {
  const masked = maskComments(text);

  const bindings = new Map<string, string>();
  for (const match of masked.matchAll(BINDING)) {
    const [, name, source] = match;
    if (name !== undefined && source !== undefined) {
      bindings.set(name, source);
    }
  }

  const calls: LogCall[] = [];
  const unchecked: UncheckedCall[] = [];
  const disagreements: LogCall[] = [];

  // An alias inherits its source from the binding whose method it holds. Two sources in one
  // initialiser cannot be resolved statically, so the alias is reported rather than guessed.
  const aliases = new Map<string, string>();
  for (const match of masked.matchAll(ALIAS)) {
    const name = match[1];
    const initialiser = match[2];
    if (name === undefined || initialiser === undefined || bindings.has(name)) {
      continue;
    }
    if (!isLevelReference(initialiser)) {
      continue;
    }

    const used = new Set(
      [...initialiser.matchAll(ALIAS_USES)]
        .map((use) => bindings.get(use[1] ?? ""))
        .filter((source): source is string => source !== undefined),
    );
    if (used.size === 1) {
      aliases.set(name, [...used][0] ?? "");
    } else if (used.size > 1) {
      unchecked.push({
        line: lineOf(masked, match.index ?? 0),
        reason: "unknown-binding",
        text: name,
      });
    }
  }

  for (const [name, source] of aliases) {
    const calledAsFunction = new RegExp(String.raw`\b${name}\s*\(`, "gu");
    for (const match of masked.matchAll(calledAsFunction)) {
      const at = match.index ?? 0;
      const line = lineOf(masked, at);
      const message = LITERAL_MESSAGE.exec(masked.slice(at + match[0].length))?.[1];
      if (message === undefined) {
        unchecked.push({ line, reason: "non-literal-message", text: name });
        continue;
      }
      const call: LogCall = { line, binding: name, source, message };
      calls.push(call);
      if (!agrees(source, message)) {
        disagreements.push(call);
      }
    }
  }

  for (const match of masked.matchAll(CALL)) {
    const receiver = match[1] ?? "";
    const source = bindings.get(receiver);
    const at = match.index ?? 0;
    const line = lineOf(masked, at);

    if (source === undefined) {
      // A logger reached some other way — injected, re-exported — is a call this cannot measure.
      if (LOGGER_RECEIVERS.has(receiver)) {
        unchecked.push({ line, reason: "unknown-binding", text: receiver });
      }
      continue;
    }

    const rest = masked.slice(at + match[0].length);
    const message = LITERAL_MESSAGE.exec(rest)?.[1];
    if (message === undefined) {
      unchecked.push({ line, reason: "non-literal-message", text: receiver });
      continue;
    }

    const call: LogCall = { line, binding: receiver, source, message };
    calls.push(call);
    if (!agrees(source, message)) {
      disagreements.push(call);
    }
  }

  return { bindings, calls, unchecked, disagreements };
}
