import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import pptxgen from "pptxgenjs";

export const FONT = "Calibri";
export const MONO = "Consolas";
// pptxgenjs orders an array margin [left, right, bottom, top], in points.
export const PAD = [10, 10, 3, 3];

export const C = {
  navy: "0B1F3A",
  ink: "1E2A38",
  muted: "5B6B7F",
  rule: "D5DCE5",
  soft: "F4F6F9",
  white: "FFFFFF",
  siren: "E0433A",
  sky: "7FBBFF",
  harness: "2E6DB4",
  harnessDark: "1D4F8C",
  harnessFill: "E3EDF9",
  agent: "7B4FC9",
  agentDark: "5A34A8",
  agentFill: "EEE7FB",
  human: "B7791F",
  humanDark: "8A5A0F",
  humanFill: "FFF3CD",
  ok: "2E7D4F",
  okFill: "DDF1E4",
  bad: "B03A3A",
  badFill: "F9E0E0",
  neutral: "7A8899",
  neutralFill: "F1F3F6",
};

export const KIND = {
  harness: { fill: C.harnessFill, line: C.harness, title: C.harnessDark },
  agent: { fill: C.agentFill, line: C.agent, title: C.agentDark },
  human: { fill: C.humanFill, line: C.human, title: C.humanDark },
  ok: { fill: C.okFill, line: C.ok, title: C.ok },
  bad: { fill: C.badFill, line: C.bad, title: C.bad },
  neutral: { fill: C.neutralFill, line: C.neutral, title: C.ink },
  navy: { fill: C.navy, line: C.navy, title: C.white, sub: "C9D6EA" },
};

function defineMasters(pptx, footer) {
  pptx.defineSlideMaster({
    title: "CONTENT",
    background: { color: C.white },
    objects: [
      { rect: { x: 0, y: 0, w: 13.333, h: 0.08, fill: { color: C.navy } } },
      { rect: { x: 0, y: 0.08, w: 1.2, h: 0.04, fill: { color: C.siren } } },
      {
        text: {
          text: footer,
          options: { x: 0.5, y: 7.08, w: 6, h: 0.3, fontFace: FONT, fontSize: 9, color: "8C99A8" },
        },
      },
    ],
    slideNumber: {
      x: 12.3,
      y: 7.08,
      w: 0.6,
      h: 0.3,
      fontFace: FONT,
      fontSize: 9,
      color: "8C99A8",
      align: "right",
    },
  });
  pptx.defineSlideMaster({
    title: "DARK",
    background: { color: C.navy },
    objects: [{ rect: { x: 0, y: 7.3, w: 13.333, h: 0.2, fill: { color: C.siren } } }],
  });
}

function makeDeck(title, footer) {
  const d = new pptxgen();
  d.layout = "LAYOUT_WIDE"; // 13.333 x 7.5 in
  d.author = "Bence Daniel Szøke";
  d.title = title;
  defineMasters(d, footer);
  return d;
}

