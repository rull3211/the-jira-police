import { C, FONT, KIND, MONO, PAD, createDeck } from "./deck.mjs";

const { pptx, content, node, arrow, path, label, legend, bullets, card, callout, section, write } =
  createDeck({
    id: "full.en",
    title: "the-jira-police — demo",
    footer: "the-jira-police  ·  demo 2026-09-29",
    legendItems: [
      ["harness", "Harness — deterministic Node code"],
      ["agent", "Agent — a model session"],
      ["human", "Human"],
    ],
    partLabel: "PART",
  });

// =====================================================================
// 1. Title
// =====================================================================
{
  const s = pptx.addSlide({ masterName: "DARK" });
  s.addText("DEMO  ·  29 SEPTEMBER 2026", {
    x: 0.8,
    y: 1.25,
    w: 8,
    h: 0.4,
    fontFace: FONT,
    fontSize: 14,
    bold: true,
    color: C.siren,
    charSpacing: 4,
    margin: 0,
  });
  s.addText("the-jira-police", {
    x: 0.8,
    y: 1.75,
    w: 11.5,
    h: 1.2,
    fontFace: FONT,
    fontSize: 60,
    bold: true,
    color: C.white,
    margin: 0,
  });
  s.addText("An agent that grooms every new Jira ticket — and fixes the ones it safely can", {
    x: 0.8,
    y: 2.95,
    w: 11,
    h: 0.9,
    fontFace: FONT,
    fontSize: 24,
    color: "C9D6EA",
    margin: 0,
  });
  s.addShape(pptx.ShapeType.rect, {
    x: 0.8,
    y: 4.15,
    w: 1.2,
    h: 0.05,
    fill: { color: C.siren },
    line: { color: C.siren, width: 0 },
  });
  s.addText(
    [
      { text: "Part 1   ", options: { bold: true, color: C.white } },
      {
        text: "What the bot does — watchers, solver, review rounds, scope guard, Slack audit",
        options: { color: "C9D6EA", breakLine: true },
      },
      { text: "Part 2   ", options: { bold: true, color: C.white, paraSpaceBefore: 6 } },
      {
        text: "How its development is instructed — phases, architecture, incidents",
        options: { color: "C9D6EA" },
      },
    ],
    { x: 0.8, y: 4.4, w: 11.5, h: 0.9, fontFace: FONT, fontSize: 16, margin: 0 },
  );
  s.addText("Bence Daniel Szøke", {
    x: 0.8,
    y: 6.3,
    w: 6,
    h: 0.4,
    fontFace: FONT,
    fontSize: 14,
    color: "A9BCD6",
    margin: 0,
  });
  s.addNotes(
    "Two halves. First what the bot actually does, end to end, and where the line runs between deterministic code and model sessions. " +
      "Second, how the agent that builds this bot is instructed: the phase files, the architecture docs, and the incident log that keeps amending the rules.",
  );
}

// =====================================================================
// 2. In one slide
// =====================================================================
{
  const s = content(
    "What it is",
    "One board, three loops — and a human always merges",
    "The elevator version. Grooming has been in production the longest; the solve loop is the newest and the most privileged. " +
      "SSX-3834 on 2026-09-06 was the first ticket to go the whole way: sent back, answered, re-triaged, claimed, fixed, reviewed by Copilot, undrafted. " +
      "A person typed two things on that ticket: one reply and one label. There is no merge call anywhere in the codebase — the one guarantee every change has left alone.",
  );
  const cards = [
    [
      "1",
      "Grooming",
      "Every new SSX ticket in scope runs through Storebrand's /intake-triage skill. The verdict is checked mechanically, then posted back as a comment and labels.",
    ],
    [
      "2",
      "Sendback watch",
      "Tickets sent back as nearly solvable are watched. When somebody else answers, the bot checks the answer is relevant, then re-triages.",
    ],
    [
      "3",
      "Solve & review",
      "Tickets marked agent:solvable are claimed, fixed in an isolated git worktree, verified by the harness, opened as a draft PR and worked through review.",
    ],
  ];
  cards.forEach(([n, t, d], i) => {
    const y = 1.45 + i * 1.5;
    card(s, 0.5, y, 7.7, 1.32);
    s.addText(n, {
      shape: pptx.ShapeType.ellipse,
      x: 0.72,
      y: y + 0.36,
      w: 0.6,
      h: 0.6,
      fill: { color: C.navy },
      line: { color: C.navy, width: 0 },
      fontFace: FONT,
      fontSize: 20,
      bold: true,
      color: C.white,
      align: "center",
      valign: "middle",
      margin: 0,
    });
    s.addText(
      [
        { text: t, options: { bold: true, fontSize: 17, color: C.navy, breakLine: true } },
        { text: d, options: { fontSize: 13, color: C.ink } },
      ],
      { x: 1.55, y: y + 0.08, w: 6.5, h: 1.16, fontFace: FONT, valign: "middle", margin: 0 },
    );
  });
  s.addText(
    [
      { text: "+ Slack  ", options: { bold: true, color: C.agentDark } },
      {
        text: "With SLACK_MODE on, every ticket gets one Slack thread the bot keeps editing as the work moves.",
        options: { color: C.ink },
      },
    ],
    { x: 0.5, y: 5.95, w: 7.7, h: 0.6, fontFace: FONT, fontSize: 13, margin: 0, valign: "middle" },
  );

  card(s, 8.6, 1.45, 4.23, 5.05, { fill: C.navy, line: C.navy });
  const stats = [
    ["5 min 36 s", "claim → draft PR on SSX-3834, the first ticket through the whole chain"],
    ["2", "places a person is required: the go-ahead label (manual mode) and the merge"],
    ["0", "merge calls anywhere in the codebase"],
  ];
  stats.forEach(([big, small], i) => {
    const y = 1.65 + i * 1.6;
    s.addText(big, {
      x: 8.85,
      y,
      w: 3.8,
      h: 0.7,
      fontFace: FONT,
      fontSize: 34,
      bold: true,
      color: C.white,
      margin: 0,
    });
    s.addText(small, {
      x: 8.85,
      y: y + 0.68,
      w: 3.8,
      h: 0.7,
      fontFace: FONT,
      fontSize: 12.5,
      color: "C9D6EA",
      margin: 0,
      valign: "top",
    });
  });
}

// =====================================================================
// 3. Section: Part 1
// =====================================================================
section(
  1,
  "What the bot does",
  "From a new ticket to a pull request a human merges",
  [
    "Three loops, and who does what: harness or agent",
    "The watcher — re-triage only when somebody answered",
    "The solver — six agent workflows, each its own session",
    "Verification and the scope guard — what a run may touch",
    "Review rounds, and the Slack audit thread with its state on the ticket",
  ],
  "Keep one question in mind through Part 1: for each step, is this a model making a judgement, or plain code checking something? The colour code on the diagrams answers it — blue is the harness, purple is a model session, yellow is a person.",
);

// =====================================================================
// 4. Three loops
// =====================================================================
{
  const s = content(
    "The runtime",
    "Three loops, each with its own clock and its own failure isolation",
    "The daemon awaits three runLoops in one Promise.all. They are separate loops rather than steps of one tick because a single triage may take up to twenty minutes; " +
      "sharing a tick would quietly turn a timeout into a review policy. Each loop has its own backoff, so a review sweep that throws every tick backs off the review side and nothing else. " +
      "The two-minute review cadence is measured, not taste: every Copilot review on #2658 landed two and a half to four minutes after the request. " +
      "The watch defaults to six hours; we run it at ten minutes (WATCH_POLL_MS in .env). A sweep costs one Jira read per watched ticket, and the paid relevance check only runs on new activity, so the shorter clock mostly buys a faster answer.",
  );
  const cols = [
    {
      h: "1  Grooming",
      rows: [
        ["Cadence", "every 5 min"],
        ["Switch", "always on"],
        ["Module", "poller.ts"],
        ["A tick can spend", "one analyst + one poster per new ticket (~$1.56)"],
        ["Why this clock", "new tickets are a window over time"],
      ],
    },
    {
      h: "2  Sendback watch",
      rows: [
        ["Cadence", "every 6 h (default) · ours: 10 min"],
        ["Switch", "WATCH_ENABLED"],
        ["Module", "watch-loop.ts"],
        ["A tick can spend", "one re-triage per ticket somebody else edited"],
        ["Why this clock", "a person reads, leaves, and comes back — days"],
      ],
    },
    {
      h: "3  Review, then claim",
      rows: [
        ["Cadence", "every 2 min"],
        ["Switch", "SOLVE_ENABLED"],
        ["Module", "review-loop.ts"],
        ["A tick can spend", "review rounds — then a full claim → solve → PR"],
        ["Why this clock", "Copilot answers 2½–4 min after a request"],
      ],
    },
  ];
  const pitch = [0.52, 0.52, 0.52, 0.78, 0.78];
  cols.forEach((col, i) => {
    const x = 0.5 + i * 4.18;
    card(s, x, 1.4, 3.95, 3.85, { fill: C.white, line: C.rule });
    s.addText(col.h, {
      shape: pptx.ShapeType.rect,
      x,
      y: 1.4,
      w: 3.95,
      h: 0.55,
      fill: { color: C.navy },
      line: { color: C.navy, width: 0 },
      fontFace: FONT,
      fontSize: 16,
      bold: true,
      color: C.white,
      margin: PAD,
      valign: "middle",
    });
    let y = 2.08;
    col.rows.forEach(([k, v], j) => {
      s.addText(k.toUpperCase(), {
        x: x + 0.2,
        y,
        w: 3.6,
        h: 0.2,
        fontFace: FONT,
        fontSize: 9,
        bold: true,
        color: C.muted,
        margin: 0,
        charSpacing: 1,
      });
      s.addText(v, {
        x: x + 0.2,
        y: y + 0.2,
        w: 3.6,
        h: pitch[j] - 0.22,
        fontFace: j === 2 ? MONO : FONT,
        fontSize: j === 2 ? 11.5 : 12.5,
        color: C.ink,
        margin: 0,
        valign: "top",
      });
      y += pitch[j];
    });
  });
  callout(
    s,
    0.5,
    5.45,
    12.33,
    1.05,
    [
      { text: "Separate loops, not steps of one tick. ", options: { bold: true } },
      {
        text: "A triage may take 20 minutes; sharing a tick would tie the review cadence to it. A review sweep that throws backs off the review side only — grooming never stops.",
        options: { color: "DCE6F2" },
      },
    ],
    { size: 14 },
  );
}

