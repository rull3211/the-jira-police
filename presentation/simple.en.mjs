import { C, FONT, KIND, MONO, PAD, createDeck } from "./deck.mjs";

const { pptx, content, node, arrow, path, label, legend, bullets, card, callout, write } =
  createDeck({
    id: "simple.en",
    title: "the-jira-police — what it can do",
    footer: "the-jira-police  ·  demo 2026-09-29",
    legendItems: [
      ["harness", "Code — plain and predictable"],
      ["agent", "AI — a model session"],
      ["human", "A person"],
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
  s.addText("A bot that grooms every new Jira ticket — and fixes the small ones it safely can", {
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
  s.addText("What it can do  ·  How it keeps itself safe  ·  A real run, end to end", {
    x: 0.8,
    y: 4.4,
    w: 11.5,
    h: 0.5,
    fontFace: FONT,
    fontSize: 16,
    color: "C9D6EA",
    margin: 0,
  });
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
    "The short version: what the bot can do, from a new ticket to a pull request, how it keeps itself safe, and one real ticket that went the whole way. " +
      "The detail behind each slide is in the full deck if anyone asks.",
  );
}

// =====================================================================
// 2. The big picture
// =====================================================================
{
  const s = content(
    "The big picture",
    "What it does, in one picture",
    "Top row: every new ticket gets triaged by the AI, and one of three things happens. Bottom row: once a person says go, the bot fixes it, code checks the work, and it goes through review as a pull request. " +
      "The colours matter for the whole talk: purple is the AI making a judgement, blue is plain code checking or acting, yellow is a person. " +
      "The two yellow boxes are the only places a person is required — and the last one, the merge, is never automated.",
  );
  node(s, 0.5, 1.7, 1.9, 1.0, "New ticket", "on the Jira board", "neutral", {
    titleSize: 14,
    subSize: 11,
  });
  arrow(s, 2.4, 2.2, 2.8, 2.2);
  node(
    s,
    2.8,
    1.7,
    3.0,
    1.0,
    "AI triage",
    "ready? duplicate? ours?\ncan an agent fix it?",
    "agent",
    { titleSize: 14, subSize: 11 },
  );
  const outs = [
    [1.45, "Not ready → a comment lists what's missing", "neutral"],
    [1.98, "Nearly ready → watched until someone answers", "harness"],
    [2.51, "Fixable → handed to the solver", "ok"],
  ];
  for (const [y, t, k] of outs) {
    node(s, 6.3, y, 4.1, 0.5, t, null, k, { titleSize: 12 });
    arrow(s, 5.8, 2.2, 6.3, y + 0.25);
  }
  label(s, 10.55, 1.98, 2.3, 0.5, "↻ re-checked when\nsomeone answers", {
    size: 10.5,
    italic: true,
    align: "left",
  });

  const y2 = 4.05,
    h2 = 1.1,
    w2 = 2.2;
  const xs = [0.5, 3.03, 5.56, 8.09, 10.62];
  const row = [
    ["A person says go", "adds agent:start — or auto for allowed types", "human"],
    ["AI plans, then fixes", "in its own isolated copy", "agent"],
    ["Code checks the work", "tests · types · lint · scope", "harness"],
    ["Draft PR + review", "Copilot reviews, the AI answers", "agent"],
    ["A person merges", "always", "human"],
  ];
  row.forEach(([t, d, k], i) =>
    node(s, xs[i], y2, w2, h2, t, d, k, { titleSize: 13.5, subSize: 11 }),
  );
  for (let i = 0; i < 4; i++) {
    arrow(s, xs[i] + w2, y2 + h2 / 2, xs[i + 1], y2 + h2 / 2);
  }
  path(s, [
    [8.35, 3.01],
    [8.35, 3.55],
    [xs[0] + w2 / 2, 3.55],
    [xs[0] + w2 / 2, y2],
  ]);

  s.addText(
    [
      { text: "✕  ", options: { bold: true } },
      { text: "Any check fails → the reason goes on the ticket — never a PR" },
    ],
    {
      x: 3.03,
      y: 5.3,
      w: 7.3,
      h: 0.4,
      fontFace: FONT,
      fontSize: 13,
      color: C.bad,
      margin: 0,
      valign: "middle",
    },
  );
  legend(s, 6.4);
}

// =====================================================================
// 3. Grooming
// =====================================================================
{
  const s = content(
    "Capability 1 · Grooming",
    "It grooms every new ticket",
    "Every five minutes the bot picks up new tickets and runs Storebrand's intake-triage skill on each one. It answers the questions a PM would otherwise chase by hand. " +
      "The answer goes back on the ticket as a comment and labels. The analysis itself is read-only, and plain code checks the verdict before anything is written.",
  );
  const qs = [
    [
      "Already raised or solved?",
      "Looks for duplicates and earlier deliveries in Jira and the knowledge vault.",
    ],
    ["Ready to build?", "Checks the Definition of Ready — and lists exactly what's missing."],
    ["Where would it be built?", "Names the likely services and what else the change would touch."],
    ["How critical?", "A value × effort × urgency hint. The team decides."],
    ["Does it belong to us?", "Ours, another team's, or unplaceable."],
    ["Can an agent fix it?", "Small, specified and testable → marked for the solver."],
  ];
  qs.forEach(([q, d], i) => {
    const x = 0.5 + (i % 2) * 4.05,
      y = 1.45 + Math.floor(i / 2) * 1.4,
      w = 3.85,
      h = 1.25;
    card(s, x, y, w, h, { fill: i === 5 ? C.okFill : C.soft, line: i === 5 ? C.ok : C.rule });
    s.addText(`${i + 1}`, {
      x: x + 0.15,
      y: y + 0.12,
      w: 0.4,
      h: 0.4,
      fontFace: FONT,
      fontSize: 20,
      bold: true,
      color: C.siren,
      margin: 0,
    });
    s.addText(
      [
        { text: q, options: { bold: true, fontSize: 15, color: C.navy, breakLine: true } },
        { text: d, options: { fontSize: 12, color: C.ink } },
      ],
      {
        x: x + 0.6,
        y: y + 0.08,
        w: w - 0.75,
        h: h - 0.16,
        fontFace: FONT,
        margin: 0,
        valign: "middle",
      },
    );
  });
  card(s, 8.75, 1.45, 4.08, 4.05, { fill: C.navy, line: C.navy });
  const stats = [
    ["every 5 min", "new tickets are picked up"],
    ["3–8 min", "to triage one ticket"],
    ["~$1.56", "per triage"],
  ];
  stats.forEach(([big, small], i) => {
    const y = 1.65 + i * 1.28;
    s.addText(big, {
      x: 9.0,
      y,
      w: 3.6,
      h: 0.65,
      fontFace: FONT,
      fontSize: 32,
      bold: true,
      color: C.white,
      margin: 0,
    });
    s.addText(small, {
      x: 9.0,
      y: y + 0.62,
      w: 3.6,
      h: 0.4,
      fontFace: FONT,
      fontSize: 13,
      color: "C9D6EA",
      margin: 0,
      valign: "top",
    });
  });
  callout(
    s,
    0.5,
    5.75,
    12.33,
    0.95,
    [
      {
        text: "The answer is posted back on the ticket — a comment and labels. ",
        options: { bold: true },
      },
      {
        text: "The AI only reads; code checks its verdict before anything is written.",
        options: { color: "DCE6F2" },
      },
    ],
    { size: 15 },
  );
}

// =====================================================================
// 4. Follow-up
// =====================================================================
{
  const s = content(
    "Capability 2 · Follow-up",
    "It follows up on tickets it sent back",
    "When triage finds a ticket nearly ready, it says exactly what's missing and starts watching it. " +
      "Every ten minutes it looks for a reply or an edit from someone other than itself. Only then does it spend anything: first a quick yes/no from the AI on whether the reply answers the question, and only if yes, a full re-triage. " +
      "It stops by itself when the ticket closes or after three re-checks. SSX-3834 is the real example: answered at 13:05, re-triaged to fixable at 13:11.",
  );
  s.addText(
    "When a ticket is nearly ready, the bot lists what's missing — then keeps an eye on it.",
    {
      x: 0.5,
      y: 1.3,
      w: 12.3,
      h: 0.4,
      fontFace: FONT,
      fontSize: 15,
      color: C.muted,
      margin: 0,
    },
  );
  const steps = [
    [
      "Did someone reply or edit?",
      "free",
      "harness",
      "Checked every 10 minutes. Only other people count — never the bot itself.",
    ],
    [
      "Does it answer what we asked?",
      "cents",
      "agent",
      "A quick yes/no from the AI. When it's unsure, the answer is no.",
    ],
    ["Full re-check", "dollars", "agent", "The ticket is triaged again, with the new information."],
    [
      "Ready to fix",
      "result",
      "ok",
      "If it passes, the ticket goes to the solver and the watch ends.",
    ],
  ];
  const tag = {
    free: [C.ok, "FREE"],
    cents: [C.human, "CENTS"],
    dollars: [C.bad, "DOLLARS"],
    result: [C.navy, "RESULT"],
  };
  steps.forEach(([t, cost, kind, d], i) => {
    const x = 0.5 + i * 3.16,
      w = 2.85,
      y = 1.9,
      h = 2.45;
    const k = KIND[kind];
    const [tc, tt] = tag[cost];
    s.addShape(pptx.ShapeType.roundRect, {
      x,
      y,
      w,
      h,
      rectRadius: 0.06,
      fill: { color: k.fill },
      line: { color: k.line, width: 1.5 },
    });
    s.addText(tt, {
      shape: pptx.ShapeType.roundRect,
      rectRadius: 0.1,
      x: x + 0.2,
      y: y + 0.2,
      w: 1.05,
      h: 0.32,
      fill: { color: tc },
      line: { color: tc, width: 0 },
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
      y: y + 0.65,
      w: w - 0.35,
      h: 0.65,
      fontFace: FONT,
      fontSize: 16,
      bold: true,
      color: k.title,
      margin: 0,
      valign: "top",
    });
    s.addText(d, {
      x: x + 0.2,
      y: y + 1.35,
      w: w - 0.35,
      h: 1.0,
      fontFace: FONT,
      fontSize: 13,
      color: C.ink,
      margin: 0,
      valign: "top",
    });
    if (i < 3) {
      arrow(s, x + w + 0.02, y + h / 2, x + 3.16 - 0.02, y + h / 2, { width: 2 });
    }
  });
  const notes = [
    ["Cheapest check first.", "Money is only spent once someone has actually answered."],
    ["Stops by itself.", "When the ticket closes, or after 3 re-checks."],
    ["Real example: SSX-3834.", "The reporter answered at 13:05; the bot re-checked it at 13:11."],
  ];
  notes.forEach(([b, t], i) => {
    const x = 0.5 + i * 4.18;
    card(s, x, 4.65, 3.95, 1.35);
    s.addText(
      [
        { text: b, options: { bold: true, color: C.navy, breakLine: true } },
        { text: t, options: { color: C.ink } },
      ],
      {
        x: x + 0.2,
        y: 4.72,
        w: 3.6,
        h: 1.21,
        fontFace: FONT,
        fontSize: 14,
        margin: 0,
        valign: "middle",
      },
    );
  });
  legend(s, 6.4);
}

// =====================================================================
// 5. Solving
// =====================================================================
{
  const s = content(
    "Capability 3 · Solving",
    "It fixes small, well-specified tickets",
    "The target is mundane work, whatever the issue type: the kind of ticket that's clear, small and testable. " +
      "A person gives the go-ahead with the agent:start label — or, in auto mode, allowed issue types go straight through. The bot claims the ticket and gets its own isolated copy of the repository. " +
      "Then three separate AI sessions: a read-only plan that can say no, the fix, and a fresh read that tidies it up. If the plan says no, nothing is ever written. The AI can edit files, but it cannot run anything.",
  );
  card(s, 0.5, 1.45, 4.6, 4.2);
  s.addText("The kind of work it takes on", {
    x: 0.75,
    y: 1.58,
    w: 4.1,
    h: 0.45,
    fontFace: FONT,
    fontSize: 17,
    bold: true,
    color: C.navy,
    margin: 0,
  });
  s.addText(
    bullets(
      [
        "A copy change",
        "A missing null check",
        "A renamed field",
        "A forgotten translation",
        "A unit test for an untested branch",
        "A config default",
      ],
      { gap: 6 },
    ),
    {
      x: 0.75,
      y: 2.1,
      w: 4.15,
      h: 2.65,
      fontFace: FONT,
      fontSize: 15,
      color: C.ink,
      valign: "top",
      margin: 0,
    },
  );
  s.addText("Small, specified and testable — whatever the issue type.", {
    x: 0.75,
    y: 4.85,
    w: 4.15,
    h: 0.65,
    fontFace: FONT,
    fontSize: 13,
    italic: true,
    color: C.muted,
    margin: 0,
    valign: "top",
  });

  const steps = [
    ["A person says go", "adds agent:start — or automatic for allowed issue types", "human"],
    [
      "Claim + its own copy of the repo",
      "labels the ticket, then cuts a fresh, isolated git worktree",
      "harness",
    ],
    ["Plan", "AI, read-only: find the cause, then decide go or no-go", "agent"],
    ["Fix", "AI makes the change the plan described", "agent"],
    ["Tidy up", "a fresh AI read of the change, to make it simpler", "agent"],
  ];
  steps.forEach(([t, d, k], i) => {
    const y = 1.45 + i * 0.86;
    node(s, 5.5, y, 7.33, 0.72, t, d, k, {
      titleSize: 14,
      subSize: 12,
      align: "left",
      margin: PAD,
    });
    if (i < steps.length - 1) {
      arrow(s, 9.17, y + 0.72, 9.17, y + 0.86);
    }
  });
  callout(
    s,
    0.5,
    5.9,
    12.33,
    0.85,
    [
      { text: "If the plan says no, nothing is ever written. ", options: { bold: true } },
      {
        text: "The AI can edit files — but it can't run commands, browse the web, or push code.",
        options: { color: "DCE6F2" },
      },
    ],
    { size: 15 },
  );
}

// =====================================================================
// 6. Verification
// =====================================================================
{
  const s = content(
    "Capability 4 · Checking",
    "It checks its own work — the AI never grades itself",
    "Everything here is plain code. It runs the repository's own tests, type check and lint — first on the untouched code, so a failure later means something — and only the exit codes count. " +
      "It reads the real change, not the AI's account of it, and some files are off-limits at any size: CI config, lockfiles, env files, test settings. A plan that names one of them stops before anything is written. " +
      "It also runs the new tests without the fix: if they still pass, they prove nothing, and the pull request says so. " +
      "Models do weigh in on quality — the tidy-up pass and Copilot's review — but pass or fail is only ever exit codes.",
  );
  const cards = [
    [
      "Runs the tests itself",
      "Tests, types and lint on the untouched code first, then on the fix. Only the exit codes count.",
    ],
    [
      "Stays in scope",
      "Reads the real change, not the AI's account of it. Never CI config, lockfiles, env files or test settings — at any size.",
    ],
    [
      "Catches tests that prove nothing",
      "Runs the new tests without the fix. If they still pass, the PR says so.",
    ],
    [
      "Stops with a reason",
      "If anything is off, the ticket gets agent:failed and the reason as a comment. Never a PR.",
    ],
  ];
  cards.forEach(([t, d], i) => {
    const x = 0.5 + (i % 2) * 6.28,
      y = 1.45 + Math.floor(i / 2) * 1.9,
      w = 6.05,
      h = 1.7;
    card(s, x, y, w, h, { fill: C.harnessFill, line: C.harness });
    s.addShape(pptx.ShapeType.rect, {
      x,
      y,
      w: 0.09,
      h,
      fill: { color: C.harness },
      line: { color: C.harness, width: 0 },
    });
    s.addText(
      [
        { text: t, options: { bold: true, fontSize: 18, color: C.harnessDark, breakLine: true } },
        { text: d, options: { fontSize: 14, color: C.ink } },
      ],
      {
        x: x + 0.3,
        y: y + 0.1,
        w: w - 0.5,
        h: h - 0.2,
        fontFace: FONT,
        margin: 0,
        valign: "middle",
      },
    );
  });
  callout(
    s,
    0.5,
    5.4,
    12.33,
    0.85,
    [
      { text: "The AI writes the code. ", options: { bold: true } },
      { text: "Plain code decides whether it passed.", options: { color: "DCE6F2" } },
    ],
    { size: 18 },
  );
  s.addText(
    "Models do weigh in on quality — the tidy-up pass and Copilot's review — but pass or fail is only ever exit codes.",
    {
      x: 0.5,
      y: 6.35,
      w: 12.33,
      h: 0.4,
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
// 7. Review
// =====================================================================
{
  const s = content(
    "Capability 5 · Review",
    "It opens the PR and works through the review",
    "The pull request opens as a draft and the bot asks GitHub's Copilot to review it. Every two minutes it checks for comments; when there are some, the AI fixes what needs fixing and answers each thread, and code pushes and posts the replies. " +
      "It keeps the branch up to date with its base and resolves conflicts. When there's nothing left to change, the PR leaves draft and a person takes over. " +
      "It is bounded: three rounds with Copilot, twenty in total per pull request.",
  );
  const y = 1.55,
    h = 1.1,
    w = 2.25;
  const xs = [0.45, 2.98, 5.51, 8.04, 10.57];
  const row = [
    ["Draft PR", "opened by code; Copilot asked to review", "harness"],
    ["Copilot reviews", "GitHub's AI reviewer leaves comments", "agent"],
    ["AI answers", "fixes, pushes, replies, resolves threads", "agent"],
    ["Ready for review", "nothing left to change → out of draft", "harness"],
    ["A person merges", "always", "human"],
  ];
  row.forEach(([t, d, k], i) => node(s, xs[i], y, w, h, t, d, k, { titleSize: 14, subSize: 11 }));
  for (let i = 0; i < 4; i++) {
    arrow(s, xs[i] + w, y + h / 2, xs[i + 1], y + h / 2);
  }
  path(
    s,
    [
      [xs[2] + w / 2, y + h],
      [xs[2] + w / 2, 3.0],
      [xs[1] + w / 2, 3.0],
      [xs[1] + w / 2, y + h],
    ],
    { color: C.agent },
  );
  label(s, xs[1] + w / 2, 3.03, xs[2] - xs[1], 0.3, "↻ every 2 minutes, until nothing is left", {
    size: 11,
    italic: true,
    color: C.agentDark,
  });

  card(s, 0.45, 3.55, 6.1, 3.15);
  s.addText("Along the way", {
    x: 0.7,
    y: 3.65,
    w: 5.6,
    h: 0.4,
    fontFace: FONT,
    fontSize: 16,
    bold: true,
    color: C.navy,
    margin: 0,
  });
  s.addText(
    bullets(
      [
        "Keeps up with the base branch — and resolves merge conflicts",
        "Only resolves a thread when it changed code or checked something",
        "A team member's comment can widen the scope; a bot's can't",
        "Limits: 3 rounds with Copilot, 20 in total per PR",
      ],
      { gap: 7 },
    ),
    {
      x: 0.7,
      y: 4.1,
      w: 5.7,
      h: 2.5,
      fontFace: FONT,
      fontSize: 14,
      color: C.ink,
      valign: "top",
      margin: 0,
    },
  );

  card(s, 6.83, 3.55, 6.0, 3.15, { fill: C.white });
  s.addText("SSX-3834, 6 September", {
    x: 7.08,
    y: 3.65,
    w: 5.5,
    h: 0.4,
    fontFace: FONT,
    fontSize: 16,
    bold: true,
    color: C.navy,
    margin: 0,
  });
  const tl = [
    ["13:21", "draft PR #2662 opened"],
    ["13:24", "Copilot: 2 comments — a real NaN bug"],
    ["13:28", "round 1: fixed, replied, both threads resolved"],
    ["13:30", "Copilot approves"],
    ["13:31", "round 2: nothing to change · ready for review"],
  ];
  tl.forEach(([t, e], i) => {
    const yy = 4.15 + i * 0.48;
    s.addText(t, {
      x: 7.08,
      y: yy,
      w: 0.8,
      h: 0.4,
      fontFace: MONO,
      fontSize: 13,
      bold: true,
      color: C.harnessDark,
      margin: 0,
      valign: "middle",
    });
    s.addText(e, {
      x: 7.9,
      y: yy,
      w: 4.85,
      h: 0.4,
      fontFace: FONT,
      fontSize: 13.5,
      color: C.ink,
      margin: 0,
      valign: "middle",
    });
  });
}

// =====================================================================
// 8. Slack
// =====================================================================
{
  const s = content(
    "Capability 6 · Audit trail",
    "It keeps a Slack thread for every ticket",
    "Each ticket the bot touches gets one Slack message that it keeps editing as the work moves: a status card, the events that decided the ticket's fate, and a timeline. Replies are left to people. " +
      "Which message belongs to which ticket is saved on the Jira ticket itself, so there's no separate database. " +
      "Slack is a reporting channel: if Slack or Jira has a hiccup, it's logged and the real work carries on. " +
      "The message on the slide is illustrative — the ticket and times are made up, the layout is what the bot draws.",
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
  label(s, mx, my + mh + 0.03, mw, 0.25, "illustrative ticket — the layout the bot draws", {
    size: 9,
    italic: true,
  });

  s.addText(
    bullets(
      [
        [
          { text: "One thread per ticket", bold: true },
          { text: " — the bot keeps editing the same message as the work moves." },
        ],
        [
          { text: "Status at a glance", bold: true },
          { text: " — triage, work, PR and state on one card." },
        ],
        [
          { text: "Key events and a full timeline", bold: true },
          { text: ", newest first. Replies are left to people." },
        ],
        [
          { text: "Its memory lives on the Jira ticket", bold: true },
          { text: " — which message, and what it shows. No extra database." },
        ],
        [
          { text: "Never gets in the way", bold: true },
          { text: " — if Slack or Jira hiccups, the real work carries on." },
        ],
        [{ text: "Three modes", bold: true }, { text: ": off · dry (writes to a file) · live." }],
      ],
      { gap: 12 },
    ),
    {
      x: 6.75,
      y: 1.5,
      w: 6.08,
      h: 5.1,
      fontFace: FONT,
      fontSize: 15,
      color: C.ink,
      valign: "top",
      margin: 0,
    },
  );
}

// =====================================================================
// 9. Who does what
// =====================================================================
{
  const s = content(
    "The split",
    "Who does what: AI, code, and people",
    "This is the one structural idea worth remembering. The AI makes judgements and writes text and code. Plain code decides when anything runs, limits what the AI can touch, runs the tests, and does everything with consequences — git, pull requests, labels, Slack. " +
      "People give the go-ahead, answer questions on tickets, and merge. Only the code has a shell; the AI never runs a command.",
  );
  const cols = [
    [
      "agent",
      "AI — judges and writes",
      [
        "Reads tickets and judges them",
        "Checks whether a reply answers the question",
        "Plans and writes the fix",
        "Answers review comments",
      ],
    ],
    [
      "harness",
      "Code — checks and acts",
      [
        "Decides when anything runs",
        "Limits what the AI can touch",
        "Runs the tests and reads the results",
        "Git, pull requests, labels, Slack",
        "Enforces limits and budgets",
      ],
    ],
    [
      "human",
      "People — decide",
      ["Say go (agent:start)", "Answer questions on tickets", "Review and merge"],
    ],
  ];
  cols.forEach(([kind, head, items], i) => {
    const k = KIND[kind];
    const x = 0.5 + i * 4.19,
      w = 3.95;
    s.addShape(pptx.ShapeType.roundRect, {
      x,
      y: 1.4,
      w,
      h: 3.95,
      rectRadius: 0.06,
      fill: { color: k.fill },
      line: { color: k.line, width: 1.5 },
    });
    s.addText(head, {
      x: x + 0.25,
      y: 1.52,
      w: w - 0.5,
      h: 0.6,
      fontFace: FONT,
      fontSize: 20,
      bold: true,
      color: k.title,
      margin: 0,
      valign: "middle",
    });
    s.addText(bullets(items, { gap: 14 }), {
      x: x + 0.25,
      y: 2.25,
      w: w - 0.45,
      h: 3.0,
      fontFace: FONT,
      fontSize: 17,
      color: C.ink,
      valign: "top",
      margin: 0,
    });
  });
  callout(
    s,
    0.5,
    5.65,
    12.33,
    0.95,
    [
      {
        text: "The AI suggests and writes. Code checks and acts. People decide.",
        options: { bold: true },
      },
    ],
    { size: 20 },
  );
}

// =====================================================================
// 10. Safety
// =====================================================================
{
  const s = content(
    "Safety",
    "Built to be safe by default",
    "Six things that hold regardless of what the AI decides. The first is the one no change has ever touched: there is no merge anywhere in the code. " +
      "The AI's tools are removed, not just discouraged — no shell, no web, no helpers. Each capability has its own switch and they start off. " +
      "And every piece of progress is a label on the ticket, so anyone can see where a ticket is — and it survives a restart.",
  );
  const cards = [
    ["A human merges. Always.", "There is no merge call anywhere in the code."],
    [
      "No shell, no internet",
      "The AI can read and edit files — it can't run commands, browse, or spawn helpers.",
    ],
    [
      "An isolated copy per fix",
      "Every fix happens in its own git worktree, never in the main checkout.",
    ],
    ["Off by default", "Solving, watching and Slack each have their own switch."],
    [
      "Spending limits",
      "At most 3 re-checks per ticket, 3 review rounds with Copilot, 20 in total.",
    ],
    ["State anyone can read", "Progress lives on the ticket as labels — it survives a restart."],
  ];
  cards.forEach(([t, d], i) => {
    const x = 0.5 + (i % 3) * 4.19,
      y = 1.45 + Math.floor(i / 3) * 2.45,
      w = 3.95,
      h = 2.2;
    card(s, x, y, w, h, {
      fill: i === 0 ? C.humanFill : C.white,
      line: i === 0 ? C.human : C.rule,
    });
    s.addShape(pptx.ShapeType.rect, {
      x,
      y,
      w: 0.09,
      h,
      fill: { color: C.siren },
      line: { color: C.siren, width: 0 },
    });
    s.addText(
      [
        { text: t, options: { bold: true, fontSize: 19, color: C.navy, breakLine: true } },
        { text: d, options: { fontSize: 14, color: C.ink } },
      ],
      {
        x: x + 0.3,
        y: y + 0.15,
        w: w - 0.5,
        h: h - 0.3,
        fontFace: FONT,
        margin: 0,
        valign: "middle",
      },
    );
  });
  s.addText(
    "Every refusal explains itself — the reason is posted on the ticket, or replied to whoever asked.",
    {
      x: 0.5,
      y: 6.35,
      w: 12.33,
      h: 0.4,
      fontFace: FONT,
      fontSize: 13,
      italic: true,
      color: C.muted,
      margin: 0,
      valign: "middle",
    },
  );
}

// =====================================================================
// 11. A real run
// =====================================================================
{
  const s = content(
    "A real run",
    "SSX-3834: the first ticket to go all the way",
    "6 September 2026. The ticket was sent back with three blockers, the reporter answered, the watch picked it up six minutes later and re-triaged it as fixable. " +
      "A person added the go-ahead label; five and a half minutes after the claim there was a draft pull request. Copilot found a real NaN regression, the bot fixed it in one round, Copilot approved, and the PR left draft. " +
      "A person typed exactly two things on that ticket: one reply and one label.",
  );
  const rows = [
    ["12:52", "Ticket created", false],
    ["12:55", "Grooming picks it up · triage runs", false],
    ["12:59", "Sent back — 3 blockers listed · watched", false],
    ["13:05", "👤  The reporter answers in a comment", true],
    ["13:11", "The watch sees the reply · re-triaged · fixable", false],
    ["13:15", "👤  A person adds agent:start", true],
    ["13:16", "Claimed · isolated worktree cut", false],
    ["13:21", "Draft PR #2662 opened", false],
    ["13:24", "Copilot: 2 comments — a real NaN regression", false],
    ["13:28", "Round 1: fixed, replied, both threads resolved", false],
    ["13:30", "Copilot approves", false],
    ["13:31", "Round 2: nothing to change · ready for review", false],
  ];
  const cellOpts = (human) =>
    human ? { fill: { color: C.humanFill }, bold: true } : { fill: { color: C.white } };
  s.addTable(
    rows.map(([t, e, human]) => [
      {
        text: t,
        options: { ...cellOpts(human), fontFace: MONO, bold: true, color: C.harnessDark },
      },
      { text: e, options: cellOpts(human) },
    ]),
    {
      x: 0.5,
      y: 1.4,
      w: 8.1,
      colW: [1.1, 7.0],
      fontFace: FONT,
      fontSize: 13,
      color: C.ink,
      border: { type: "solid", pt: 0.75, color: C.rule },
      rowH: 0.42,
      valign: "middle",
      margin: 5,
    },
  );
  card(s, 8.95, 1.4, 3.88, 5.04, { fill: C.navy, line: C.navy });
  const stats = [
    ["39 min", "from new ticket to ready for review"],
    ["5 min 36 s", "from claim to draft pull request"],
    ["2", "things a person typed: one reply, one label"],
  ];
  stats.forEach(([big, small], i) => {
    const y = 1.6 + i * 1.6;
    s.addText(big, {
      x: 9.2,
      y,
      w: 3.45,
      h: 0.7,
      fontFace: FONT,
      fontSize: 34,
      bold: true,
      color: C.white,
      margin: 0,
    });
    s.addText(small, {
      x: 9.2,
      y: y + 0.68,
      w: 3.45,
      h: 0.7,
      fontFace: FONT,
      fontSize: 13.5,
      color: "C9D6EA",
      margin: 0,
      valign: "top",
    });
  });
}

// =====================================================================
// 12. How it's built
// =====================================================================
{
  const s = content(
    "How it's built",
    "Built with a coding agent, under rules that learn",
    "The bot is itself built with a coding agent, and that agent works under a written contract split into four phases — it loads the rules for the phase it's in. " +
      "None of the rules came from theory. Each one generalises a mistake that actually got through: the postmortem asks what really went wrong, the incident is logged — 64 so far — and the rule is amended and enforced by hooks and CI, so nobody has to remember it. " +
      "The same caution applies to new abilities: built but switched off, then a dry run, then one ticket by hand, and only then the loop.",
  );
  s.addText("A working contract, split by phase", {
    x: 0.5,
    y: 1.4,
    w: 5.6,
    h: 0.45,
    fontFace: FONT,
    fontSize: 16,
    bold: true,
    color: C.navy,
    margin: 0,
  });
  const phases = [
    ["Starting", "plan first, in writing, on its own branch"],
    ["Building", "writing or deleting code"],
    ["Proving", "tests, guards — and running the real thing"],
    ["Finishing", "four questions before every commit"],
  ];
  phases.forEach(([t, d], i) => {
    const y = 1.95 + i * 0.9;
    node(s, 0.5, y, 5.6, 0.75, t, d, "harness", {
      titleSize: 15,
      subSize: 12,
      align: "left",
      margin: PAD,
    });
    if (i < phases.length - 1) {
      arrow(s, 3.3, y + 0.75, 3.3, y + 0.9);
    }
  });

  const Wn = 2.1,
    Hn = 0.95;
  const N = [
    [9.7, 1.9, "Something slips through", "a bug, a wasted run, a rule that didn't help", "bad"],
    [11.75, 3.45, "Postmortem", "what actually went wrong?", "neutral"],
    [9.7, 5.0, "Logged", "INCIDENTS.md — 64 entries so far", "neutral"],
    [7.65, 3.45, "A new rule", "enforced by hooks and CI", "harness"],
  ];
  N.forEach(([cx, cy, t, d, k]) =>
    node(s, cx - Wn / 2, cy - Hn / 2, Wn, Hn, t, d, k, { titleSize: 13, subSize: 10.5 }),
  );
  const col = { color: C.siren, width: 2.25 };
  arrow(s, 10.75, 2.2, 11.4, 2.95, col);
  arrow(s, 11.4, 3.95, 10.75, 4.7, col);
  arrow(s, 8.65, 4.7, 8.0, 3.95, col);
  arrow(s, 8.0, 2.95, 8.65, 2.2, col);
  s.addText("Every rule traces back to a real mistake", {
    x: 8.75,
    y: 3.05,
    w: 1.9,
    h: 0.8,
    fontFace: FONT,
    fontSize: 13,
    bold: true,
    color: C.navy,
    align: "center",
    valign: "middle",
    margin: 0,
  });

  callout(
    s,
    0.5,
    5.95,
    12.33,
    0.8,
    [
      { text: "New abilities are earned step by step: ", options: { bold: true } },
      {
        text: "built but switched off → dry run → one ticket, by hand → the loop.",
        options: { color: "DCE6F2" },
      },
    ],
    { size: 15 },
  );
}

// =====================================================================
// 13. Live demo
// =====================================================================
{
  const s = content(
    "Live demo",
    "What I'll show",
    "Everything here is safe to run live. Only the triage of one ticket spends real money (~$1.56), and it posts nothing unless --write is added. " +
      "Before the demo, check SLACK_MODE: with live, triage and the daemon post to the Slack channel — set it to off or dry unless you want that on screen. " +
      "Pick the demo tickets in advance, including one that is being watched for step 4. Delete this slide if you'd rather demo freely.",
  );
  const rows = [
    ["What would it triage right now?", "pnpm poll:once --dry-run"],
    [
      "Triage one ticket, live — without posting",
      "pnpm triage:once SSX-1234 --skill intake-triage",
    ],
    ["What would the solver pick up?", "SOLVE_ENABLED=true pnpm solve:once"],
    ["What would the follow-up do with a sent-back ticket?", "pnpm watch:once SSX-1234"],
    ["Draw a ticket's Slack thread", "pnpm slack:once SSX-1234"],
  ];
  rows.forEach(([what, cmd], i) => {
    const y = 1.5 + i * 1.0;
    s.addText(`${i + 1}`, {
      shape: pptx.ShapeType.ellipse,
      x: 0.5,
      y: y + 0.13,
      w: 0.5,
      h: 0.5,
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
    s.addText(what, {
      x: 1.2,
      y,
      w: 5.6,
      h: 0.76,
      fontFace: FONT,
      fontSize: 17,
      bold: true,
      color: C.navy,
      margin: 0,
      valign: "middle",
    });
    s.addText(cmd, {
      shape: pptx.ShapeType.rect,
      x: 7.0,
      y,
      w: 5.83,
      h: 0.76,
      fill: { color: C.navy },
      line: { color: C.navy, width: 0 },
      fontFace: MONO,
      fontSize: 13,
      color: C.sky,
      margin: PAD,
      valign: "middle",
    });
  });
}

// =====================================================================
// 14. Close
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
    ["It does the busywork. ", "Grooms every ticket, follows up, and fixes the small ones."],
    ["It doesn't trust itself. ", "Plain code checks every piece of AI work."],
    ["It earns trust step by step. ", "Dry run, one ticket by hand, then the loop."],
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
        fontSize: 24,
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
    "Close on the one guarantee: the bot has no merge path. Likely questions: cost per ticket (a triage is ~$1.56; cost per day under the unattended loop hasn't been measured yet), " +
      "and what happens when it gets something wrong (agent:failed with the reason on the ticket, or a pull request a person declines).",
  );
}

await write("the-jira-police-demo.simple.pptx");