// `ONLY=n` writes slide n alone to `out/check/<id>/single/`: Quick Look caches shapes across the
// slides of one file, so it renders a later slide with an earlier one's shapes.
export function createDeck({ id, title, footer, legendItems, partLabel }) {
  const only = process.env.ONLY ? Number(process.env.ONLY) : null;
  const pptx = makeDeck(title, footer);
  const scrap = makeDeck(title, footer);
  let slideNo = 0;
  const keep = pptx.addSlide.bind(pptx);
  const discard = scrap.addSlide.bind(scrap);
  pptx.addSlide = (opts) => {
    slideNo += 1;
    return only === null || slideNo === only ? keep(opts) : discard(opts);
  };

  function content(kicker, heading, notes) {
    const s = pptx.addSlide({ masterName: "CONTENT" });
    s.addText(kicker.toUpperCase(), {
      x: 0.5,
      y: 0.22,
      w: 12.3,
      h: 0.3,
      fontFace: FONT,
      fontSize: 11,
      bold: true,
      color: C.siren,
      charSpacing: 2,
      margin: 0,
    });
    s.addText(heading, {
      x: 0.5,
      y: 0.48,
      w: 12.3,
      h: 0.7,
      fontFace: FONT,
      fontSize: 28,
      bold: true,
      color: C.navy,
      margin: 0,
      valign: "middle",
    });
    s.addNotes(notes);
    return s;
  }

  function node(s, x, y, w, h, heading, sub, kind = "neutral", o = {}) {
    const k = KIND[kind];
    const runs = [
      {
        text: heading,
        options: {
          bold: true,
          fontSize: o.titleSize ?? 13,
          color: k.title,
          breakLine: Boolean(sub),
        },
      },
    ];
    if (sub) {
      runs.push({ text: sub, options: { fontSize: o.subSize ?? 10.5, color: k.sub ?? C.ink } });
    }
    s.addText(runs, {
      shape: pptx.ShapeType.roundRect,
      rectRadius: 0.08,
      x,
      y,
      w,
      h,
      fill: { color: k.fill },
      line: { color: k.line, width: 1.25, dashType: o.dash },
      fontFace: FONT,
      align: o.align ?? "center",
      valign: "middle",
      margin: o.margin ?? 4,
    });
  }

  function arrow(s, x1, y1, x2, y2, o = {}) {
    s.addShape(pptx.ShapeType.line, {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      w: Math.abs(x2 - x1),
      h: Math.abs(y2 - y1),
      flipH: x2 < x1,
      flipV: y2 < y1,
      line: {
        color: o.color ?? C.neutral,
        width: o.width ?? 1.5,
        endArrowType: o.noHead ? undefined : "triangle",
      },
    });
  }

  function path(s, pts, o = {}) {
    for (let i = 0; i < pts.length - 1; i++) {
      arrow(s, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], {
        ...o,
        noHead: i !== pts.length - 2,
      });
    }
  }

  function label(s, x, y, w, h, text, o = {}) {
    s.addText(text, {
      x,
      y,
      w,
      h,
      fontFace: FONT,
      fontSize: o.size ?? 10,
      color: o.color ?? C.muted,
      italic: o.italic ?? false,
      bold: o.bold ?? false,
      align: o.align ?? "center",
      valign: o.valign ?? "middle",
      margin: 0,
    });
  }

  function legend(s, y) {
    let cx = 0.5;
    for (const [kind, text] of legendItems) {
      s.addShape(pptx.ShapeType.roundRect, {
        x: cx,
        y: y + 0.07,
        w: 0.26,
        h: 0.2,
        rectRadius: 0.04,
        fill: { color: KIND[kind].fill },
        line: { color: KIND[kind].line, width: 1.25 },
      });
      s.addText(text, {
        x: cx + 0.33,
        y,
        w: 3.2,
        h: 0.34,
        fontFace: FONT,
        fontSize: 11,
        color: C.ink,
        margin: 0,
        valign: "middle",
      });
      cx += text.length * 0.075 + 0.95;
    }
  }

  function bullets(items, o = {}) {
    return items.flatMap((item, i) => {
      const runs = Array.isArray(item) ? item : [{ text: item }];
      return runs.map((r, j) => ({
        text: r.text,
        options: {
          ...(j === 0
            ? { bullet: { indent: 14 }, paraSpaceBefore: i === 0 ? 0 : (o.gap ?? 5) }
            : {}),
          bold: r.bold,
          color: r.color,
          fontFace: r.mono ? MONO : undefined,
          breakLine: j === runs.length - 1 && i < items.length - 1,
        },
      }));
    });
  }

  function card(s, x, y, w, h, o = {}) {
    s.addShape(pptx.ShapeType.roundRect, {
      x,
      y,
      w,
      h,
      rectRadius: o.radius ?? 0.06,
      fill: { color: o.fill ?? C.soft },
      line: { color: o.line ?? C.rule, width: 1 },
    });
  }

  function callout(s, x, y, w, h, runs, o = {}) {
    s.addText(runs, {
      shape: pptx.ShapeType.rect,
      x,
      y,
      w,
      h,
      fill: { color: o.fill ?? C.navy },
      line: { color: o.fill ?? C.navy, width: 0 },
      fontFace: FONT,
      fontSize: o.size ?? 14,
      color: o.color ?? C.white,
      margin: PAD,
      valign: "middle",
      align: "left",
    });
  }

  function section(num, heading, sub, items, notes) {
    const s = pptx.addSlide({ masterName: "DARK" });
    s.addText(`${partLabel} ${num}`, {
      x: 0.8,
      y: 1.3,
      w: 6,
      h: 0.5,
      fontFace: FONT,
      fontSize: 16,
      bold: true,
      color: C.siren,
      charSpacing: 4,
      margin: 0,
    });
    s.addText(heading, {
      x: 0.8,
      y: 1.8,
      w: 11.5,
      h: 1.2,
      fontFace: FONT,
      fontSize: 44,
      bold: true,
      color: C.white,
      margin: 0,
    });
    s.addText(sub, {
      x: 0.8,
      y: 3.0,
      w: 11.5,
      h: 0.6,
      fontFace: FONT,
      fontSize: 18,
      color: "A9BCD6",
      margin: 0,
    });
    s.addText(
      items.flatMap((t, i) => [
        { text: "▸   ", options: { color: C.siren, bold: true, paraSpaceBefore: i === 0 ? 0 : 8 } },
        { text: t, options: { breakLine: i < items.length - 1 } },
      ]),
      {
        x: 0.8,
        y: 3.95,
        w: 11.5,
        h: 2.6,
        fontFace: FONT,
        fontSize: 17,
        color: "DCE6F2",
        valign: "top",
        margin: 0,
      },
    );
    s.addNotes(notes);
  }

  async function write(fileName) {
    const here = import.meta.dirname;
    const out =
      only === null
        ? join(here, "out", fileName)
        : join(here, "out", "check", id, "single", `slide-${String(only).padStart(2, "0")}.pptx`);
    mkdirSync(dirname(out), { recursive: true });
    await pptx.writeFile({ fileName: out });
    process.stdout.write(`${out} (${slideNo} slides)\n`);
  }

  return {
    pptx,
    content,
    node,
    arrow,
    path,
    label,
    legend,
    bullets,
    card,
    callout,
    section,
    write,
  };
}