// =====================================================================
// 5. The whole flow
// =====================================================================
{
  const s = content(
    "The whole flow",
    "From new ticket to merged pull request",
    "Read it as a snake: triage on the top row, the solve on the middle row right to left, the review on the bottom row. " +
      "The yellow boxes are the only places a person is required. In auto mode, the go-ahead is skipped for the issue types in SOLVE_AUTO_ISSUE_TYPES (default: Feil). " +
      "Any refusal on the way — a red base, recon declining, a failed verification — ends in agent:failed with the reason posted on the ticket, and never in a pull request.",
  );
  const R1 = 1.6,
    H1 = 0.95;
  node(s, 0.45, R1, 1.55, H1, "New ticket", "SSX board", "neutral");
  node(s, 2.35, R1, 2.25, H1, "Triage", "/intake-triage · 3–8 min", "agent");
  node(s, 4.95, R1, 1.95, H1, "Gate", "verdict + agent fitness", "harness");
  arrow(s, 2.0, R1 + H1 / 2, 2.35, R1 + H1 / 2);
  arrow(s, 4.6, R1 + H1 / 2, 4.95, R1 + H1 / 2);
  const oy = [1.38, 1.9, 2.42];
  node(s, 7.3, oy[0], 2.45, 0.44, "agent:solvable", null, "ok", { titleSize: 11.5 });
  node(s, 7.3, oy[1], 2.45, 0.44, "agent:watching → watch loop", null, "harness", {
    titleSize: 11,
  });
  node(s, 7.3, oy[2], 2.45, 0.44, "verdict posted · no agent", null, "neutral", { titleSize: 11 });
  for (const y of oy) {
    arrow(s, 6.9, R1 + H1 / 2, 7.3, y + 0.22);
  }
  node(s, 10.9, 1.29, 1.95, 0.62, "Go-ahead", "a person adds agent:start", "human", {
    titleSize: 12,
    subSize: 9.5,
  });
  arrow(s, 9.75, oy[0] + 0.22, 10.9, oy[0] + 0.22);
  label(s, 9.85, 2.1, 1.9, 0.6, "auto mode skips this for allowed issue types", {
    size: 9,
    italic: true,
    align: "right",
  });

  const R2 = 3.1,
    H2 = 0.95,
    w2 = 1.95;
  const xs = [10.9, 8.3, 5.7, 3.1, 0.5];
  node(s, xs[0], R2, w2, H2, "Claim", "writes agent:solving first", "harness");
  node(s, xs[1], R2, w2, H2, "Worktree", "base must be green", "harness");
  node(s, xs[2], R2, w2, H2, "Recon", "read-only · go or decline", "agent");
  node(s, xs[3], R2, w2, H2, "Fix → Simplify", "edits files · no shell", "agent");
  node(s, xs[4], R2, w2, H2, "Verify + diff gate", "exit codes, real diff", "harness");
  arrow(s, xs[0] + w2 / 2, 1.91, xs[0] + w2 / 2, R2);
  for (let i = 0; i < 4; i++) {
    arrow(s, xs[i], R2 + H2 / 2, xs[i + 1] + w2, R2 + H2 / 2);
  }

  s.addText(
    [
      { text: "✕  ", options: { bold: true } },
      { text: "red base · recon declines · verification fails  →  " },
      { text: "agent:failed", options: { bold: true } },
      { text: ", reason posted on the ticket — never a PR" },
    ],
    {
      x: 2.9,
      y: 4.2,
      w: 9.9,
      h: 0.4,
      fontFace: FONT,
      fontSize: 12,
      color: C.bad,
      margin: 0,
      align: "right",
      valign: "middle",
    },
  );

  const R3 = 4.95,
    H3 = 0.95,
    w3 = 2.2;
  const x3 = [0.45, 2.98, 5.51, 8.04, 10.57];
  node(s, x3[0], R3, w3, H3, "Draft PR", "@copilot · agent:reviewing", "harness");
  node(s, x3[1], R3, w3, H3, "Review rounds", "fix · push · reply · resolve", "agent");
  node(s, x3[2], R3, w3, H3, "Undraft", "agent:review-done", "harness");
  node(s, x3[3], R3, w3, H3, "Review & merge", "a person", "human");
  node(s, x3[4], R3, w3, H3, "agent:done", "means merged", "ok");
  arrow(s, 1.5, R2 + H2, 1.5, R3);
  for (let i = 0; i < 4; i++) {
    arrow(s, x3[i] + w3, R3 + H3 / 2, x3[i + 1], R3 + H3 / 2);
  }
  label(s, x3[1], R3 + H3 + 0.03, w3, 0.3, "↻ every 2 min until nothing is left", {
    size: 9.5,
    italic: true,
  });

  legend(s, 6.55);
}

// =====================================================================
// 6. Harness vs agents
// =====================================================================
{
  const s = content(
    "The split",
    "Who does what: a deterministic harness, and agents that judge",
    "This is the most important structural fact about the bot. Only one of the two actors has a shell. " +
      "Models make judgements — is this ticket ready, did the reporter answer, what is the fix — and the harness does everything that can be checked mechanically, including grading the model's work by exit codes. " +
      "The credentials follow the same split: the REST credential for discovery and labels never enters a model's environment; comments are written by the triage poster through the Atlassian MCP session, as a real Jira user.",
  );
  const colW = 6.0;
  const cols = [
    {
      x: 0.5,
      kind: "harness",
      head: "Harness — plain Node code, no opinions",
      gap: 7,
      items: [
        "Finds new tickets over Jira REST and keeps the cursor",
        "Gates every verdict before it is posted — ~0 ms",
        "Claims, labels, counts attempts, enforces capacity",
        "Cuts the worktree; runs git, gh, install, types, lint, tests",
        "Reads exit codes: passed · failed · refused",
        "Diff gate, escape check, widening check",
        "Commits, pushes, opens the draft PR, posts the replies",
        "Draws the Slack thread and saves its record on the ticket",
      ],
    },
    {
      x: 6.83,
      kind: "agent",
      head: "Agents — model sessions, no shell",
      gap: 16,
      items: [
        [
          { text: "Triage analyst", bold: true },
          { text: " — runs /intake-triage: verdict + agent fitness" },
        ],
        [
          { text: "Triage poster", bold: true },
          { text: " — a second session holding the finished text; writes it to Jira" },
        ],
        [
          { text: "Relevance check", bold: true },
          { text: " — no tools at all: did they answer the sendback?" },
        ],
        [{ text: "Recon", bold: true }, { text: " — read-only: proceed with a plan, or decline" }],
        [
          { text: "Fix · Simplify · Review · Merge · Repair", bold: true },
          { text: " — edit files, never run anything" },
        ],
      ],
    },
  ];
  for (const col of cols) {
    const k = KIND[col.kind];
    s.addShape(pptx.ShapeType.roundRect, {
      x: col.x,
      y: 1.4,
      w: colW,
      h: 4.15,
      rectRadius: 0.06,
      fill: { color: k.fill },
      line: { color: k.line, width: 1.5 },
    });
    s.addText(col.head, {
      x: col.x + 0.25,
      y: 1.5,
      w: colW - 0.5,
      h: 0.5,
      fontFace: FONT,
      fontSize: 17,
      bold: true,
      color: k.title,
      margin: 0,
      valign: "middle",
    });
    s.addText(bullets(col.items, { gap: col.gap }), {
      x: col.x + 0.25,
      y: 2.1,
      w: colW - 0.45,
      h: 3.35,
      fontFace: FONT,
      fontSize: 15,
      color: C.ink,
      valign: "top",
      margin: 0,
    });
  }
  callout(
    s,
    0.5,
    5.75,
    6.0,
    0.95,
    [
      { text: "Only one of the two has a shell. ", options: { bold: true } },
      { text: "The model is never asked whether the tests passed.", options: { color: "DCE6F2" } },
    ],
    { size: 14 },
  );
  callout(
    s,
    6.83,
    5.75,
    6.0,
    0.95,
    [
      { text: "Two credentials, never swapped. ", options: { bold: true } },
      {
        text: "REST (harness) for discovery and labels; the MCP session (agent) for comments. Triage never gets JIRA_* in its environment.",
        options: { color: "DCE6F2" },
      },
    ],
    { size: 12.5 },
  );
}

// =====================================================================
// 7. The watcher
// =====================================================================
{
  const s = content(
    "Watchers",
    "The sendback watch: re-triage only when someone actually answered",
    "When triage sends a ticket back but judges it nearly fixable, it labels it agent:watching and its comment lists the blockers. " +
      "The watch spends money with nobody having asked, so every step is ordered cheapest first: a free check of who moved, a cents-level relevance check, and only then the dollar-level triage. " +
      "The counter is a reservation written before the run, never a receipt after it — a failed receipt would hand back a free run every sweep. " +
      "On SSX-3834 the reporter answered at 13:05 and the watch re-triaged it to agent:solvable at 13:11.",
  );
  s.addText(
    "Triage sends a nearly-solvable ticket back with agent:watching and a comment listing the blockers. Then:",
    {
      x: 0.5,
      y: 1.3,
      w: 12.3,
      h: 0.4,
      fontFace: FONT,
      fontSize: 14,
      color: C.muted,
      margin: 0,
    },
  );
  const steps = [
    [
      "Did somebody else move?",
      "free",
      "harness",
      "Since our triage comment: anyone else's comment, or an edit to description · summary · attachment · environment.",
    ],
    [
      "Did they answer what we asked?",
      "cents",
      "agent",
      "A relevance check with no tools. Fails closed: a wrong no just waits — a wrong yes costs a $2 triage.",
    ],
    [
      "Reserve the re-triage",
      "free",
      "harness",
      "The count is a label, written before the run. If that write fails, the run does not happen.",
    ],
    [
      "Re-triage",
      "dollars",
      "agent",
      "A full /intake-triage. If it passes, the ticket becomes agent:solvable and the watch ends.",
    ],
  ];
  const tagColor = { free: C.ok, cents: C.human, dollars: C.bad };
  steps.forEach(([t, cost, kind, d], i) => {
    const x = 0.5 + i * 3.16,
      w = 2.85,
      y = 1.95,
      h = 2.6;
    const k = KIND[kind];
    s.addShape(pptx.ShapeType.roundRect, {
      x,
      y,
      w,
      h,
      rectRadius: 0.06,
      fill: { color: k.fill },
      line: { color: k.line, width: 1.5 },
    });
    s.addText(cost.toUpperCase(), {
      shape: pptx.ShapeType.roundRect,
      rectRadius: 0.1,
      x: x + 0.2,
      y: y + 0.2,
      w: 1.05,
      h: 0.32,
      fill: { color: tagColor[cost] },
      line: { color: tagColor[cost], width: 0 },
      fontFace: FONT,
      fontSize: 10,
      bold: true,
      color: C.white,
      align: "center",
      valign: "middle",
      margin: 0,
      charSpacing: 1,
    });
    s.addText(`${i + 1}`, {
      x: x + w - 0.6,
      y: y + 0.15,
      w: 0.4,
      h: 0.4,
      fontFace: FONT,
      fontSize: 20,
      bold: true,
      color: k.line,
      align: "right",
      margin: 0,
    });
    s.addText(t, {
      x: x + 0.2,
      y: y + 0.62,
      w: w - 0.35,
      h: 0.62,
      fontFace: FONT,
      fontSize: 15,
      bold: true,
      color: k.title,
      margin: 0,
      valign: "top",
    });
    s.addText(d, {
      x: x + 0.2,
      y: y + 1.28,
      w: w - 0.35,
      h: 1.25,
      fontFace: FONT,
      fontSize: 12,
      color: C.ink,
      margin: 0,
      valign: "top",
    });
    if (i < 3) {
      arrow(s, x + w + 0.02, y + h / 2, x + 3.16 - 0.02, y + h / 2, { width: 2 });
    }
  });
  const notes = [
    [
      "Keyed on the bot's footer, not the author.",
      "The poster shares a human's Atlassian account, and our own comment bumps the ticket's update time — so \"changed since\" would fire on itself.",
    ],
    [
      'A paid "no" is remembered.',
      "Declined activity is memoised, so the same comment is never judged twice.",
    ],
    [
      "It ends on its own.",
      "The ticket closes, 3 re-triages are spent, or there is nothing left to measure from.",
    ],
  ];
  notes.forEach(([b, t], i) => {
    const x = 0.5 + i * 4.18;
    card(s, x, 4.8, 3.95, 1.6);
    s.addText(
      [
        { text: b, options: { bold: true, color: C.navy, breakLine: true } },
        { text: t, options: { color: C.ink } },
      ],
      {
        x: x + 0.2,
        y: 4.86,
        w: 3.6,
        h: 1.48,
        fontFace: FONT,
        fontSize: 12.5,
        margin: 0,
        valign: "middle",
      },
    );
  });
  legend(s, 6.58);
}

