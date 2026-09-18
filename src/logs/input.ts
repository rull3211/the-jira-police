/**
 * Terminal bytes to key names.
 *
 * Kept apart from the tty shell because this is the half that can be tested: a chunk off a terminal
 * in raw mode can hold several keystrokes, and an arrow key is three bytes that must not be read as
 * the three characters `ESC`, `[` and `A` — which would toggle whatever source owns `A`.
 */

const ESC = "\u001B";

/** CSI sequences the viewer acts on. Anything else beginning `ESC [` is consumed and ignored. */
const CSI: Readonly<Record<string, string>> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
};

/** `ESC [ n ~` forms, which is where the paging keys live. */
const TILDE: Readonly<Record<string, string>> = {
  "5": "pageup",
  "6": "pagedown",
};

/** Where a CSI sequence ends: the first byte in the final range, `@` through `~`. */
function endOfCsi(chunk: string, start: number): number {
  for (let i = start; i < chunk.length; i++) {
    const code = chunk.charCodeAt(i);
    if (code >= 0x40 && code <= 0x7e) {
      return i;
    }
  }
  return -1;
}

/**
 * Every key in one chunk, in order.
 *
 * A lone `ESC` at the end of a chunk is reported as `escape`. That is the standard ambiguity — the
 * rest of a sequence may simply not have arrived — and it is resolved in favour of the key that
 * quits, because a viewer that will not close is worse than one that closes a keystroke early.
 */
export function decodeKeys(chunk: string): string[] {
  const keys: string[] = [];
  let i = 0;

  while (i < chunk.length) {
    const character = chunk[i] ?? "";

    if (character === "\u0003") {
      // Ctrl-C. Raw mode means no signal is raised, so the viewer has to honour it itself.
      keys.push("q");
      i += 1;
      continue;
    }

    if (character === ESC && chunk[i + 1] === "[") {
      const end = endOfCsi(chunk, i + 2);
      if (end === -1) {
        keys.push("escape");
        break;
      }
      const final = chunk[end] ?? "";
      const parameters = chunk.slice(i + 2, end);
      const named = final === "~" ? TILDE[parameters] : CSI[final];
      if (named !== undefined) {
        keys.push(named);
      }
      i = end + 1;
      continue;
    }

    if (character === ESC) {
      keys.push("escape");
      i += 1;
      continue;
    }

    if (character === "\r" || character === "\n") {
      keys.push("enter");
      i += 1;
      continue;
    }

    // Anything else is passed through as itself, which is what makes the filter keys work.
    const point = chunk.codePointAt(i);
    const whole = point === undefined ? character : String.fromCodePoint(point);
    keys.push(whole);
    i += whole.length;
  }

  return keys;
}
