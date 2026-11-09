import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DECKS } from "../decks.mjs";

const USAGE = `usage: pnpm --dir presentation check <${DECKS.join("|")}> [slide ...]   (macOS, with PowerPoint installed)\n`;

function fail(message, code) {
  process.stderr.write(message);
  process.exit(code);
}

const here = import.meta.dirname;
const root = join(here, "..");
const [deck, ...asked] = process.argv.slice(2);
if (!DECKS.includes(deck) || asked.some((n) => !/^\d+$/.test(n))) {
  fail(USAGE, 2);
}

// Quick Look's HTML names Calibri and Consolas, which WebKit cannot see; without these it falls back to Times and every width is wrong.
const DFONTS = "file:///Applications/Microsoft%20PowerPoint.app/Contents/Resources/DFonts/";
const face = (family, file, weight, style) =>
  `@font-face{font-family:"${family}";src:url("${DFONTS}${file}");font-weight:${weight};font-style:${style};}`;
const FONT_CSS = `<style>${[
  face("Calibri", "Calibri.ttf", "normal", "normal"),
  face("Calibri", "Calibrib.ttf", "bold", "normal"),
  face("Calibri", "Calibrii.ttf", "normal", "italic"),
  face("Calibri", "Calibriz.ttf", "bold", "italic"),
  face("Consolas", "Consola.ttf", "normal", "normal"),
  face("Consolas", "Consolab.ttf", "bold", "normal"),
].join("")}</style>`;

const base = join(root, "out", "check", deck);
const ql = join(base, "ql");
const png = join(base, "png");
const pad = (n) => String(n).padStart(2, "0");

function build(only) {
  const env = { ...process.env };
  delete env.ONLY;
  if (only !== undefined) {
    env.ONLY = String(only);
  }
  return execFileSync(process.execPath, [join(root, `${deck}.mjs`)], { env, encoding: "utf8" });
}

const counted = /\((\d+) slides\)/.exec(build());
if (counted === null) {
  fail(`could not read the slide count from ${deck}.mjs's output\n`, 1);
}
const total = Number(counted[1]);
const outOfRange = asked.map(Number).filter((n) => n < 1 || n > total);
if (outOfRange.length > 0) {
  fail(`${deck} has slides 1–${total}; no slide ${outOfRange.join(", ")}\n`, 2);
}
const slides = asked.length > 0 ? asked.map(Number) : [...Array(total).keys()].map((i) => i + 1);

// qlmanage opens an interactive preview instead of writing files when the output directory is missing.
mkdirSync(ql, { recursive: true });
mkdirSync(png, { recursive: true });

const previews = [];
for (const n of slides) {
  build(n);
  execFileSync("qlmanage", ["-p", "-o", ql, join(base, "single", `slide-${pad(n)}.pptx`)], {
    stdio: "ignore",
  });
  const html = join(ql, `slide-${pad(n)}.pptx.qlpreview`, "Preview.html");
  const text = readFileSync(html, "utf8");
  if (!text.includes("@font-face")) {
    writeFileSync(html, text.replace("<head>", `<head>${FONT_CSS}`));
  }
  previews.push(html);
}

const snap = join(root, "out", "check", "snap");
const snapSource = join(here, "snap.swift");
if (!existsSync(snap) || statSync(snapSource).mtimeMs > statSync(snap).mtimeMs) {
  execFileSync("swiftc", ["-O", snapSource, "-o", snap], { stdio: "inherit" });
}
// snap exits non-zero on any slide it could not render, which execFileSync turns into a throw.
execFileSync(snap, [png, "/", ...previews], { stdio: "inherit" });
process.stdout.write(`${slides.length} slide(s) → ${png}\n`);