// =====================================================================
// 8. State
// =====================================================================
{
  const s = content(
    "State",
    "State lives on the ticket, where a person can read it",
    "No solve state lives on disk. The claim is a single label edit, agent:solving, written before any work starts — that is what makes the queue idempotent across restarts. " +
      "agent:reviewing replaces it, so a pull request waiting days on a human doesn't hold the only concurrency slot. " +
      "A run released without a verdict — a slept laptop, a transient failure — puts the labels back exactly as it found them rather than writing agent:failed. " +
      "Honest caveat: there is no compare-and-swap, so a second instance could still race a claim between its re-read and its write.",
  );
  const W = 2.05,
    H = 0.62;
  const P = {
    watching: [0.5, 1.5],
    solvable: [2.95, 1.5],
    start: [5.4, 1.5],
    solving: [2.95, 2.75],
    failed: [5.4, 2.75],
    reviewing: [2.95, 4.0],
    reviewDone: [5.4, 4.0],
    done: [2.95, 5.25],
    closed: [5.4, 5.25],
  };
  const o = { titleSize: 12, subSize: 9 };
  node(s, ...P.watching, W, H, "agent:watching", "until re-triage passes", "harness", o);
  node(s, ...P.solvable, W, H, "agent:solvable", "triage says fixable", "ok", o);
  node(s, ...P.start, W, H, "agent:start", "a person · manual mode", "human", o);
  node(s, ...P.solving, W, H, "agent:solving", "the claim", "harness", o);
  node(s, ...P.failed, W, H, "agent:failed", "a verdict, no PR", "bad", o);
  node(s, ...P.reviewing, W, H, "agent:reviewing", "draft PR open", "harness", o);
  node(s, ...P.reviewDone, W, H, "agent:review-done", "undrafted", "harness", o);
  node(s, ...P.done, W, H, "agent:done", "merged", "ok", o);
  node(s, ...P.closed, W, H, "agent:closed", "closed unmerged", "neutral", o);
  const cx = (p) => p[0] + W / 2,
    cy = (p) => p[1] + H / 2;
  arrow(s, P.watching[0] + W, cy(P.watching), P.solvable[0], cy(P.solvable));
  arrow(s, P.solvable[0] + W, cy(P.solvable), P.start[0], cy(P.start));
  arrow(s, cx(P.solvable), P.solvable[1] + H, cx(P.solving), P.solving[1]);
  label(s, cx(P.solvable) + 0.08, 2.2, 0.9, 0.45, "auto", { size: 9, italic: true, align: "left" });
  arrow(s, cx(P.start) - 0.3, P.start[1] + H, P.solving[0] + W - 0.1, P.solving[1]);
  arrow(s, P.solving[0] + W, cy(P.solving), P.failed[0], cy(P.failed));
  arrow(s, cx(P.solving), P.solving[1] + H, cx(P.reviewing), P.reviewing[1]);
  arrow(s, P.reviewing[0] + W, cy(P.reviewing) - 0.1, P.reviewDone[0], cy(P.reviewDone) - 0.1);
  arrow(s, P.reviewDone[0], cy(P.reviewDone) + 0.1, P.reviewing[0] + W, cy(P.reviewing) + 0.1);
  arrow(s, cx(P.reviewing), P.reviewing[1] + H, cx(P.done), P.done[1]);
  arrow(s, cx(P.reviewDone), P.reviewDone[1] + H, cx(P.closed), P.closed[1]);

  const stores = [
    [
      "Ticket labels",
      "agent:* is the state machine. agent:solving is written before any work — that one edit is the claim.",
    ],
    [
      "Ticket property",
      "jira-police.slack — which Slack message is the ticket's thread, and the record it shows.",
    ],
    ["PR marker comment", "The review cursor and the rounds spent, reserved before each round."],
    ["Local disk", "Only grooming's cursor: state/poll.json."],
  ];
  s.addText("Where each piece of state lives", {
    x: 7.9,
    y: 1.35,
    w: 4.9,
    h: 0.4,
    fontFace: FONT,
    fontSize: 15,
    bold: true,
    color: C.navy,
    margin: 0,
  });
  stores.forEach(([t, d], i) => {
    const y = 1.85 + i * 1.02;
    card(s, 7.9, y, 4.93, 0.9, { fill: i === 3 ? C.white : C.soft });
    s.addText(
      [
        { text: t, options: { bold: true, color: C.navy, breakLine: true } },
        { text: d, options: { color: C.ink } },
      ],
      {
        x: 8.08,
        y: y + 0.04,
        w: 4.6,
        h: 0.82,
        fontFace: FONT,
        fontSize: 12,
        margin: 0,
        valign: "middle",
      },
    );
  });
  callout(
    s,
    7.9,
    6.0,
    4.93,
    0.75,
    [
      {
        text: "Survives a restart, a wiped state/ and a second instance. ",
        options: { bold: true },
      },
      { text: "agent:done means merged.", options: { color: "DCE6F2" } },
    ],
    { size: 12.5 },
  );
}

// =====================================================================
// 9. Six passes
// =====================================================================
{
  const s = content(
    "The solver",
    "Six agent workflows — each one its own session",
    "Each row is a separate storecode invocation of the agent-solve skill, not a turn of one conversation. " +
      "Recon runs first and its verdict is honoured: if it declines, no model ever gets write access for that ticket. " +
      "Simplify deliberately does not see the recon plan — handing it the plan would invite it to reconsider the change instead of how it is written. " +
      "Repair exists only after a failed verification, and its result is thrown away unless the run is armed with --repair, or REPAIR_PUBLISH for the daemon.",
  );
  const hdr = (t) => ({
    text: t,
    options: { bold: true, color: C.white, fill: { color: C.agentDark } },
  });
  const pass = (t) => ({ text: t, options: { bold: true, color: C.agentDark, fontFace: MONO } });
  const rows = [
    [hdr("Pass"), hdr("Tools"), hdr("Given, besides the ticket"), hdr("Its job")],
    [
      pass("recon"),
      "Read · Grep · Glob — read-only",
      "nothing else",
      "Is triage's dev lens right? Proceed with a plan, or decline — then nothing gets write access",
    ],
    [
      pass("fix"),
      "…plus Edit · Write",
      "the recon verdict",
      "Implement the brief; the change is judged against it",
    ],
    [
      pass("simplify"),
      "fix's tools + Skill (/simplify)",
      "the diff — not the recon verdict",
      "Improve how the change is written, not what it does",
    ],
    [
      pass("review"),
      "fix's tools",
      "the reviewer's comments",
      "One round per batch of feedback: fix, and answer each thread",
    ],
    [
      pass("merge"),
      "fix's tools",
      "the conflicted paths — not the review",
      "Take in a base that moved; never -X ours / theirs",
    ],
    [
      pass("repair"),
      "fix's tools",
      "the harness's captured failure output",
      "Only after a failed verification; kept only when armed",
    ],
  ];
  s.addTable(rows, {
    x: 0.5,
    y: 1.4,
    w: 12.33,
    colW: [1.3, 2.8, 3.2, 5.03],
    fontFace: FONT,
    fontSize: 12,
    color: C.ink,
    valign: "middle",
    border: { type: "solid", pt: 0.75, color: C.rule },
    rowH: 0.5,
    margin: 5,
    fill: { color: C.white },
  });
  callout(
    s,
    0.5,
    5.45,
    6.0,
    1.25,
    [
      { text: "Denied in every pass: ", options: { bold: true } },
      {
        text: "Bash · Task · WebFetch · WebSearch — and no MCP server at all. No git, no test runner, no network, no sub-agents.",
        options: { color: "E6DEF7" },
      },
    ],
    { size: 13.5, fill: C.agentDark },
  );
  callout(
    s,
    6.83,
    5.45,
    6.0,
    1.25,
    [
      { text: "Separate sessions, not one conversation: ", options: { bold: true } },
      {
        text: "a pass can't carry a capability past the point it was granted, and one that dies can't leave the next reasoning from half a conversation.",
        options: { color: "DCE6F2" },
      },
    ],
    { size: 13.5 },
  );
}

// =====================================================================
// 10. Verification
// =====================================================================
{
  const s = content(
    "Verification",
    "The harness decides if it passed — no model is asked",
    '"Did it work" is the one question the thing being judged must not answer about itself. ' +
      "Quality is a different question, and models do weigh in on it: the simplify pass reads the diff cold, the bot requests a Copilot review, and review rounds answer it. But pass or fail is only ever exit codes. " +
      "The commands come from the base's manifest via git show, never from the worktree — and that alone is not enough, because the package manager reads whatever is on disk. " +
      "So verification also refuses to run unless the files that define passing are byte-identical to the base. " +
      "The fail-first probe runs the new tests against the untouched base: green there means the test proves nothing, and the PR body says so. It reports; it never blocks a good fix.",
  );
  const steps = [
    [
      1.4,
      1.2,
      "Base check",
      "harness",
      'Before any pass: install · types · lint · test on the untouched base. Red → no run: "failed" only means something against a base that passes.',
    ],
    [2.85, 0.78, "The passes", "agent", "recon → fix → simplify"],
    [
      3.88,
      1.05,
      "Verify",
      "harness",
      "The same steps on the worktree. Commands come from the base's manifest, never the worktree's.",
    ],
    [
      5.18,
      1.05,
      "Fail-first probe",
      "harness",
      "The run's new tests on the untouched base, without the fix. Green there = the test proves nothing. Next slide.",
    ],
  ];
  steps.forEach(([y, h, t, kind, d], i) => {
    node(s, 0.5, y, 5.6, h, t, d, kind, {
      titleSize: 14,
      subSize: 11.5,
      align: "left",
      margin: PAD,
    });
    if (i < steps.length - 1) {
      arrow(s, 3.3, y + h, 3.3, steps[i + 1][0]);
    }
  });
  const H = (t) => ({
    text: t,
    options: { bold: true, color: C.white, fill: { color: C.harnessDark } },
  });
  s.addTable(
    [
      [H("Outcome"), H("Means"), H("Example")],
      [
        { text: "passed", options: { bold: true, color: C.ok, fontFace: MONO } },
        "every step ran and passed",
        "the only outcome that may become a PR",
      ],
      [
        { text: "failed", options: { bold: true, color: C.bad, fontFace: MONO } },
        "a step ran and did not pass — a fact about the code",
        "tests red; a step timed out",
      ],
      [
        { text: "refused", options: { bold: true, color: C.human, fontFace: MONO } },
        "no verdict was reached at all",
        "manifest edited; install died; git failed",
      ],
    ],
    {
      x: 6.5,
      y: 1.4,
      w: 6.33,
      colW: [1.15, 2.75, 2.43],
      fontFace: FONT,
      fontSize: 12,
      color: C.ink,
      border: { type: "solid", pt: 0.75, color: C.rule },
      rowH: 0.62,
      valign: "middle",
      margin: 5,
    },
  );
  callout(
    s,
    6.5,
    4.25,
    6.33,
    0.95,
    [
      { text: "refused is never reported as failed. ", options: { bold: true } },
      { text: "A broken harness must not read as a broken fix.", options: { color: "DCE6F2" } },
    ],
    { size: 13.5 },
  );
  callout(
    s,
    6.5,
    5.35,
    6.33,
    0.95,
    [
      { text: "No grading your own exam: ", options: { bold: true, color: C.navy } },
      {
        text: "verification won't run unless the files that define passing are byte-identical to the base.",
        options: { color: C.ink },
      },
    ],
    { size: 13, fill: C.harnessFill },
  );
}

