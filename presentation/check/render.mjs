import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DECKS = ["full.en", "full.no", "simple.en"];
const USAGE = `usage: pnpm --dir presentation check <${DECKS.join("|")}> [slide ...]   (macOS, with PowerPoint installed)\n`;

const here = import.meta.dirname;
const root = join(here, "..");
const [deck, ...asked] = process.argv.slice(2);
if (!DECKS.includes(deck) || asked.some((n) => !/^\d+$/.test(n))) {
  process.stderr.write(USAGE);
  process.exit(2);
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

let slides = asked.map(Number);
if (slides.length === 0) {
  const total = Number(/\((\d+) slides\)/.exec(build())?.[1] ?? 0);
  slides = [...Array(total).keys()].map((i) => i + 1);
}

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
if (!existsSync(snap)) {
  execFileSync("swiftc", ["-O", join(here, "snap.swift"), "-o", snap], { stdio: "inherit" });
}
execFileSync(snap, [png, "/", ...previews], { stdio: "inherit" });
process.stdout.write(`${slides.length} slide(s) → ${png}\n`);
