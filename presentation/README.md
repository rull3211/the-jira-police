# Demo decks

The slide decks written for the demo on 2026-09-29, generated from code with
[pptxgenjs](https://gitbrent.github.io/PptxGenJS/). Speaker notes are on every slide.

| Deck            | Writes                                 | What it covers                                                                  |
| --------------- | -------------------------------------- | ------------------------------------------------------------------------------- |
| `full.en.mjs`   | `out/the-jira-police-demo.pptx`        | What the bot does, then how its development is instructed: phases and incidents |
| `full.no.mjs`   | `out/the-jira-police-demo.no.pptx`     | The same deck in Norwegian (bokmål)                                             |
| `simple.en.mjs` | `out/the-jira-police-demo.simple.pptx` | The capabilities only, without the internals                                    |

**These are a snapshot, not documentation.** Each deck describes the repository as it stood on
2026-09-29 — counts, pull request numbers, which features were still on a branch — and nothing keeps
them current. For how things are now, read [`README.md`](../README.md),
[`ARCHITECTURE.md`](../ARCHITECTURE.md) and [`PLAN.md`](../PLAN.md).

## Build

```sh
pnpm presentation                    # from the repository root: install, then build all three
open presentation/out/the-jira-police-demo.pptx
```

From this folder, `pnpm install` once, then `pnpm build` for all three or `pnpm build simple.en` for
one. `out/` is gitignored. `pptxgenjs` is this folder's own dependency, not the root's, so the
daemon's install is unchanged.

## Editing

- `deck.mjs` holds the masters, the colours and the drawing helpers. Each deck file is its slides,
  top to bottom; `content()`'s third argument is the speaker notes.
- The colour code carries meaning and the slides explain it: blue is the harness, purple a model
  session, yellow a person.
- `full.no.mjs` mirrors `full.en.mjs` slide for slide, so a change to one is owed to the other.
  Commands, labels, file names and the Slack mock stay in English, because the bot posts in English.

## Checking the layout without PowerPoint

```sh
pnpm --dir presentation check full.en        # every slide
pnpm --dir presentation check full.en 4 11   # just these
```

It writes one PNG per slide to `out/check/<deck>/png/`. macOS only: it renders through Quick Look
and WebKit, reads the fonts out of an installed Microsoft PowerPoint, and compiles
`check/snap.swift` with `swiftc` on first use. Each slide is built as a one-slide file first,
because Quick Look reuses the shapes of earlier slides in the same file.

**What it does not show.** Quick Look ignores a text box's right inset, so a line that fits here
can wrap in PowerPoint; and it collapses table rows that PowerPoint draws at their full height.
Page through the real deck before presenting it.