// =====================================================================
// 10b. Fail-first probe
// =====================================================================
{
  const s = content(
    "Verification",
    "Fail-first: take the fix away — does the test notice?",
    "The house rule behind this: a guard isn't shipped until it fails when unplugged. The probe applies it to the tests the solver writes. " +
      "It runs after verification has passed. The fix in the run's worktree is verified but uncommitted, so it is never reverted: the harness cuts a second, detached checkout of the base, copies only the run's test files onto it, installs, and runs the base's own test command. " +
      "The base was checked green before any pass ran, so a red run points at the new tests. " +
      "Red is reported as guarded but trusted only weakly: it proves the tests fail against no fix at all, not against a plausible wrong fix. That stronger check is asked of the solver in prose, because code can't list the wrong fixes. " +
      "Green is the finding that matters: the PR body gets a warning naming the test files. It never blocks the PR, because the fix may still be right. " +
      "On by default; FAIL_FIRST_CHECK=false turns it off.",
  );
  label(s, 0.5, 1.4, 5.8, 0.3, "THE EXPERIMENT — plain code, after verify has passed", {
    bold: true,
    align: "left",
    size: 10.5,
  });
  const steps = [
    [
      1.8,
      "1  A second checkout of the base",
      "A detached worktree of the untouched base branch: the bug is still there, the fix is not. The run's own worktree is left alone.",
    ],
    [
      3.0,
      "2  Lay the run's test files on top",
      "Only the test files the run added or changed (*.test.*, __tests__/, test/), copied from the fix.",
    ],
    [
      4.2,
      "3  Run the base's test command",
      "The same command verify uses, read from the base's manifest. Then the probe checkout is deleted.",
    ],
  ];
  steps.forEach(([y, t, d], i) => {
    node(s, 0.5, y, 5.8, 0.95, t, d, "harness", {
      titleSize: 14,
      subSize: 11.5,
      align: "left",
      margin: PAD,
    });
    if (i < steps.length - 1) {
      arrow(s, 3.4, y + 0.95, 3.4, steps[i + 1][0]);
    }
  });

  label(s, 6.7, 1.4, 6.13, 0.3, "WHAT IT TELLS APART", { bold: true, align: "left", size: 10.5 });
  const H = (t) => ({
    text: t,
    options: { bold: true, color: C.white, fill: { color: C.harnessDark } },
  });
  const cell = (t, kind) => ({
    text: t,
    options: { bold: true, color: KIND[kind].title, fill: { color: KIND[kind].fill } },
  });
  s.addTable(
    [
      [H("The new test…"), H("with the fix (verify)"), H("without the fix (probe)")],
      ["catches the bug", cell("green", "ok"), cell("red → guarded", "ok")],
      ["doesn't touch the bug", cell("green", "ok"), cell("green → vacuous ⚠", "bad")],
    ],
    {
      x: 6.7,
      y: 1.8,
      w: 6.13,
      colW: [1.85, 2.14, 2.14],
      fontFace: FONT,
      fontSize: 12,
      color: C.ink,
      border: { type: "solid", pt: 0.75, color: C.rule },
      rowH: 0.5,
      valign: "middle",
      margin: 5,
    },
  );
  s.addText(
    [
      { text: "Example (illustrative): ", options: { bold: true } },
      {
        text: "the bug is NaN on an empty amount, but the new test only checks formatAmount(100). It is green with and without the fix.",
      },
    ],
    {
      x: 6.7,
      y: 3.42,
      w: 6.13,
      h: 0.62,
      fontFace: FONT,
      fontSize: 12,
      color: C.muted,
      margin: 0,
      valign: "top",
    },
  );

  const O = (t, color) => ({ text: t, options: { bold: true, color, fontFace: MONO } });
  s.addTable(
    [
      [O("guarded", C.ok), "red without the fix · nothing in the PR, a weak signal"],
      [O("vacuous", C.bad), "green without the fix · ⚠ warning in the PR body"],
      [O("skipped", C.neutral), "no test file changed, or only tests changed"],
      [O("inconclusive", C.neutral), "probe couldn't run, e.g. install failed · says nothing"],
    ],
    {
      x: 6.7,
      y: 4.2,
      w: 6.13,
      colW: [1.45, 4.68],
      fontFace: FONT,
      fontSize: 11.5,
      color: C.ink,
      border: { type: "solid", pt: 0.75, color: C.rule },
      rowH: 0.38,
      valign: "middle",
      margin: 5,
    },
  );

  callout(
    s,
    0.5,
    6.05,
    12.33,
    0.8,
    [
      { text: "It reports; it never blocks. ", options: { bold: true } },
      {
        text: "A vacuous test doesn't make the fix wrong — it means the test proves nothing about it.",
        options: { color: "DCE6F2" },
      },
    ],
    { size: 14 },
  );
}

// =====================================================================
// 11. Scope guard
// =====================================================================
{
  const s = content(
    "The scope guard",
    "What a run is allowed to touch — checked in four places",
    "There is no single component called 'scope guard' in the code: it is four checks at four moments. " +
      "The diff gate reads git diff --numstat -z — the -z matters, because otherwise a filename with a newline, suggested by attacker-controlled ticket text, could forge a second record. Renames are checked on both halves. " +
      "The verification-integrity list is 'the scoreboard you are being scored on': a one-line edit to the vitest config is the dangerous size, not the safe one. " +
      "Widening came from PR #2688: the operator asked three times for unused exports to go, and three rounds declined, because the pass could not tell the operator from Copilot. Now GitHub's authorAssociation decides, and a per-round token makes the label unforgeable from a comment body.",
  );
  const bands = [
    [
      "Before any write",
      "Plan check",
      "Recon's plan names every path the fix would change. A path the diff gate refuses by name — a lockfile, say — stops the run before the fix pass. No model gets write access.",
    ],
    [
      "After the passes",
      "Diff gate",
      "Pure code over the real diff, never the model's account. Location: outside the worktree · .git · CI config · env files · the agent's own skills · lockfiles. Scoreboard, refused at any size: package.json · tsconfig · lint & test config · pom.xml · Maven wrapper (except pom.xml dependency bumps, named in the PR).",
    ],
    [
      "Outside the worktree",
      "Escape check",
      "Snapshots every other checkout the pass can read, before and after. A write the diff gate can't see is still noticed.",
    ],
    [
      "In review",
      "Member-only widening",
      "A review comment may widen the ticket's scope only if GitHub says a repository member wrote it — never Copilot, a bot, or the bot's own replies. The pass must declare each widening; the harness checks it against member comments and the files the PR already changed.",
    ],
  ];
  bands.forEach(([when, name, d], i) => {
    const y = 1.35 + i * 1.2,
      h = 1.12;
    s.addText(
      [
        {
          text: when.toUpperCase(),
          options: { fontSize: 9.5, bold: true, color: "C9D6EA", charSpacing: 1, breakLine: true },
        },
        { text: name, options: { fontSize: 16, bold: true, color: C.white } },
      ],
      {
        shape: pptx.ShapeType.rect,
        x: 0.5,
        y,
        w: 2.75,
        h,
        fill: { color: C.harnessDark },
        line: { color: C.harnessDark, width: 0 },
        fontFace: FONT,
        margin: PAD,
        valign: "middle",
      },
    );
    s.addText(d, {
      shape: pptx.ShapeType.rect,
      x: 3.25,
      y,
      w: 9.58,
      h,
      fill: { color: C.harnessFill },
      line: { color: C.harnessFill, width: 0 },
      fontFace: FONT,
      fontSize: i === 1 ? 12 : 13,
      color: C.ink,
      margin: PAD,
      valign: "middle",
    });
  });
  s.addText(
    [
      { text: "Measured, not vetoed: ", options: { bold: true, color: C.navy } },
      {
        text: "a size cap existed and was deleted — it fired after the money was spent, and a person reviews every PR anyway. Size is still printed on every run.",
        options: { color: C.ink },
      },
    ],
    {
      x: 0.5,
      y: 6.2,
      w: 12.33,
      h: 0.55,
      fontFace: FONT,
      fontSize: 12.5,
      margin: 0,
      valign: "middle",
    },
  );
}

// =====================================================================
// 12. Review rounds
// =====================================================================
{
  const s = content(
    "Review rounds",
    "Working the pull request to a handover",
    "Every two minutes the review loop looks at each open PR. If nobody has responded, it stays a draft — waiting costs two gh reads and no checkout. " +
      "If the base moved it is merged in first; conflicts get their own merge round. A round reserves its marker before doing anything, then fixes, pushes, replies and resolves the threads. " +
      "When a round finds nothing left to change, the PR is undrafted and handed to a person. " +
      "The reviewer cap bounds two machines talking to each other; a person's request is exactly the outside information that cap exists for, so it doesn't count against it. The total of 20 is the brake nothing exempts.",
  );
  const y = 1.55,
    h = 1.05,
    w = 2.25;
  const xs = [0.45, 2.98, 5.51, 8.04, 10.57];
  node(s, xs[0], y, w, h, "Draft PR opened", "@copilot requested\nagent:reviewing", "harness", {
    subSize: 10.5,
  });
  node(s, xs[1], y, w, h, "Anyone responded?", "an unread review\nor an open thread", "harness", {
    subSize: 10.5,
  });
  node(s, xs[2], y, w, h, "Base moved?", "merge it in — conflicts\nget a merge round", "harness", {
    subSize: 10.5,
  });
  node(s, xs[3], y, w, h, "Round", "reserve the marker · fix\npush · reply · resolve", "agent", {
    subSize: 10.5,
  });
  node(s, xs[4], y, w, h, "Undraft", "nothing left to change\nagent:review-done", "harness", {
    subSize: 10.5,
  });
  for (let i = 0; i < 4; i++) {
    arrow(s, xs[i] + w, y + h / 2, xs[i + 1], y + h / 2);
  }
  label(s, xs[1], 1.24, w, 0.28, "↻ nobody yet — stays a draft", { size: 10, italic: true });
  path(
    s,
    [
      [xs[3] + w / 2, y + h],
      [xs[3] + w / 2, 2.9],
      [xs[1] + w / 2, 2.9],
      [xs[1] + w / 2, y + h],
    ],
    { color: C.agent },
  );
  label(s, xs[1] + w / 2, 2.95, xs[3] - xs[1], 0.3, "pushed a change — look again next tick", {
    size: 10,
    italic: true,
    color: C.agentDark,
  });
  node(s, xs[4], 3.0, w, 0.7, "Review & merge", "a person → agent:done", "human", { subSize: 10 });
  arrow(s, xs[4] + w / 2, y + h, xs[4] + w / 2, 3.0);

  card(s, 0.45, 3.95, 6.1, 2.8, { fill: C.soft });
  s.addText("Bounds", {
    x: 0.7,
    y: 4.03,
    w: 5.6,
    h: 0.4,
    fontFace: FONT,
    fontSize: 15,
    bold: true,
    color: C.navy,
    margin: 0,
  });
  s.addText(
    bullets(
      [
        [
          { text: "3 reviewer rounds", bold: true },
          { text: " (MAX_REVIEW_ITERATIONS) — a person's request is outside that cap" },
        ],
        [
          { text: "20 rounds per PR, total", bold: true },
          { text: " (MAX_PR_ROUNDS_TOTAL) — the brake; a merge round spends one too" },
        ],
        [
          { text: "Marker reserved first", bold: true },
          { text: " — a crash can't hand back a free round" },
        ],
        [
          { text: "Push, then reply", bold: true },
          { text: " — a reply never describes a change that didn't land" },
        ],
        [
          { text: "A round that lands nothing says why", bold: true },
          { text: ", to whoever asked" },
        ],
      ],
      { gap: 4 },
    ),
    {
      x: 0.7,
      y: 4.45,
      w: 5.7,
      h: 2.25,
      fontFace: FONT,
      fontSize: 12.5,
      color: C.ink,
      valign: "top",
      margin: 0,
    },
  );

  card(s, 6.83, 3.95, 6.0, 2.8, { fill: C.white });
  s.addText("SSX-3834, 2026-09-06", {
    x: 7.08,
    y: 4.03,
    w: 5.5,
    h: 0.4,
    fontFace: FONT,
    fontSize: 15,
    bold: true,
    color: C.navy,
    margin: 0,
  });
  const tl = [
    ["13:21", "draft PR #2662 opened · agent:reviewing"],
    ["13:24", "Copilot: 2 inline comments — a real NaN regression"],
    ["13:28", "round 1 · fixed, replied, both threads resolved"],
    ["13:30", "Copilot approves"],
    ["13:31", "round 2 · no change · undrafted · agent:review-done"],
  ];
  tl.forEach(([t, e], i) => {
    const yy = 4.5 + i * 0.43;
    s.addText(t, {
      x: 7.08,
      y: yy,
      w: 0.75,
      h: 0.36,
      fontFace: MONO,
      fontSize: 12,
      bold: true,
      color: C.harnessDark,
      margin: 0,
      valign: "middle",
    });
    s.addText(e, {
      x: 7.85,
      y: yy,
      w: 4.9,
      h: 0.36,
      fontFace: FONT,
      fontSize: 12.5,
      color: C.ink,
      margin: 0,
      valign: "middle",
    });
  });
}

// =====================================================================
// 13. Slack audit
// =====================================================================
{
  const s = content(
    "Audit logging",
    "One Slack thread per ticket — and the Jira ticket holds its state",
    "Every ticket the pipeline touches gets one Slack message that the bot keeps editing: a status card, the events that decide the ticket's fate, then the timeline newest first. Replies are left to people. " +
      "The state behind it — which message, and the record it shows — is saved on the ticket itself as the jira-police.slack issue property. " +
      "It was first meant to live in Slack's own message metadata; slack:probe's first run showed Slack drops a custom metadata type unless the app manifest declares it, and a declared one can't hold a list of timeline entries. " +
      "The notifier never throws: Slack is a reporting channel, and a Slack or Jira failure is logged with the remote system's own reason and never fails the paid work. " +
      "The message on the slide is illustrative — the ticket and times are made up, the layout is what render.ts draws.",
  );
  const mx = 0.5,
    my = 1.4,
    mw = 5.75,
    mh = 5.25;
  card(s, mx, my, mw, mh, { fill: C.white, line: "C8CDD3", radius: 0.04 });
  s.addText("B", {
    shape: pptx.ShapeType.roundRect,
    rectRadius: 0.08,
    x: mx + 0.18,
    y: my + 0.17,
    w: 0.42,
    h: 0.42,
    fill: { color: C.navy },
    line: { color: C.navy, width: 0 },
    fontFace: FONT,
    fontSize: 15,
    bold: true,
    color: C.white,
    align: "center",
    valign: "middle",
    margin: 0,
  });
  s.addText(
    [
      { text: "Bencebot", options: { bold: true, color: C.ink } },
      { text: "  APP", options: { fontSize: 8, color: C.muted } },
      { text: "   (edited)", options: { fontSize: 9, color: C.muted } },
    ],
    { x: mx + 0.7, y: my + 0.15, w: 4.5, h: 0.3, fontFace: FONT, fontSize: 12, margin: 0 },
  );
  s.addText("SSX-1234 · Price summary shows NaN for some plans", {
    x: mx + 0.7,
    y: my + 0.45,
    w: 4.9,
    h: 0.35,
    fontFace: FONT,
    fontSize: 13.5,
    bold: true,
    color: C.ink,
    margin: 0,
  });
  s.addText(
    [
      { text: "SSX-1234", options: { color: "1264A3" } },
      { text: " · repo buy-insurance-advisor-web", options: { color: C.muted } },
    ],
    { x: mx + 0.7, y: my + 0.8, w: 4.9, h: 0.25, fontFace: FONT, fontSize: 10, margin: 0 },
  );
  const hr = (yy) =>
    s.addShape(pptx.ShapeType.line, {
      x: mx + 0.7,
      y: yy,
      w: 4.85,
      h: 0,
      line: { color: "E1E4E8", width: 1 },
    });
  hr(my + 1.12);
  const fields = [
    ["Triage", "✅ ready-ish · solvable (high)"],
    ["Work", "✅ implemented and verified"],
    ["PR", "#2701 ready"],
    ["State", "👀 in review"],
  ];
  fields.forEach(([k, v], i) => {
    const fx = mx + 0.7 + (i % 2) * 2.45,
      fy = my + 1.2 + Math.floor(i / 2) * 0.55;
    s.addText([{ text: k, options: { bold: true, breakLine: true } }, { text: v }], {
      x: fx,
      y: fy,
      w: 2.4,
      h: 0.52,
      fontFace: FONT,
      fontSize: 10.5,
      color: C.ink,
      margin: 0,
      valign: "top",
    });
  });
  hr(my + 2.35);
  const major = [
    ["🔍", "Triaged — ready-ish, solvable (high)"],
    ["🚀", "PR opened — #2701 fix(price): guard an empty premium"],
    ["👀", "PR ready for review"],
  ];
  major.forEach(([ic, t], i) => {
    s.addText([{ text: `${ic}  ` }, { text: t, options: { bold: true } }], {
      x: mx + 0.7,
      y: my + 2.43 + i * 0.3,
      w: 4.9,
      h: 0.28,
      fontFace: FONT,
      fontSize: 10.5,
      color: C.ink,
      margin: 0,
    });
  });
  hr(my + 3.38);
  s.addText("Timeline", {
    x: mx + 0.7,
    y: my + 3.44,
    w: 4.9,
    h: 0.25,
    fontFace: FONT,
    fontSize: 10.5,
    bold: true,
    color: C.ink,
    margin: 0,
  });
  const tl = [
    ["10:31", "💬", "review round 2: nothing pushed, 0 answer(s)"],
    ["10:26", "💬", "review round 1: pushed a change, 2 answer(s)"],
    ["10:14", "✅", "verified"],
    ["10:12", "⏹️", "simplify finished"],
    ["10:05", "🙋", "claimed"],
    ["09:41", "🔎", "triage started"],
  ];
  tl.forEach(([t, ic, e], i) => {
    s.addText(`${t}   ${ic}  ${e}`, {
      x: mx + 0.7,
      y: my + 3.72 + i * 0.235,
      w: 4.9,
      h: 0.235,
      fontFace: FONT,
      fontSize: 10,
      color: C.ink,
      margin: 0,
    });
  });
  label(s, mx, my + mh + 0.03, mw, 0.25, "illustrative ticket — the layout render.ts draws", {
    size: 9,
    italic: true,
  });

  const chain = [
    ["Pipeline event", "triage · claim · pass · PR · round · merge · crash"],
    ["Load the record", "from the Jira issue property jira-police.slack"],
    ["Apply the event, draw the message", "both pure — every transition is a test"],
    ["Post, or edit the one message", "chat:write only, bot token only"],
    ["Save the record", "back onto the ticket"],
  ];
  chain.forEach(([t, d], i) => {
    const y = 1.4 + i * 0.86;
    node(s, 6.6, y, 3.05, 0.68, t, d, "harness", { titleSize: 11.5, subSize: 9 });
    if (i < chain.length - 1) {
      arrow(s, 8.125, y + 0.68, 8.125, y + 0.86);
    }
  });
  s.addText(
    bullets(
      [
        [
          { text: "Why the ticket, not Slack? ", bold: true },
          {
            text: "The probe showed Slack drops custom metadata unless declared — and a declared type can't hold a list.",
          },
        ],
        [
          { text: "Never throws. ", bold: true },
          { text: "A Slack or Jira failure is logged, and never fails the paid work." },
        ],
        [
          { text: "off · dry · live. ", bold: true },
          { text: "dry reads the real record and writes the message to groomed/slack/." },
        ],
        [
          { text: "Bounded and escaped. ", bold: true },
          { text: "Capped to fit Jira's property limit; a title of <!channel> pings nobody." },
        ],
      ],
      { gap: 8 },
    ),
    {
      x: 9.95,
      y: 1.4,
      w: 2.9,
      h: 5.3,
      fontFace: FONT,
      fontSize: 11.5,
      color: C.ink,
      valign: "top",
      margin: 0,
    },
  );
}

// =====================================================================
// 14. Ladder
// =====================================================================
{
  const s = content(
    "How it got here",
    "Every privilege was earned, one rung at a time",
    "This is where Part 1 meets Part 2. Every capability shipped in this order: built but inert, then a dry run that writes a report, then one named target behind a flag you must type, and the loop last. " +
      "solve:once climbs a cumulative ladder — --claim writes the label, --solve cuts a worktree and runs the passes, --pr pushes and opens a draft PR, --review works the review. " +
      "--advance and --watch are modes, not rungs: one review round, or keep watching, on a PR an earlier run opened. " +
      "Real tickets were claimed, solved, reviewed and merged this way by hand before the daemon was allowed to do it.",
  );
  const steps = [
    [
      "1",
      "Built, but inert",
      "Nothing constructs its dependencies — the refusal is structural, not promised.",
      null,
    ],
    [
      "2",
      "Dry run",
      "Does everything, changes nothing, writes a report to judge.",
      "poll:once --dry-run\ntriage:once · watch:once\nslack:once",
    ],
    [
      "3",
      "One named ticket",
      "Chosen by a person, behind a flag that must be typed.",
      "solve:once SSX-1234\n--claim → --solve\n→ --pr → --review",
    ],
    ["4", "The loop", "Adds no capability — it only removes the person.", "pnpm start"],
  ];
  const fills = [C.neutralFill, C.harnessFill, "D3E2F6", C.navy];
  steps.forEach(([n, t, d, cmd], i) => {
    const x = 0.5 + i * 3.1,
      w = 2.95,
      hgt = 1.9 + i * 0.95,
      y = 6.6 - hgt;
    const dark = i === 3;
    s.addShape(pptx.ShapeType.rect, {
      x,
      y,
      w,
      h: hgt,
      fill: { color: fills[i] },
      line: { color: dark ? C.navy : C.harness, width: 1 },
    });
    s.addText(
      [
        {
          text: `${n}  ${t}`,
          options: { bold: true, fontSize: 16, color: dark ? C.white : C.navy, breakLine: true },
        },
        { text: d, options: { fontSize: 12, color: dark ? "DCE6F2" : C.ink } },
      ],
      { x: x + 0.15, y: y + 0.12, w: w - 0.3, h: 1.2, fontFace: FONT, margin: 0, valign: "top" },
    );
    if (cmd) {
      s.addText(cmd, {
        x: x + 0.15,
        y: y + 1.35,
        w: w - 0.3,
        h: 0.95,
        fontFace: MONO,
        fontSize: 11,
        color: dark ? C.sky : C.harnessDark,
        margin: 0,
        valign: "top",
      });
    }
  });
  s.addText(
    [
      { text: "STARTING.md: ", options: { bold: true, color: C.siren } },
      {
        text: '"Phase a privilege, and drive it by hand first." The bot\'s ladder is a house rule, applied — which is where Part 2 picks up.',
        options: { color: C.ink },
      },
    ],
    { x: 0.5, y: 1.4, w: 8.9, h: 0.8, fontFace: FONT, fontSize: 14, margin: 0, valign: "top" },
  );
}

// =====================================================================
// 15. Live demo
// =====================================================================
{
  const s = content(
    "Live demo",
    "What I'll run",
    "Everything here is safe to run live. Only triage:once spends real money (one triage, ~$1.56), and it posts nothing without --write. " +
      "Before the demo, check SLACK_MODE: with live, triage:once and the daemon post to the Slack channel and write the property on the ticket — set it to off or dry unless you want that on screen. " +
      "Pick the demo tickets in advance, including one with agent:watching for step 4. Delete this slide if you'd rather demo freely.",
  );
  const rows = [
    ["pnpm poll:once --dry-run", "What the grooming loop would triage right now — changes nothing"],
    [
      "pnpm triage:once SSX-1234 --skill intake-triage",
      "A real verdict for one ticket, not posted — add --write to post it",
    ],
    [
      "SOLVE_ENABLED=true pnpm solve:once",
      "Which tickets the solve queue would claim, and the exact label edits → groomed/solve-cycle.md",
    ],
    [
      "pnpm watch:once SSX-1234",
      "What the sendback watch would do to a watched ticket, without posting",
    ],
    ["pnpm slack:once SSX-1234", "The ticket's audit thread, drawn dry → groomed/slack/"],
    [
      "pnpm start --skill mock-triage --interval 10s --for 1m",
      "The daemon with a stand-in skill, for one minute",
    ],
  ];
  rows.forEach(([cmd, what], i) => {
    const y = 1.45 + i * 0.85;
    s.addText(`${i + 1}`, {
      shape: pptx.ShapeType.ellipse,
      x: 0.5,
      y: y + 0.12,
      w: 0.46,
      h: 0.46,
      fill: { color: C.navy },
      line: { color: C.navy, width: 0 },
      fontFace: FONT,
      fontSize: 14,
      bold: true,
      color: C.white,
      align: "center",
      valign: "middle",
      margin: 0,
    });
    s.addText(cmd, {
      shape: pptx.ShapeType.rect,
      x: 1.15,
      y,
      w: 6.2,
      h: 0.7,
      fill: { color: C.navy },
      line: { color: C.navy, width: 0 },
      fontFace: MONO,
      fontSize: 12.5,
      color: C.sky,
      margin: PAD,
      valign: "middle",
    });
    s.addText(what, {
      x: 7.55,
      y,
      w: 5.3,
      h: 0.7,
      fontFace: FONT,
      fontSize: 13,
      color: C.ink,
      margin: 0,
      valign: "middle",
    });
  });
}

// =====================================================================
// 16. Section: Part 2
// =====================================================================
section(
  2,
  "How the development is instructed",
  "The bot is built with a coding agent too. These are its rules — and where they came from.",
  [
    "The instruction stack: CLAUDE.md, the house rules, the incident log",
    "Four phases, loaded when you are in them",
    "Architecture docs as an index, with every fact in one place",
    "Incidents that amend the rules — a self-reinforcing loop",
    "Guardrails, the four questions, and how little either proves",
  ],
  "The same discipline the bot runs under — don't trust self-report, earn privileges in phases, keep state where people can read it — is how the agent that develops it is instructed. Part 2 shows the structure, and then the loop that keeps amending it.",
);

// =====================================================================
// 17. Instruction stack
// =====================================================================
{
  const s = content(
    "The instruction stack",
    "Where the instructions live, and what each layer is for",
    "CLAUDE.md is the only file that is always in context, and it is also what survives a compaction — so it holds the three rules that are not advisory, the four questions, and a table saying which phase file to load. " +
      "The house rules are an index plus four short phase files, split the way a change happens. INCIDENTS.md is the evidence behind the rules, and deliberately not on the reading path for doing work. " +
      "Four documents are treated as source code: a change that makes a sentence in any of them false must rewrite that sentence in the same commit.",
  );
  const L = 0.5,
    Wd = 7.1;
  node(
    s,
    L,
    1.4,
    Wd,
    1.0,
    "CLAUDE.md",
    "Always loaded, and survives compaction. The three rules, the four questions, which phase to load.",
    "navy",
    { titleSize: 16, subSize: 12, align: "left", margin: [12, 12, 3, 3] },
  );
  arrow(s, L + Wd / 2, 2.4, L + Wd / 2, 2.6);
  node(
    s,
    L,
    2.6,
    Wd,
    0.8,
    "dev-house-rules / SKILL.md",
    'The index — "load the phase you are in"',
    "harness",
    { titleSize: 14, subSize: 11.5, align: "left", margin: [12, 12, 3, 3] },
  );
  arrow(s, L + Wd / 2, 3.4, L + Wd / 2, 3.6);
  const phases = ["STARTING", "BUILDING", "PROVING", "FINISHING"];
  const whens = ["before the first edit", "while writing", "while proving", "on the way out"];
  phases.forEach((p, i) =>
    node(s, L + i * 1.8, 3.6, 1.7, 0.9, p, whens[i], "harness", { titleSize: 12.5, subSize: 10 }),
  );
  node(
    s,
    L,
    4.75,
    Wd,
    1.0,
    "INCIDENTS.md",
    "The evidence: 64 dated entries, append-only. Every rule that cites one links here. Not on the reading path.",
    "neutral",
    { titleSize: 14, subSize: 11.5, align: "left", margin: 12, dash: "dash" },
  );
  s.addText("rules cite their incident  ↑", {
    x: L,
    y: 5.8,
    w: Wd,
    h: 0.3,
    fontFace: FONT,
    fontSize: 10,
    italic: true,
    color: C.muted,
    margin: 0,
    align: "center",
  });

  card(s, 7.95, 1.4, 4.88, 2.65, { fill: C.navy, line: C.navy });
  s.addText("Three rules that are not advisory", {
    x: 8.15,
    y: 1.5,
    w: 4.5,
    h: 0.4,
    fontFace: FONT,
    fontSize: 14,
    bold: true,
    color: C.siren,
    margin: 0,
  });
  s.addText(
    [
      { text: "1  Never work on main", options: { bold: true, breakLine: true } },
      { text: "    or any protected branch.", options: { color: "C9D6EA", breakLine: true } },
      { text: "2  A human merges. Always.", options: { bold: true, breakLine: true } },
      {
        text: "    Opening the PR ends the agent's side.",
        options: { color: "C9D6EA", breakLine: true },
      },
      { text: "3  Work in its own worktree.", options: { bold: true, breakLine: true } },
      { text: "    The primary checkout is the running daemon.", options: { color: "C9D6EA" } },
    ],
    {
      x: 8.15,
      y: 1.95,
      w: 4.55,
      h: 2.0,
      fontFace: FONT,
      fontSize: 12.5,
      color: C.white,
      margin: 0,
      valign: "top",
    },
  );
  card(s, 7.95, 4.2, 4.88, 2.5, { fill: C.soft });
  s.addText("Four documents, all treated as source", {
    x: 8.15,
    y: 4.28,
    w: 4.5,
    h: 0.4,
    fontFace: FONT,
    fontSize: 14,
    bold: true,
    color: C.navy,
    margin: 0,
  });
  s.addText(
    bullets(
      [
        [{ text: "README.md", bold: true }, { text: " — how to run it" }],
        [{ text: "ARCHITECTURE.md", bold: true }, { text: " — how it works (an index)" }],
        [{ text: "PLAN.md", bold: true }, { text: " — what is not built; never lessons" }],
        [{ text: "dev-house-rules", bold: true }, { text: " — how we work" }],
      ],
      { gap: 3 },
    ),
    {
      x: 8.15,
      y: 4.7,
      w: 4.55,
      h: 1.25,
      fontFace: FONT,
      fontSize: 12.5,
      color: C.ink,
      margin: 0,
      valign: "top",
    },
  );
  s.addText("Prose a change falsifies is rewritten in the same commit.", {
    x: 8.15,
    y: 5.98,
    w: 4.55,
    h: 0.6,
    fontFace: FONT,
    fontSize: 12,
    italic: true,
    bold: true,
    color: C.siren,
    margin: 0,
    valign: "middle",
  });
}

// =====================================================================
// 18. Four phases
// =====================================================================
{
  const s = content(
    "The phases",
    "Four phases — load the one you are in",
    "The rules are split the way a change is: before the first edit, while writing, while proving, and on the way out. Each file is short and links to the next. " +
      "The one to single out is the loop in PROVING: dev, test, run, human, reevaluate. It is the only rule whose absence is invisible, because skipping it leaves everything green. " +
      "Its table is one-sided: every defect of consequence here — a loop that exited immediately, a tool allowlist that restricted nothing, an icon drawn from an adjective — shipped with a green suite and was found by running the thing.",
  );
  const cols = [
    [
      "1",
      "STARTING",
      "before the first edit",
      [
        "Prose a change falsifies is rewritten in the same commit",
        "Write the plan into PLAN.md first; delete it before pushing",
        "Phase a privilege: inert → dry run → one named target → loop",
        "One branch per privilege, its own worktree; don't stack deep",
      ],
    ],
    [
      "2",
      "BUILDING",
      "while writing",
      [
        "The defect class: prose describing behaviour the code no longer has",
        "Fail closed — except guards, which fail open",
        "State lives in the remote system",
        "A failure explains itself on the first run",
        "Delete what your change orphaned",
      ],
    ],
    [
      "3",
      "PROVING",
      "while proving",
      [
        "A guard ships only when a test fails with it unplugged — against the plausible wrong fix",
        "Measure, don't assume",
        "The loop: dev → test → run → human → reevaluate",
        "Every capability gets a one-line command",
      ],
    ],
    [
      "4",
      "FINISHING",
      "on the way out",
      [
        "Re-read the phase file; never recall it",
        "Run the checks",
        "Ask the four questions",
        '"Rules owed:" in every PR body',
        "Postmortem; propose before amending",
      ],
    ],
  ];
  cols.forEach(([n, name, when, items], i) => {
    const x = 0.5 + i * 3.1,
      w = 2.95;
    card(s, x, 1.4, w, 4.65, { fill: C.white });
    s.addText(
      [
        {
          text: `${n}  ${name}`,
          options: { bold: true, fontSize: 16, color: C.white, breakLine: true },
        },
        { text: when, options: { fontSize: 11, color: "C9D6EA" } },
      ],
      {
        shape: pptx.ShapeType.rect,
        x,
        y: 1.4,
        w,
        h: 0.8,
        fill: { color: C.navy },
        line: { color: C.navy, width: 0 },
        fontFace: FONT,
        margin: PAD,
        valign: "middle",
      },
    );
    s.addText(bullets(items, { gap: 12 }), {
      x: x + 0.15,
      y: 2.38,
      w: w - 0.28,
      h: 3.6,
      fontFace: FONT,
      fontSize: 14,
      color: C.ink,
      margin: 0,
      valign: "top",
    });
  });
  callout(
    s,
    0.5,
    6.2,
    12.33,
    0.6,
    [
      { text: '"If you read one section, read the loop." ', options: { bold: true } },
      {
        text: "It is the only rule whose absence is invisible — skip it and everything still looks green.",
        options: { color: "DCE6F2" },
      },
    ],
    { size: 13 },
  );
}

// =====================================================================
// 19. Architecture
// =====================================================================
{
  const s = content(
    "The architecture docs",
    "An index, and every structural fact in exactly one place",
    "ARCHITECTURE.md used to be the whole map — 3,160 lines, sixteen sections — and a document that size stops getting reread, so the rule that it moves with the code quietly stopped applying. " +
      "It was split by module on 2026-09-18. Headings were moved whole, never renumbered, so a §7 in a code comment written months ago still resolves. " +
      "A fact lives in one file and is cited from everywhere else, and docs:check fails CI if a citation, a link or a pinned copy stops resolving. " +
      "not-built.md is worth a mention: 'we considered it and decided not to' survives the session that considered it.",
  );
  node(s, 0.5, 1.4, 6.3, 0.7, "ARCHITECTURE.md", "the index: which file owns which fact", "navy", {
    titleSize: 15,
    subSize: 11,
  });
  const files = [
    ["overview.md", "§1 §2 §5 §6 §8 §9 §11", "loops, state, failure model"],
    ["module-map.md", "§7", "which file owns which module"],
    ["triage.md", "§3 §4 §12", "analyse, gate, post"],
    ["solve.md", "§15", "worktree, passes, diff gate"],
    ["configuration.md", "§10", "every setting and flag"],
    ["invariants.md", "§14", "properties everything relies on"],
    ["not-built.md", "§13", "what it deliberately doesn't do"],
    ["guardrails.md", "§16", "hooks — and what they don't prove"],
  ];
  files.forEach(([f, sec, d], i) => {
    const x = 0.5 + (i % 2) * 3.2,
      y = 2.35 + Math.floor(i / 2) * 1.08;
    s.addText(
      [
        {
          text: f,
          options: {
            bold: true,
            fontFace: MONO,
            fontSize: 12,
            color: C.harnessDark,
            breakLine: true,
          },
        },
        { text: sec, options: { fontSize: 10, color: C.siren, bold: true, breakLine: true } },
        { text: d, options: { fontSize: 10.5, color: C.ink } },
      ],
      {
        shape: pptx.ShapeType.roundRect,
        rectRadius: 0.06,
        x,
        y,
        w: 3.1,
        h: 0.95,
        fill: { color: C.harnessFill },
        line: { color: C.harness, width: 1 },
        fontFace: FONT,
        margin: 8,
        valign: "middle",
      },
    );
  });
  s.addText(
    bullets(
      [
        [
          { text: "Was one 3,160-line file. ", bold: true },
          {
            text: "Split by module so checking the map against a change costs about what the change does.",
          },
        ],
        [
          { text: "§N never renumbered. ", bold: true },
          { text: "A §7 in an old code comment still resolves." },
        ],
        [
          { text: "Cited, never restated. ", bold: true },
          { text: "A fact with two homes is eventually wrong in one of them." },
        ],
        [
          { text: "pnpm docs:check, in CI. ", bold: true },
          { text: "Resolves every §N, link, pinned copy and cited number." },
        ],
        [
          { text: "Moves with the code. ", bold: true },
          { text: "When implementation moves, its file moves in the same commit." },
        ],
        [
          { text: "Numbers rot like facts. ", bold: true },
          { text: "The fix that holds is not stating them." },
        ],
      ],
      { gap: 10 },
    ),
    {
      x: 7.25,
      y: 1.45,
      w: 5.6,
      h: 5.2,
      fontFace: FONT,
      fontSize: 13.5,
      color: C.ink,
      valign: "top",
      margin: 0,
    },
  );
}

// =====================================================================
// 20. Incident loop
// =====================================================================
{
  const s = content(
    "Incidents",
    "Incidents amend the rules — a self-reinforcing loop",
    "Nothing in the rules was designed against a theory: each one generalises something that got through. The highest-value trigger is a rule that was followed and the defect happened anyway. " +
      "The postmortem asks for the mechanism, not the blame — 'the model hallucinated' is not a mechanism; 'the pass was handed a summary and nothing marked it as inferred' is. " +
      "One instance is a hypothesis and waits in INCIDENTS.md as 'No rule yet'; the literal-list rule was only named on its third instance. " +
      "And amendments are proposed before they are edited: the change, the defect, where it goes, and honestly what it would and would not catch.",
  );
  const Wn = 3.05,
    Hn = 1.3;
  const N = [
    [
      6.67,
      2.0,
      "A defect gets through",
      "a bug reached main · it survived tests, review and a run · a paid run taught nothing · a rule was followed and it happened anyway",
      "bad",
    ],
    [
      10.85,
      3.35,
      "Postmortem, three questions",
      "Why did it happen? What was the actual fault? What would have caught it — and does that generalise?",
      "neutral",
    ],
    [
      9.3,
      5.65,
      "INCIDENTS.md",
      "Dated, append-only, never edited to look better. A Found by line records what actually caught it.",
      "neutral",
    ],
    [
      4.04,
      5.65,
      "A rule, linked to it",
      'Amended into the phase it belongs to. One instance is a hypothesis: "No rule yet".',
      "harness",
    ],
    [
      2.48,
      3.35,
      "Enforced without memory",
      'Hooks inject it at compaction and commit · docs:check keeps links resolving · CI demands "Rules owed:"',
      "harness",
    ],
  ];
  N.forEach(([cx, cy, t, d, k]) =>
    node(s, cx - Wn / 2, cy - Hn / 2, Wn, Hn, t, d, k, { titleSize: 13, subSize: 10.5 }),
  );
  const col = { color: C.siren, width: 2.25 };
  arrow(s, 8.2, 2.15, 9.3, 2.9, col);
  arrow(s, 11.0, 4.0, 10.35, 5.0, col);
  arrow(s, 7.77, 5.65, 5.57, 5.65, col);
  arrow(s, 3.0, 5.0, 2.55, 4.0, col);
  arrow(s, 4.0, 2.8, 5.14, 2.15, col);
  s.addText(
    [
      { text: "Every rule is a hypothesis", options: { bold: true, breakLine: true } },
      { text: "that has survived so far.", options: { bold: true } },
    ],
    {
      x: 4.5,
      y: 3.35,
      w: 4.35,
      h: 0.8,
      fontFace: FONT,
      fontSize: 17,
      color: C.navy,
      align: "center",
      valign: "middle",
      margin: 0,
    },
  );
  s.addText("…and if one is wrong: propose the amendment, with its evidence, before editing.", {
    x: 4.5,
    y: 4.2,
    w: 4.35,
    h: 0.6,
    fontFace: FONT,
    fontSize: 11,
    italic: true,
    color: C.muted,
    align: "center",
    valign: "top",
    margin: 0,
  });
}

// =====================================================================
// 21. Four incidents
// =====================================================================
{
  const s = content(
    "Incidents → rules",
    "Four incidents, four rules",
    "Four representative entries out of 64. The allowlist one is the scariest: for the project's early life, three code comments asserted a restriction that did not exist, and every test agreed with them. " +
      "The favicon is the best illustration of why review is the wrong instrument against a capable producer: the output is always plausible. " +
      "The fail-first replay is why the house rule is stronger than red-green. " +
      "The bottom line is this week's live example: today's README audit found drift from behaviour changes that added no new flag or setting, which STARTING's README trigger doesn't cover. The amendment is proposed in PR #91 and waits for agreement.",
  );
  const cards = [
    [
      "The allowlist that restricted nothing",
      "--allowedTools was believed to limit the model's tools. Four probes with a control showed it only pre-approves: every triage run ever made had Bash, Write and Edit.",
      "Measure, don't assume. Tools are now removed with --disallowedTools.",
    ],
    [
      "The favicon reconstructed from an adjective",
      'The solver couldn\'t open the attached SVG, so it drew "a red block T" from the description. It survived two automated reviews, a human and three review rounds. Nobody loaded the page.',
      "Step 4 of the loop: a person uses the feature — not just reads the diff.",
    ],
    [
      "The fail-first replay",
      "Seven new assertions all went red against the original bug — and only one against the plausible wrong fix. Red-green was satisfied by a suite six-sevenths decorative.",
      "Unplug the plausible wrong implementation, not the bug.",
    ],
    [
      "Nine merged PRs with zero reviews",
      "Nothing had checked a change except the agent that wrote it — the checklist was asserted by the party being checked. CI's first run found format:check red on main.",
      "Run the checks where they can't be skipped: CI, on the pushed ref.",
    ],
  ];
  cards.forEach(([t, d, r], i) => {
    const x = 0.5 + (i % 2) * 6.28,
      y = 1.4 + Math.floor(i / 2) * 2.4,
      w = 6.05,
      h = 2.22;
    card(s, x, y, w, h, { fill: C.white });
    s.addShape(pptx.ShapeType.rect, {
      x,
      y,
      w: 0.09,
      h,
      fill: { color: C.siren },
      line: { color: C.siren, width: 0 },
    });
    s.addText(t, {
      x: x + 0.3,
      y: y + 0.12,
      w: w - 0.45,
      h: 0.42,
      fontFace: FONT,
      fontSize: 15,
      bold: true,
      color: C.navy,
      margin: 0,
      valign: "middle",
    });
    s.addText(d, {
      x: x + 0.3,
      y: y + 0.56,
      w: w - 0.45,
      h: 1.0,
      fontFace: FONT,
      fontSize: 13.5,
      color: C.ink,
      margin: 0,
      valign: "top",
    });
    s.addText(
      [
        { text: "→ Rule  ", options: { bold: true, color: C.siren } },
        { text: r, options: { bold: true, color: C.harnessDark } },
      ],
      {
        x: x + 0.3,
        y: y + 1.6,
        w: w - 0.45,
        h: 0.52,
        fontFace: FONT,
        fontSize: 12,
        margin: 0,
        valign: "middle",
      },
    );
  });
  s.addText(
    [
      { text: "This week: ", options: { bold: true, color: C.siren } },
      {
        text: "the README drifted after behaviour changes that added no flag or setting — and STARTING's README trigger names only those. Amendment proposed in PR #91.",
        options: { color: C.ink },
      },
    ],
    {
      x: 0.5,
      y: 6.2,
      w: 12.33,
      h: 0.55,
      fontFace: FONT,
      fontSize: 12.5,
      margin: 0,
      valign: "middle",
    },
  );
}

// =====================================================================
// 22. Guardrails
// =====================================================================
{
  const s = content(
    "Guardrails",
    "Guardrails for the agent building it — and how little they prove",
    "These guard the people and agents working on the repository; the bot's own solve passes never see them. " +
      "branch-guard treats git as an allowlist: any subcommand it doesn't recognise as a read counts as a write. " +
      "The honest part is the callout: the hook suite proves a script emits a refusal, never that the runtime acts on it; the worktree rule has no guard at all; and the Rules owed step cannot tell a true 'none' from a false one. " +
      "It was written with its own disposal condition: if the fresh-context audit ever returns 'none' on a diff that plainly owes something, delete the step rather than tune it. " +
      "Fun fact for the room: branch-guard refused to let this very deck be written outside a worktree.",
  );
  const H = (t) => ({ text: t, options: { bold: true, color: C.white, fill: { color: C.navy } } });
  const g = (t) => ({ text: t, options: { bold: true, fontFace: MONO, color: C.harnessDark } });
  s.addTable(
    [
      [H("Guard"), H("Fires on"), H("What it does")],
      [
        g("branch-guard.sh"),
        "every Bash, Edit, Write",
        "Refuses writes on main / master / develop / release/*, pushes naming one, and gh pr merge anywhere",
      ],
      [g("branch-stack.sh"), "Bash", "Asks before a new branch stacks more than 3 deep"],
      [
        g("session-brief.sh"),
        "session start · compaction",
        "Injects the contract; after a compaction, inlines the three rules and the four questions",
      ],
      [
        g("commit-brief.sh"),
        "git commit",
        "Shows the four questions at the moment they're for — never blocks",
      ],
      [
        g("CI"),
        "every pull request",
        'types · lint · tests · format · hook suite · docs:check — and a "Rules owed:" line in the PR body',
      ],
    ],
    {
      x: 0.5,
      y: 1.4,
      w: 12.33,
      colW: [2.1, 2.4, 7.83],
      fontFace: FONT,
      fontSize: 12.5,
      color: C.ink,
      border: { type: "solid", pt: 0.75, color: C.rule },
      rowH: 0.5,
      valign: "middle",
      margin: 6,
    },
  );
  card(s, 0.5, 4.75, 12.33, 1.95, { fill: C.humanFill, line: C.human });
  s.addText("Assume nothing mechanical is holding the rules", {
    x: 0.75,
    y: 4.83,
    w: 11.8,
    h: 0.4,
    fontFace: FONT,
    fontSize: 15,
    bold: true,
    color: C.humanDark,
    margin: 0,
  });
  s.addText(
    bullets(
      [
        "The hook suite proves a guard emits a refusal — never that the runtime acts on it.",
        "Rule 3, work in a worktree, has no guard at all.",
        '"Rules owed:" can\'t tell a true none from a false one — it turns the answer into a claim a reviewer can see.',
        "The briefs extract their text from CLAUDE.md and FINISHING.md at run time, so they can't drift from them.",
      ],
      { gap: 3 },
    ),
    {
      x: 0.75,
      y: 5.25,
      w: 11.8,
      h: 1.4,
      fontFace: FONT,
      fontSize: 12.5,
      color: C.ink,
      margin: 0,
      valign: "top",
    },
  );
}

// =====================================================================
// 23. Four questions
// =====================================================================
{
  const s = content(
    "Before every commit",
    "The four questions — no command can answer them",
    "These are the judgement half of the contract: nothing is ever green or red about them, which is exactly why they get skipped. So they are placed where they cannot be missed — in CLAUDE.md, which survives compaction; injected after a compaction; and printed at every git commit. " +
      "docs:check fails if CLAUDE.md's copy drifts from FINISHING.md. " +
      "The fourth is the one skipped in silence, so it was turned into an artifact: every PR body must carry a Rules owed line, produced by a fresh context that did not do the work.",
  );
  const qs = [
    [
      "Any comment near the change that is now true of something else?",
      "Not the ones you edited — the ones you didn't.",
    ],
    [
      "If this fails at 3am, what does it leave behind?",
      "Walk each exit path and name the artifact.",
    ],
    [
      "What did the run refute?",
      "Nothing refuted means no prediction was recorded — or the run was too small.",
    ],
    [
      "Did something get through that these rules do not cover?",
      'Then the rules are the thing to fix. Answered in every PR body as "Rules owed:"',
    ],
  ];
  qs.forEach(([q, sub], i) => {
    const y = 1.45 + i * 1.18;
    s.addText(`${i + 1}`, {
      x: 0.5,
      y,
      w: 0.8,
      h: 1.0,
      fontFace: FONT,
      fontSize: 44,
      bold: true,
      color: C.siren,
      margin: 0,
      valign: "middle",
    });
    s.addText(
      [
        { text: q, options: { bold: true, fontSize: 20, color: C.navy, breakLine: true } },
        { text: sub, options: { fontSize: 13.5, color: C.muted } },
      ],
      {
        x: 1.4,
        y,
        w: 11.4,
        h: 1.0,
        fontFace: FONT,
        margin: 0,
        valign: "middle",
      },
    );
  });
  s.addText(
    'Injected after every compaction and at every git commit · CI fails a PR without "Rules owed:"',
    {
      x: 0.5,
      y: 6.25,
      w: 12.33,
      h: 0.45,
      fontFace: FONT,
      fontSize: 12.5,
      italic: true,
      color: C.muted,
      margin: 0,
      valign: "middle",
    },
  );
}

// =====================================================================
// 24. Mirror
// =====================================================================
{
  const s = content(
    "The through-line",
    "The same principles, on both sides",
    "The punchline of the talk: the bot and the process that builds it follow the same few principles. " +
      "Neither trusts an actor's account of its own work; both remove capabilities rather than asking an actor not to use them; both earn privileges in phases; and both keep their state where a person can read it.",
  );
  const H = (t) => ({ text: t, options: { bold: true, color: C.white, fill: { color: C.navy } } });
  const p = (t) => ({ text: t, options: { bold: true, color: C.navy } });
  s.addTable(
    [
      [H("Principle"), H("In the bot"), H("In how it's built")],
      [
        p("Don't trust self-report"),
        "The harness runs the tests and reads exit codes; the model is never asked",
        'CI on the pushed ref; "Rules owed:" written by a fresh context that didn\'t do the work',
      ],
      [
        p("Least privilege, by absence"),
        "No shell, network or MCP in any pass; triage never holds the REST credential",
        "Branch guard; the agent can't write its own settings; a human merges",
      ],
      [
        p("Earn privileges in phases"),
        "dry run → one named ticket → the loop",
        "inert → dry run → one named target → loop",
      ],
      [
        p("State where people can read it"),
        "Labels, the PR marker, the Jira property behind the Slack thread",
        "PLAN.md, INCIDENTS.md, the PR body",
      ],
      [
        p("A refusal explains itself"),
        "The reason is posted on the ticket, or replied to whoever asked",
        "A failure explains itself on the first run; a Found by line on every new incident",
      ],
    ],
    {
      x: 0.5,
      y: 1.45,
      w: 12.33,
      colW: [2.9, 4.7, 4.73],
      fontFace: FONT,
      fontSize: 13,
      color: C.ink,
      border: { type: "solid", pt: 0.75, color: C.rule },
      rowH: 0.8,
      valign: "middle",
      margin: 7,
    },
  );
}

// =====================================================================
// 25. Takeaways
// =====================================================================
{
  const s = pptx.addSlide({ masterName: "DARK" });
  s.addText("TAKEAWAYS", {
    x: 0.8,
    y: 0.9,
    w: 6,
    h: 0.4,
    fontFace: FONT,
    fontSize: 14,
    bold: true,
    color: C.siren,
    charSpacing: 4,
    margin: 0,
  });
  const t = [
    [
      "Agents judge. ",
      "Deterministic code does everything that can be checked — including grading the agents.",
    ],
    ["Privileges are earned. ", "By hand, then dry, then one ticket, then the loop."],
    ["The rules come from incidents, ", "and are enforced where nobody has to remember them."],
  ];
  t.forEach(([b, r], i) => {
    s.addText(
      [
        { text: b, options: { bold: true, color: C.white } },
        { text: r, options: { color: "C9D6EA" } },
      ],
      {
        x: 0.8,
        y: 1.5 + i * 0.95,
        w: 11.7,
        h: 0.8,
        fontFace: FONT,
        fontSize: 22,
        margin: 0,
        valign: "middle",
      },
    );
  });
  s.addShape(pptx.ShapeType.rect, {
    x: 0.8,
    y: 4.6,
    w: 1.2,
    h: 0.05,
    fill: { color: C.siren },
    line: { color: C.siren, width: 0 },
  });
  s.addText("A human merges. Always.", {
    x: 0.8,
    y: 4.8,
    w: 11.7,
    h: 0.9,
    fontFace: FONT,
    fontSize: 40,
    bold: true,
    color: C.white,
    margin: 0,
  });
  s.addText("Questions?", {
    x: 0.8,
    y: 5.85,
    w: 6,
    h: 0.6,
    fontFace: FONT,
    fontSize: 20,
    color: "A9BCD6",
    margin: 0,
  });
  s.addNotes(
    "Close on the one guarantee no change has touched: the bot has no merge path, and neither does the agent that builds it. Likely questions: cost per ticket (a triage is ~$1.56; the cost per day under the unattended loop has not been measured yet), and what happens when it gets something wrong (agent:failed with the reason on the ticket, or a PR a person declines).",
  );
}

await write("the-jira-police-demo.pptx");
