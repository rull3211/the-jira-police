// Norwegian (bokmål) twin of full.en.mjs: same layout, translated prose. Commands, labels and file names stay as in the code.
import { C, FONT, KIND, MONO, PAD, createDeck } from "./deck.mjs";

const { pptx, content, node, arrow, path, label, legend, bullets, card, callout, section, write } =
  createDeck({
    id: "full.no",
    title: "the-jira-police — demo (norsk)",
    footer: "the-jira-police  ·  demo 29.09.2026",
    legendItems: [
      ["harness", "Harness — deterministisk Node-kode"],
      ["agent", "Agent — en modellsesjon"],
      ["human", "Menneske"],
    ],
    partLabel: "DEL",
  });

// =====================================================================
// 1. Tittel
// =====================================================================
{
  const s = pptx.addSlide({ masterName: "DARK" });
  s.addText("DEMO  ·  29. SEPTEMBER 2026", {
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
  s.addText("En agent som vurderer hver nye Jira-sak — og fikser dem den trygt kan fikse", {
    x: 0.8,
    y: 2.95,
    w: 11.5,
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
      { text: "Del 1   ", options: { bold: true, color: C.white } },
      {
        text: "Hva boten gjør — vaktene, løseren, review-runder, scope guard, Slack-revisjon",
        options: { color: "C9D6EA", breakLine: true },
      },
      { text: "Del 2   ", options: { bold: true, color: C.white, paraSpaceBefore: 6 } },
      {
        text: "Hvordan utviklingen er instruert — faser, arkitektur, hendelser",
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
    "To deler. Først hva boten faktisk gjør, fra start til slutt, og hvor grensen går mellom deterministisk kode og modellsesjoner. " +
      "Deretter hvordan agenten som bygger boten er instruert: fasefilene, arkitekturdokumentene og hendelsesloggen som stadig endrer reglene.",
  );
}

// =====================================================================
// 2. Kort fortalt
// =====================================================================
{
  const s = content(
    "Hva det er",
    "Én tavle, tre løkker — og et menneske merger alltid",
    "Kortversjonen. Grooming har vært i produksjon lengst; løseløkken er den nyeste og har mest privilegier. " +
      "SSX-3834 den 6. september var den første saken som gikk hele veien: sendt tilbake, besvart, triagert på nytt, claimet, fikset, reviewet av Copilot og tatt ut av draft. " +
      "Et menneske skrev to ting på den saken: ett svar og én label. Det finnes ikke ett eneste merge-kall i kodebasen — den ene garantien ingen endring har rørt.",
  );
  const cards = [
    [
      "1",
      "Grooming",
      "Hver nye SSX-sak innenfor scope kjøres gjennom Storebrands /intake-triage-skill. Vurderingen sjekkes mekanisk og postes tilbake som kommentar og labels.",
    ],
    [
      "2",
      "Sendback-vakten",
      "Saker som sendes tilbake som nesten løsbare, følges med på. Når noen andre svarer, sjekker boten at svaret er relevant, og triagerer på nytt.",
    ],
    [
      "3",
      "Løs og review",
      "Saker merket agent:solvable blir claimet, fikset i en isolert git-worktree, verifisert av harnessen, åpnet som draft-PR og fulgt gjennom review.",
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
        text: "Med SLACK_MODE på får hver sak én Slack-tråd som boten oppdaterer etter hvert som arbeidet går.",
        options: { color: C.ink },
      },
    ],
    { x: 0.5, y: 5.95, w: 7.7, h: 0.6, fontFace: FONT, fontSize: 13, margin: 0, valign: "middle" },
  );

  card(s, 8.6, 1.45, 4.23, 5.05, { fill: C.navy, line: C.navy });
  const stats = [
    ["5 min 36 s", "fra claim til draft-PR på SSX-3834, den første saken gjennom hele kjeden"],
    ["2", "steder der et menneske må inn: go-ahead-labelen (manuell modus) og mergen"],
    ["0", "merge-kall noe sted i kodebasen"],
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
// 3. Del 1
// =====================================================================
section(
  1,
  "Hva boten gjør",
  "Fra ny sak til en pull request et menneske merger",
  [
    "Tre løkker, og hvem som gjør hva: harness eller agent",
    "Vakten — ny triage bare når noen faktisk har svart",
    "Løseren — seks agent-arbeidsflyter, hver i sin egen sesjon",
    "Verifisering og scope guard — hva en kjøring får røre",
    "Review-runder, og Slack-tråden med tilstanden lagret på saken",
  ],
  "Ha ett spørsmål i bakhodet gjennom del 1: er dette steget en modell som gjør en vurdering, eller vanlig kode som sjekker noe? Fargekodingen i diagrammene svarer: blått er harnessen, lilla er en modellsesjon, gult er et menneske.",
);

// =====================================================================
// 4. Tre løkker
// =====================================================================
{
  const s = content(
    "Kjøretiden",
    "Tre løkker, hver med egen klokke og egen feilisolasjon",
    "Daemonen venter på tre runLoop-er i én Promise.all. De er separate løkker og ikke steg i ett tick fordi én triage kan ta opptil tjue minutter; " +
      "å dele tick ville i det stille gjort en timeout om til en review-policy. Hver løkke har egen backoff, så en review-sweep som kaster hvert tick, backer av review-siden og ingenting annet. " +
      "To-minutters review-kadensen er målt, ikke smak: hver Copilot-review på #2658 kom to og et halvt til fire minutter etter forespørselen. " +
      "Vakten er satt til seks timer som standard; vi kjører den hvert tiende minutt (WATCH_POLL_MS i .env). En sweep koster én Jira-lesing per overvåket sak, og den betalte relevanssjekken kjører bare ved ny aktivitet, så den kortere klokka kjøper stort sett et raskere svar.",
  );
  const cols = [
    {
      h: "1  Grooming",
      rows: [
        ["Kadens", "hvert 5. minutt"],
        ["Bryter", "alltid på"],
        ["Modul", "poller.ts"],
        ["Et tick kan bruke", "én analytiker + én poster per ny sak (~$1,56)"],
        ["Hvorfor denne klokka", "nye saker er et vindu over tid"],
      ],
    },
    {
      h: "2  Sendback-vakten",
      rows: [
        ["Kadens", "hver 6. time (standard) · vi: 10 min"],
        ["Bryter", "WATCH_ENABLED"],
        ["Modul", "watch-loop.ts"],
        ["Et tick kan bruke", "én ny triage per sak noen andre har endret"],
        ["Hvorfor denne klokka", "et menneske leser, går, og kommer tilbake — dager"],
      ],
    },
    {
      h: "3  Review, så claim",
      rows: [
        ["Kadens", "hvert 2. minutt"],
        ["Bryter", "SOLVE_ENABLED"],
        ["Modul", "review-loop.ts"],
        ["Et tick kan bruke", "review-runder — så en hel claim → løs → PR"],
        ["Hvorfor denne klokka", "Copilot svarer 2½–4 min etter en forespørsel"],
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
      { text: "Separate løkker, ikke steg i ett tick. ", options: { bold: true } },
      {
        text: "En triage kan ta 20 minutter; å dele tick ville bundet review-kadensen til den. En review-runde som kaster, backer av bare review-siden — grooming stopper aldri.",
        options: { color: "DCE6F2" },
      },
    ],
    { size: 14 },
  );
}

// =====================================================================
// 5. Hele flyten
// =====================================================================
{
  const s = content(
    "Hele flyten",
    "Fra ny sak til merget pull request",
    "Les det som en slange: triage på øverste rad, løsingen på midtraden fra høyre mot venstre, review på nederste rad. " +
      "De gule boksene er de eneste stedene et menneske må inn. I auto-modus hoppes go-ahead over for sakstypene i SOLVE_AUTO_ISSUE_TYPES (standard: Feil). " +
      "Enhver avvisning underveis — rød base, recon som avslår, feilet verifisering — ender i agent:failed med årsaken postet på saken, og aldri i en pull request.",
  );
  const R1 = 1.6,
    H1 = 0.95;
  node(s, 0.45, R1, 1.55, H1, "Ny sak", "SSX-tavla", "neutral");
  node(s, 2.35, R1, 2.25, H1, "Triage", "/intake-triage · 3–8 min", "agent");
  node(s, 4.95, R1, 1.95, H1, "Gate", "vurdering + agent-egnethet", "harness");
  arrow(s, 2.0, R1 + H1 / 2, 2.35, R1 + H1 / 2);
  arrow(s, 4.6, R1 + H1 / 2, 4.95, R1 + H1 / 2);
  const oy = [1.38, 1.9, 2.42];
  node(s, 7.3, oy[0], 2.45, 0.44, "agent:solvable", null, "ok", { titleSize: 11.5 });
  node(s, 7.3, oy[1], 2.45, 0.44, "agent:watching → vakten", null, "harness", { titleSize: 11 });
  node(s, 7.3, oy[2], 2.45, 0.44, "vurdering postet · ingen agent", null, "neutral", {
    titleSize: 10.5,
  });
  for (const y of oy) {
    arrow(s, 6.9, R1 + H1 / 2, 7.3, y + 0.22);
  }
  node(s, 10.9, 1.29, 1.95, 0.62, "Go-ahead", "et menneske legger til agent:start", "human", {
    titleSize: 12,
    subSize: 9,
  });
  arrow(s, 9.75, oy[0] + 0.22, 10.9, oy[0] + 0.22);
  label(s, 9.85, 2.1, 1.9, 0.6, "auto-modus hopper over dette for tillatte sakstyper", {
    size: 9,
    italic: true,
    align: "right",
  });

  const R2 = 3.1,
    H2 = 0.95,
    w2 = 1.95;
  const xs = [10.9, 8.3, 5.7, 3.1, 0.5];
  node(s, xs[0], R2, w2, H2, "Claim", "skriver agent:solving først", "harness");
  node(s, xs[1], R2, w2, H2, "Worktree", "basen må være grønn", "harness");
  node(s, xs[2], R2, w2, H2, "Recon", "kun lesing · gå eller avslå", "agent");
  node(s, xs[3], R2, w2, H2, "Fix → Simplify", "redigerer filer · ingen shell", "agent");
  node(s, xs[4], R2, w2, H2, "Verify + diff gate", "exit-koder, ekte diff", "harness");
  arrow(s, xs[0] + w2 / 2, 1.91, xs[0] + w2 / 2, R2);
  for (let i = 0; i < 4; i++) {
    arrow(s, xs[i], R2 + H2 / 2, xs[i + 1] + w2, R2 + H2 / 2);
  }

  s.addText(
    [
      { text: "✕  ", options: { bold: true } },
      { text: "rød base · recon avslår · verifisering feiler  →  " },
      { text: "agent:failed", options: { bold: true } },
      { text: ", årsaken postes på saken — aldri en PR" },
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
  node(s, x3[0], R3, w3, H3, "Draft-PR", "@copilot · agent:reviewing", "harness");
  node(s, x3[1], R3, w3, H3, "Review-runder", "fiks · push · svar · løs", "agent");
  node(s, x3[2], R3, w3, H3, "Undraft", "agent:review-done", "harness");
  node(s, x3[3], R3, w3, H3, "Review og merge", "et menneske", "human");
  node(s, x3[4], R3, w3, H3, "agent:done", "betyr merget", "ok");
  arrow(s, 1.5, R2 + H2, 1.5, R3);
  for (let i = 0; i < 4; i++) {
    arrow(s, x3[i] + w3, R3 + H3 / 2, x3[i + 1], R3 + H3 / 2);
  }
  label(s, x3[1], R3 + H3 + 0.03, w3, 0.3, "↻ hvert 2. min til ingenting gjenstår", {
    size: 9.5,
    italic: true,
  });

  legend(s, 6.55);
}

// =====================================================================
// 6. Harness mot agenter
// =====================================================================
{
  const s = content(
    "Fordelingen",
    "Hvem gjør hva: harness som sjekker, agenter som vurderer",
    "Dette er det viktigste strukturelle faktumet om boten. Bare én av de to aktørene har shell. " +
      "Modeller gjør vurderinger — er saken klar, svarte rapportøren, hva er fiksen — og harnessen gjør alt som kan sjekkes mekanisk, inkludert å rette modellens arbeid etter exit-koder. " +
      "Credentials følger samme skille: REST-credentialen for oppdagelse og labels kommer aldri inn i en modells miljø; kommentarer skrives av triage-posteren via Atlassian MCP-sesjonen, som en ekte Jira-bruker.",
  );
  const colW = 6.0;
  const cols = [
    {
      x: 0.5,
      kind: "harness",
      head: "Harness — vanlig Node-kode, ingen meninger",
      gap: 7,
      items: [
        "Finner nye saker via Jira REST og holder pekeren",
        "Gater hver vurdering før den postes — ~0 ms",
        "Claimer, labeler, teller forsøk, håndhever kapasitet",
        "Lager worktree; kjører git, gh og alle sjekkene",
        "Leser exit-koder: passed · failed · refused",
        "Diff gate, escape-sjekk, widening-sjekk",
        "Committer, pusher, åpner draft-PR, poster svarene",
        "Tegner Slack-tråden og lagrer posten på saken",
      ],
    },
    {
      x: 6.83,
      kind: "agent",
      head: "Agenter — modellsesjoner, ingen shell",
      gap: 14,
      items: [
        [
          { text: "Triage-analytiker", bold: true },
          { text: " — kjører /intake-triage: vurdering + agent-egnethet" },
        ],
        [
          { text: "Triage-poster", bold: true },
          { text: " — en ny sesjon med den ferdige teksten; skriver den til Jira" },
        ],
        [
          { text: "Relevanssjekk", bold: true },
          { text: " — ingen verktøy: svarte de på det vi spurte om?" },
        ],
        [
          { text: "Recon", bold: true },
          { text: " — kun lesing: gå videre med en plan, eller avslå" },
        ],
        [
          { text: "Fix · Simplify · Review · Merge · Repair", bold: true },
          { text: " — redigerer filer, kjører aldri noe" },
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
      fontSize: 14.5,
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
      { text: "Bare én av de to har shell. ", options: { bold: true } },
      { text: "Modellen blir aldri spurt om testene passerte.", options: { color: "DCE6F2" } },
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
      { text: "To credentials, aldri byttet om. ", options: { bold: true } },
      {
        text: "REST (harness) for oppdagelse og labels; MCP-sesjonen (agent) for kommentarer. Triage får aldri JIRA_* i miljøet sitt.",
        options: { color: "DCE6F2" },
      },
    ],
    { size: 12 },
  );
}

// =====================================================================
// 7. Vakten
// =====================================================================
{
  const s = content(
    "Vakter",
    "Sendback-vakten: ny triage bare når noen har svart",
    "Når triage sender en sak tilbake, men vurderer den som nesten løsbar, får den labelen agent:watching, og kommentaren lister blokkerne. " +
      "Vakten bruker penger uten at noen har bedt om det, så hvert steg er ordnet billigst først: en gratis sjekk av hvem som rørte saken, en relevanssjekk til noen øre, og først da triagen til noen dollar. " +
      "Telleren er en reservasjon skrevet før kjøringen, aldri en kvittering etterpå — en kvittering som feiler, ville gitt en gratis kjøring hver runde. " +
      "På SSX-3834 svarte rapportøren 13:05, og vakten triagerte den på nytt til agent:solvable 13:11.",
  );
  s.addText(
    "Triage sender en nesten løsbar sak tilbake med agent:watching og en kommentar som lister blokkerne. Så:",
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
      "Har noen andre rørt saken?",
      "free",
      "harness",
      "Siden triage-kommentaren vår: noen andres kommentar, eller en endring i beskrivelse · sammendrag · vedlegg · miljø.",
    ],
    [
      "Svarte de på det vi spurte om?",
      "cents",
      "agent",
      "En relevanssjekk uten verktøy. Feiler lukket: et feil nei bare venter — et feil ja koster en triage til $2.",
    ],
    [
      "Reserver den nye triagen",
      "free",
      "harness",
      "Telleren er en label, skrevet før kjøringen. Feiler den skrivingen, blir det ingen kjøring.",
    ],
    [
      "Ny triage",
      "dollars",
      "agent",
      "En full /intake-triage. Går den gjennom, blir saken agent:solvable og vakten avsluttes.",
    ],
  ];
  const tagColor = { free: C.ok, cents: C.human, dollars: C.bad };
  const tagText = { free: "GRATIS", cents: "ØRE", dollars: "KRONER" };
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
    s.addText(tagText[cost], {
      shape: pptx.ShapeType.roundRect,
      rectRadius: 0.1,
      x: x + 0.2,
      y: y + 0.2,
      w: 1.1,
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
      "Nøkkelen er botens footer, ikke forfatteren.",
      "Posteren deler et menneskes Atlassian-konto, og vår egen kommentar oppdaterer sakens endringstid — så «endret siden» ville trigget på seg selv.",
    ],
    [
      "Et betalt «nei» huskes.",
      "Avslått aktivitet memoiseres, så samme kommentar vurderes aldri to ganger.",
    ],
    [
      "Den avslutter seg selv.",
      "Saken lukkes, 3 nye triager er brukt, eller det finnes ingenting å måle fra.",
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
// 8. Tilstand
// =====================================================================
{
  const s = content(
    "Tilstand",
    "Tilstanden bor på saken, der et menneske kan lese den",
    "Ingen løse-tilstand ligger på disk. Claimen er én enkelt label-endring, agent:solving, skrevet før noe arbeid starter — det er det som gjør køen idempotent på tvers av omstarter. " +
      "agent:reviewing erstatter den, så en pull request som venter i dagevis på et menneske, ikke holder den eneste samtidighetsplassen. " +
      "En kjøring som slippes uten vurdering — en laptop som sovnet, en forbigående feil — legger labelene tilbake nøyaktig slik den fant dem, i stedet for å skrive agent:failed. " +
      "Ærlig forbehold: det finnes ingen compare-and-swap, så en ekstra instans kan fortsatt kappløpe om en claim mellom gjenlesingen og skrivingen.",
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
  node(s, ...P.watching, W, H, "agent:watching", "til ny triage går gjennom", "harness", o);
  node(s, ...P.solvable, W, H, "agent:solvable", "triage sier fiksbar", "ok", o);
  node(s, ...P.start, W, H, "agent:start", "et menneske · manuell modus", "human", o);
  node(s, ...P.solving, W, H, "agent:solving", "claimen", "harness", o);
  node(s, ...P.failed, W, H, "agent:failed", "en vurdering, ingen PR", "bad", o);
  node(s, ...P.reviewing, W, H, "agent:reviewing", "draft-PR åpen", "harness", o);
  node(s, ...P.reviewDone, W, H, "agent:review-done", "ute av draft", "harness", o);
  node(s, ...P.done, W, H, "agent:done", "merget", "ok", o);
  node(s, ...P.closed, W, H, "agent:closed", "lukket umerget", "neutral", o);
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
      "Labels på saken",
      "agent:* er tilstandsmaskinen. agent:solving skrives før noe arbeid — den ene endringen er claimen.",
    ],
    [
      "Property på saken",
      "jira-police.slack — hvilken Slack-melding som er sakens tråd, og posten den viser.",
    ],
    [
      "Markørkommentar på PR-en",
      "Review-pekeren og rundene som er brukt, reservert før hver runde.",
    ],
    ["Lokal disk", "Bare groomingens peker: state/poll.json."],
  ];
  s.addText("Hvor hver del av tilstanden bor", {
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
        text: "Overlever omstart, en slettet state/ og en ekstra instans. ",
        options: { bold: true },
      },
      { text: "agent:done betyr merget.", options: { color: "DCE6F2" } },
    ],
    { size: 12 },
  );
}

// =====================================================================
// 9. Seks pass
// =====================================================================
{
  const s = content(
    "Løseren",
    "Seks agent-arbeidsflyter — hver i sin egen sesjon",
    "Hver rad er et separat storecode-kall av agent-solve-skillen, ikke en tur i én samtale. " +
      "Recon kjører først, og vurderingen respekteres: avslår den, får ingen modell noen gang skrivetilgang for den saken. " +
      "Simplify ser bevisst ikke recon-planen — å gi den planen ville invitere den til å revurdere endringen i stedet for hvordan den er skrevet. " +
      "Repair finnes bare etter en feilet verifisering, og resultatet kastes med mindre kjøringen er armert med --repair, eller REPAIR_PUBLISH for daemonen.",
  );
  const hdr = (t) => ({
    text: t,
    options: { bold: true, color: C.white, fill: { color: C.agentDark } },
  });
  const pass = (t) => ({ text: t, options: { bold: true, color: C.agentDark, fontFace: MONO } });
  const rows = [
    [hdr("Pass"), hdr("Verktøy"), hdr("Får, i tillegg til saken"), hdr("Jobben")],
    [
      pass("recon"),
      "Read · Grep · Glob — kun lesing",
      "ingenting annet",
      "Stemmer triagens dev-vurdering? Gå videre med en plan, eller avslå — da får ingenting skrivetilgang",
    ],
    [
      pass("fix"),
      "…pluss Edit · Write",
      "recon-vurderingen",
      "Implementer briefen; endringen vurderes mot den",
    ],
    [
      pass("simplify"),
      "fix sine verktøy + Skill (/simplify)",
      "diffen — ikke recon-vurderingen",
      "Forbedre hvordan endringen er skrevet, ikke hva den gjør",
    ],
    [
      pass("review"),
      "fix sine verktøy",
      "reviewerens kommentarer",
      "Én runde per bunke tilbakemeldinger: fiks, og svar på hver tråd",
    ],
    [
      pass("merge"),
      "fix sine verktøy",
      "de konfliktende stiene — ikke reviewen",
      "Ta inn en base som har flyttet seg; aldri -X ours / theirs",
    ],
    [
      pass("repair"),
      "fix sine verktøy",
      "harnessens fangede feilutskrift",
      "Bare etter feilet verifisering; beholdes bare når armert",
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
    5.4,
    6.0,
    1.3,
    [
      { text: "Nektet i hvert pass: ", options: { bold: true } },
      {
        text: "Bash · Task · WebFetch · WebSearch — og ingen MCP-server i det hele tatt. Ingen git, ingen testkjøring, intet nettverk, ingen sub-agenter.",
        options: { color: "E6DEF7" },
      },
    ],
    { size: 13, fill: C.agentDark },
  );
  callout(
    s,
    6.83,
    5.4,
    6.0,
    1.3,
    [
      { text: "Separate sesjoner, ikke én samtale: ", options: { bold: true } },
      {
        text: "et pass kan ikke ta med seg en kapabilitet forbi punktet den ble gitt for, og et pass som dør, etterlater ikke det neste med en halv samtale.",
        options: { color: "DCE6F2" },
      },
    ],
    { size: 13 },
  );
}

// =====================================================================
// 10. Verifisering
// =====================================================================
{
  const s = content(
    "Verifisering",
    "Harnessen avgjør om det virker — ingen modell spørres",
    "«Virket det?» er det ene spørsmålet den som blir vurdert, ikke skal svare på selv. " +
      "Kvalitet er et annet spørsmål, og der har modeller en stemme: simplify-passet leser diffen med friske øyne, boten ber om en Copilot-review, og review-rundene svarer på den. Men bestått eller ikke er alltid bare exit-koder. " +
      "Kommandoene hentes fra basens manifest med git show, aldri fra worktreen — og det alene er ikke nok, fordi pakkebehandleren leser det som ligger på disk. " +
      "Derfor nekter verifiseringen også å kjøre med mindre filene som definerer bestått, er byte-identiske med basen. " +
      "Fail-first-proben kjører de nye testene mot den urørte basen: grønt der betyr at testen ikke beviser noe, og PR-teksten sier det. Den rapporterer; den blokkerer aldri en god fiks.",
  );
  const steps = [
    [
      1.4,
      1.2,
      "Basesjekk",
      "harness",
      "Før noe pass: install · typer · lint · test på den urørte basen. Rød → ingen kjøring: «failed» betyr bare noe mot en base som passerer.",
    ],
    [2.85, 0.78, "Passene", "agent", "recon → fix → simplify"],
    [
      3.88,
      1.05,
      "Verify",
      "harness",
      "De samme stegene på worktreen. Kommandoene hentes fra basens manifest, aldri fra worktreen.",
    ],
    [
      5.18,
      1.05,
      "Fail-first-probe",
      "harness",
      "Kjøringens nye tester på den urørte basen, uten fiksen. Grønt der = testen beviser ingenting. Neste slide.",
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
      [H("Utfall"), H("Betyr"), H("Eksempel")],
      [
        { text: "passed", options: { bold: true, color: C.ok, fontFace: MONO } },
        "hvert steg kjørte og passerte",
        "det eneste utfallet som kan bli en PR",
      ],
      [
        { text: "failed", options: { bold: true, color: C.bad, fontFace: MONO } },
        "et steg kjørte og passerte ikke — et faktum om koden",
        "tester røde; et steg fikk timeout",
      ],
      [
        { text: "refused", options: { bold: true, color: C.human, fontFace: MONO } },
        "ingen vurdering ble nådd i det hele tatt",
        "manifest endret; install døde; git feilet",
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
      { text: "refused rapporteres aldri som failed. ", options: { bold: true } },
      {
        text: "En ødelagt harness skal ikke se ut som en ødelagt fiks.",
        options: { color: "DCE6F2" },
      },
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
      { text: "Ingen retter sin egen eksamen: ", options: { bold: true, color: C.navy } },
      {
        text: "verifisering kjører ikke med mindre filene som definerer bestått, er byte-identiske med basen.",
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
    "Verifisering",
    "Fail-first: ta bort fiksen — merker testen det?",
    "Husregelen bak dette: en guard sendes ikke før den feiler når den kobles fra. Proben bruker den på testene solveren skriver. " +
      "Den kjører etter at verifiseringen har passert. Fiksen i kjøringens worktree er verifisert, men ikke committet, så den rulles aldri tilbake: harnessen lager en egen, frakoblet checkout av basen, kopierer bare kjøringens testfiler dit, installerer og kjører basens egen testkommando. " +
      "Basen ble sjekket grønn før noe pass kjørte, så en rød kjøring peker på de nye testene. " +
      "Rødt rapporteres som guarded, men stoles bare svakt på: det beviser at testene feiler uten noen fiks i det hele tatt, ikke mot en plausibel feil fiks. Den sterkere sjekken bes solveren om i prosa, fordi kode ikke kan liste opp de gale fiksene. " +
      "Grønt er funnet som betyr noe: PR-teksten får en advarsel som navngir testfilene. Den blokkerer aldri PR-en, fordi fiksen fortsatt kan være riktig. " +
      "På som standard; FAIL_FIRST_CHECK=false skrur den av.",
  );
  label(s, 0.5, 1.4, 5.8, 0.3, "EKSPERIMENTET — ren kode, etter at verify har passert", {
    bold: true,
    align: "left",
    size: 10.5,
  });
  const steps = [
    [
      1.8,
      "1  En egen checkout av basen",
      "En frakoblet worktree av den urørte basebranchen: feilen er der fortsatt, fiksen er ikke. Kjøringens egen worktree røres ikke.",
    ],
    [
      3.0,
      "2  Legg kjøringens testfiler oppå",
      "Bare testfilene kjøringen la til eller endret (*.test.*, __tests__/, test/), kopiert fra fiksen.",
    ],
    [
      4.2,
      "3  Kjør basens testkommando",
      "Samme kommando som verify bruker, lest fra basens manifest. Deretter slettes probe-checkouten.",
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

  label(s, 6.7, 1.4, 6.13, 0.3, "HVA DEN SKILLER", { bold: true, align: "left", size: 10.5 });
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
      [H("Den nye testen…"), H("med fiksen (verify)"), H("uten fiksen (probe)")],
      ["fanger feilen", cell("grønn", "ok"), cell("rød → guarded", "ok")],
      ["treffer ikke feilen", cell("grønn", "ok"), cell("grønn → vacuous ⚠", "bad")],
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
      { text: "Eksempel (illustrativt): ", options: { bold: true } },
      {
        text: "feilen er NaN ved tomt beløp, men den nye testen sjekker bare formatAmount(100). Den er grønn både med og uten fiksen.",
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
      [O("guarded", C.ok), "rød uten fiksen · ingenting i PR-en, et svakt signal"],
      [O("vacuous", C.bad), "grønn uten fiksen · ⚠ advarsel i PR-teksten"],
      [O("skipped", C.neutral), "ingen testfil endret, eller bare tester endret"],
      [O("inconclusive", C.neutral), "proben fikk ikke kjørt (f.eks. install) · sier ingenting"],
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
      { text: "Den rapporterer; den blokkerer aldri. ", options: { bold: true } },
      {
        text: "En test som ikke beviser noe, gjør ikke fiksen gal — den betyr at testen ikke sier noe om den.",
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
    "Scope guard",
    "Hva en kjøring får røre — sjekket fire steder",
    "Det finnes ingen enkeltkomponent som heter «scope guard» i koden: det er fire sjekker på fire tidspunkter. " +
      "Diff-gaten leser git diff --numstat -z — -z er viktig, for ellers kunne et filnavn med linjeskift, foreslått av angriperstyrt tekst i saken, forfalske en ekstra post. Omdøpinger sjekkes på begge sider. " +
      "Verifiseringslisten er «resultattavla du blir målt på»: en endring på én linje i vitest-konfigen er den farlige størrelsen, ikke den trygge. " +
      "Utvidelse kom fra PR #2688: operatøren ba tre ganger om å fjerne ubrukte exports, og tre runder avslo, fordi passet ikke kunne skille operatøren fra Copilot. Nå avgjør GitHubs authorAssociation, og et token per runde gjør merkingen umulig å forfalske fra en kommentar.",
  );
  const bands = [
    [
      "Før noe skrives",
      "Plansjekk",
      "Recons plan navngir hver sti fiksen vil endre. En sti diff-gaten avviser ved navn — for eksempel en lockfil — stopper kjøringen før fix-passet. Ingen modell får skrivetilgang.",
    ],
    [
      "Etter passene",
      "Diff gate",
      "Ren kode over den ekte diffen, aldri modellens egen beretning. Plassering: utenfor worktreen · .git · CI-konfig · env-filer · agentens egne skills · lockfiler. Resultattavla, avvist uansett størrelse: package.json · tsconfig · lint- og testkonfig · pom.xml · Maven wrapper (unntatt avhengighetsbump i pom.xml, navngitt i PR-en).",
    ],
    [
      "Utenfor worktreen",
      "Escape-sjekk",
      "Tar øyeblikksbilde av alle andre checkouts passet kan lese, før og etter. En skriving diff-gaten ikke ser, blir likevel oppdaget.",
    ],
    [
      "I review",
      "Bare medlemmer kan utvide",
      "En review-kommentar kan utvide sakens scope bare hvis GitHub sier at et repo-medlem skrev den — aldri Copilot, en bot eller botens egne svar. Passet må deklarere hver utvidelse; harnessen sjekker den mot medlemskommentarer og filene PR-en allerede har endret.",
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
        { text: name, options: { fontSize: 15, bold: true, color: C.white } },
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
      fontSize: i === 1 ? 11.5 : 13,
      color: C.ink,
      margin: PAD,
      valign: "middle",
    });
  });
  s.addText(
    [
      { text: "Målt, ikke stoppet: ", options: { bold: true, color: C.navy } },
      {
        text: "en størrelsesgrense fantes og ble slettet — den slo inn etter at pengene var brukt, og et menneske reviewer uansett hver PR. Størrelsen skrives fortsatt ut på hver kjøring.",
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
// 12. Review-runder
// =====================================================================
{
  const s = content(
    "Review-runder",
    "Å jobbe pull requesten fram til overlevering",
    "Hvert andre minutt ser review-løkken på hver åpen PR. Har ingen svart, forblir den draft — å vente koster to gh-lesinger og ingen checkout. " +
      "Har basen flyttet seg, merges den inn først; konflikter får sin egen merge-runde. En runde reserverer markøren før den gjør noe, og fikser, pusher, svarer og løser trådene. " +
      "Når en runde ikke finner noe mer å endre, tas PR-en ut av draft og overleveres til et menneske. " +
      "Reviewer-grensen begrenser to maskiner som snakker med hverandre; et menneskes forespørsel er nettopp den informasjonen utenfra grensen finnes for, så den teller ikke. Totalen på 20 er bremsen ingenting er unntatt fra.",
  );
  const y = 1.55,
    h = 1.05,
    w = 2.25;
  const xs = [0.45, 2.98, 5.51, 8.04, 10.57];
  node(s, xs[0], y, w, h, "Draft-PR åpnet", "@copilot bedt om\nagent:reviewing", "harness", {
    subSize: 10.5,
  });
  node(s, xs[1], y, w, h, "Har noen svart?", "en ulest review\neller en åpen tråd", "harness", {
    subSize: 10.5,
  });
  node(
    s,
    xs[2],
    y,
    w,
    h,
    "Basen flyttet?",
    "merge den inn — konflikter\nfår en merge-runde",
    "harness",
    { subSize: 10.5 },
  );
  node(s, xs[3], y, w, h, "Runde", "reserver markøren · fiks\npush · svar · løs", "agent", {
    subSize: 10.5,
  });
  node(s, xs[4], y, w, h, "Undraft", "ingenting mer å endre\nagent:review-done", "harness", {
    subSize: 10.5,
  });
  for (let i = 0; i < 4; i++) {
    arrow(s, xs[i] + w, y + h / 2, xs[i + 1], y + h / 2);
  }
  label(s, xs[1], 1.24, w, 0.28, "↻ ingen ennå — forblir draft", { size: 10, italic: true });
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
  label(s, xs[1] + w / 2, 2.95, xs[3] - xs[1], 0.3, "pushet en endring — se igjen neste tick", {
    size: 10,
    italic: true,
    color: C.agentDark,
  });
  node(s, xs[4], 3.0, w, 0.7, "Review og merge", "et menneske → agent:done", "human", {
    subSize: 10,
  });
  arrow(s, xs[4] + w / 2, y + h, xs[4] + w / 2, 3.0);

  card(s, 0.45, 3.95, 6.1, 2.8, { fill: C.soft });
  s.addText("Grenser", {
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
          { text: "3 reviewer-runder", bold: true },
          { text: " (MAX_REVIEW_ITERATIONS) — et menneskes forespørsel teller ikke" },
        ],
        [
          { text: "20 runder per PR, totalt", bold: true },
          { text: " (MAX_PR_ROUNDS_TOTAL) — bremsen; en merge-runde bruker også én" },
        ],
        [
          { text: "Markøren reserveres først", bold: true },
          { text: " — en krasj kan ikke gi tilbake en gratis runde" },
        ],
        [
          { text: "Push, så svar", bold: true },
          { text: " — et svar beskriver aldri en endring som ikke landet" },
        ],
        [
          { text: "En runde som ikke lander noe, sier hvorfor", bold: true },
          { text: ", til den som spurte" },
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
      fontSize: 12,
      color: C.ink,
      valign: "top",
      margin: 0,
    },
  );

  card(s, 6.83, 3.95, 6.0, 2.8, { fill: C.white });
  s.addText("SSX-3834, 6. september 2026", {
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
    ["13:21", "draft-PR #2662 åpnet · agent:reviewing"],
    ["13:24", "Copilot: 2 inline-kommentarer — en ekte NaN-regresjon"],
    ["13:28", "runde 1 · fikset, svarte, begge trådene løst"],
    ["13:30", "Copilot godkjenner"],
    ["13:31", "runde 2 · ingen endring · ut av draft · agent:review-done"],
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
      fontSize: 12,
      color: C.ink,
      margin: 0,
      valign: "middle",
    });
  });
}

// =====================================================================
// 13. Slack-revisjon
// =====================================================================
{
  const s = content(
    "Revisjonslogg",
    "Én Slack-tråd per sak — og Jira-saken holder tilstanden",
    "Hver sak pipelinen rører, får én Slack-melding som boten stadig redigerer: et statuskort, hendelsene som avgjør sakens skjebne, og så tidslinjen med nyeste først. Svar i tråden er for mennesker. " +
      "Tilstanden bak — hvilken melding, og posten den viser — lagres på selve saken som issue-propertyen jira-police.slack. " +
      "Den skulle først ligge i Slacks egen meldingsmetadata; slack:probe sin første kjøring viste at Slack dropper en egendefinert metadatatype med mindre app-manifestet deklarerer den, og en deklarert type kan ikke holde en liste med tidslinjeoppføringer. " +
      "Notifieren kaster aldri: Slack er en rapporteringskanal, og en Slack- eller Jira-feil logges med det eksterne systemets egen årsak og feiler aldri det betalte arbeidet. " +
      "Meldingen på sliden er illustrativ — saken og tidspunktene er oppdiktet, oppsettet er det render.ts tegner. Boten skriver på engelsk, derfor er meldingen på engelsk.",
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
  label(
    s,
    mx,
    my + mh + 0.03,
    mw,
    0.25,
    "illustrativ sak — oppsettet render.ts tegner (boten skriver på engelsk)",
    { size: 9, italic: true },
  );

  const chain = [
    ["Hendelse i pipelinen", "triage · claim · pass · PR · runde · merge · krasj"],
    ["Last posten", "fra Jira-issue-propertyen jira-police.slack"],
    ["Bruk hendelsen, tegn meldingen", "begge rene funksjoner — hver overgang er en test"],
    ["Post eller rediger meldingen", "kun chat:write, kun bot-token"],
    ["Lagre posten", "tilbake på saken"],
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
          { text: "Hvorfor saken, ikke Slack? ", bold: true },
          {
            text: "Proben viste at Slack dropper egendefinert metadata som ikke er deklarert — og en deklarert type kan ikke holde en liste.",
          },
        ],
        [
          { text: "Kaster aldri. ", bold: true },
          { text: "En Slack- eller Jira-feil logges, og feiler aldri det betalte arbeidet." },
        ],
        [
          { text: "off · dry · live. ", bold: true },
          { text: "dry leser den ekte posten og skriver meldingen til groomed/slack/." },
        ],
        [
          { text: "Begrenset og escapet. ", bold: true },
          {
            text: "Kappet for å passe Jiras property-grense; en tittel med <!channel> pinger ingen.",
          },
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
      fontSize: 11,
      color: C.ink,
      valign: "top",
      margin: 0,
    },
  );
}

// =====================================================================
// 14. Stigen
// =====================================================================
{
  const s = content(
    "Hvordan vi kom hit",
    "Hvert privilegium ble fortjent, ett trinn om gangen",
    "Her møtes del 1 og del 2. Hver kapabilitet ble levert i denne rekkefølgen: bygget, men inert, så en tørrkjøring som skriver en rapport, så ett navngitt mål bak et flagg som må skrives, og løkken sist. " +
      "solve:once klatrer en kumulativ stige — --claim skriver labelen, --solve lager en worktree og kjører passene, --pr pusher og åpner en draft-PR, --review jobber gjennom reviewen. " +
      "--advance og --watch er moduser, ikke trinn: én review-runde, eller fortsett å følge med, på en PR en tidligere kjøring åpnet. " +
      "Ekte saker ble claimet, løst, reviewet og merget slik for hånd før daemonen fikk lov til å gjøre det.",
  );
  const steps = [
    [
      "1",
      "Bygget, men inert",
      "Ingenting konstruerer avhengighetene — avvisningen er strukturell, ikke lovet.",
      null,
    ],
    [
      "2",
      "Tørrkjøring",
      "Gjør alt, endrer ingenting, skriver en rapport å vurdere.",
      "poll:once --dry-run\ntriage:once · watch:once\nslack:once",
    ],
    [
      "3",
      "Én navngitt sak",
      "Valgt av et menneske, bak et flagg som må skrives.",
      "solve:once SSX-1234\n--claim → --solve\n→ --pr → --review",
    ],
    ["4", "Løkken", "Legger ikke til noen kapabilitet — den fjerner bare mennesket.", "pnpm start"],
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
        text: "«Fas inn et privilegium, og kjør det for hånd først.» Botens stige er en husregel i praksis — og det er der del 2 tar over.",
        options: { color: C.ink },
      },
    ],
    { x: 0.5, y: 1.4, w: 8.9, h: 0.8, fontFace: FONT, fontSize: 14, margin: 0, valign: "top" },
  );
}

// =====================================================================
// 15. Live-demo
// =====================================================================
{
  const s = content(
    "Live-demo",
    "Det jeg kommer til å kjøre",
    "Alt her er trygt å kjøre live. Bare triage:once koster ekte penger (én triage, ~$1,56), og den poster ingenting uten --write. " +
      "Før demoen: sjekk SLACK_MODE. Med live vil triage:once og daemonen poste i Slack-kanalen og skrive propertyen på saken — sett den til off eller dry hvis du ikke vil ha det på skjermen. " +
      "Velg demosakene på forhånd, blant annet én med agent:watching til steg 4. Slett denne sliden hvis du heller vil demoe fritt.",
  );
  const rows = [
    [
      "pnpm poll:once --dry-run",
      "Hva grooming-løkken ville triagert akkurat nå — endrer ingenting",
    ],
    [
      "pnpm triage:once SSX-1234 --skill intake-triage",
      "En ekte vurdering av én sak, ikke postet — legg til --write for å poste",
    ],
    [
      "SOLVE_ENABLED=true pnpm solve:once",
      "Hvilke saker løsekøen ville claimet, og de nøyaktige label-endringene → groomed/solve-cycle.md",
    ],
    [
      "pnpm watch:once SSX-1234",
      "Hva sendback-vakten ville gjort med en overvåket sak, uten å poste",
    ],
    ["pnpm slack:once SSX-1234", "Sakens revisjonstråd, tegnet tørt → groomed/slack/"],
    [
      "pnpm start --skill mock-triage --interval 10s --for 1m",
      "Daemonen med en stand-in-skill, i ett minutt",
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
// 16. Del 2
// =====================================================================
section(
  2,
  "Hvordan utviklingen er instruert",
  "Boten bygges også med en kodeagent. Dette er reglene dens — og hvor de kom fra.",
  [
    "Instruksjonsstakken: CLAUDE.md, husreglene, hendelsesloggen",
    "Fire faser, lastet når du er i dem",
    "Arkitekturdokumenter som indeks, med hvert faktum ett sted",
    "Hendelser som endrer reglene — en selvforsterkende løkke",
    "Guardrails, de fire spørsmålene, og hvor lite noen av dem beviser",
  ],
  "Den samme disiplinen boten kjører under — ikke stol på egenrapportering, fortjen privilegier i faser, hold tilstanden der folk kan lese den — er hvordan agenten som utvikler den, er instruert. Del 2 viser strukturen, og deretter løkken som stadig endrer den.",
);

// =====================================================================
// 17. Instruksjonsstakken
// =====================================================================
{
  const s = content(
    "Instruksjonsstakken",
    "Hvor instruksjonene bor, og hva hvert lag er til",
    "CLAUDE.md er den eneste filen som alltid er i kontekst, og det er også den som overlever en komprimering — derfor holder den de tre reglene som ikke er veiledende, de fire spørsmålene og en tabell over hvilken fasefil som skal lastes. " +
      "Husreglene er en indeks pluss fire korte fasefiler, delt opp slik en endring skjer. INCIDENTS.md er bevisene bak reglene, og ligger bevisst ikke på lesestien for å gjøre arbeid. " +
      "Fire dokumenter behandles som kildekode: en endring som gjør en setning i ett av dem usann, må skrive om den setningen i samme commit.",
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
    "Alltid lastet, og overlever komprimering. De tre reglene, de fire spørsmålene, hvilken fase som skal lastes.",
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
    "Indeksen — «last fasen du er i»",
    "harness",
    { titleSize: 14, subSize: 11.5, align: "left", margin: [12, 12, 3, 3] },
  );
  arrow(s, L + Wd / 2, 3.4, L + Wd / 2, 3.6);
  const phases = ["STARTING", "BUILDING", "PROVING", "FINISHING"];
  const whens = ["før første endring", "mens du skriver", "mens du beviser", "på vei ut"];
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
    "Bevisene: 64 daterte hendelser, bare tillegg. Hver regel som viser til en, lenker hit. Ikke på lesestien.",
    "neutral",
    { titleSize: 14, subSize: 11.5, align: "left", margin: [12, 12, 3, 3], dash: "dash" },
  );
  s.addText("reglene viser til hendelsen sin  ↑", {
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
  s.addText("Tre regler som ikke er veiledende", {
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
      { text: "1  Jobb aldri på main", options: { bold: true, breakLine: true } },
      {
        text: "    eller en annen beskyttet branch.",
        options: { color: "C9D6EA", breakLine: true },
      },
      { text: "2  Et menneske merger. Alltid.", options: { bold: true, breakLine: true } },
      {
        text: "    PR-en er slutten på agentens del.",
        options: { color: "C9D6EA", breakLine: true },
      },
      { text: "3  Jobb i en egen worktree.", options: { bold: true, breakLine: true } },
      { text: "    Hoved-checkouten er daemonen som kjører.", options: { color: "C9D6EA" } },
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
  s.addText("Fire dokumenter, behandlet som kode", {
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
        [{ text: "README.md", bold: true }, { text: " — hvordan kjøre den" }],
        [{ text: "ARCHITECTURE.md", bold: true }, { text: " — hvordan den virker (en indeks)" }],
        [{ text: "PLAN.md", bold: true }, { text: " — hva som ikke er bygget; aldri lærdom" }],
        [{ text: "dev-house-rules", bold: true }, { text: " — hvordan vi jobber" }],
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
  s.addText("Prosa en endring gjør usann, skrives om i samme commit.", {
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
// 18. Fire faser
// =====================================================================
{
  const s = content(
    "Fasene",
    "Fire faser — last den du er i",
    "Reglene er delt opp slik en endring skjer: før første endring, mens du skriver, mens du beviser, og på vei ut. Hver fil er kort og lenker til den neste. " +
      "Den som bør trekkes fram, er løkken i PROVING: dev, test, kjør, menneske, revurder. Det er den eneste regelen der fraværet er usynlig, fordi alt fortsatt er grønt om du hopper over den. " +
      "Tabellen der er ensidig: hver alvorlig defekt her — en løkke som avsluttet umiddelbart, en verktøy-allowlist som ikke begrenset noe, et ikon tegnet ut fra et adjektiv — ble levert med grønn testsuite og funnet ved å kjøre tingen.",
  );
  const cols = [
    [
      "1",
      "STARTING",
      "før første endring",
      [
        "Prosa en endring gjør usann, skrives om i samme commit",
        "Skriv planen i PLAN.md først; slett den før du pusher",
        "Fas inn et privilegium: inert → tørrkjøring → ett navngitt mål → løkke",
        "Én branch per privilegium, egen worktree; ikke stable dypt",
      ],
    ],
    [
      "2",
      "BUILDING",
      "mens du skriver",
      [
        "Defektklassen: prosa som beskriver oppførsel koden ikke lenger har",
        "Feil lukket — unntatt guards, som feiler åpent",
        "Tilstanden bor i det eksterne systemet",
        "En feil forklarer seg selv ved første kjøring",
        "Slett det endringen din gjorde foreldreløst",
      ],
    ],
    [
      "3",
      "PROVING",
      "mens du beviser",
      [
        "En guard sendes først ut når en test feiler med den frakoblet — mot den plausible feile fiksen",
        "Mål, ikke anta",
        "Løkken: dev → test → kjør → menneske → revurder",
        "Hver kapabilitet får en kommando på én linje",
      ],
    ],
    [
      "4",
      "FINISHING",
      "på vei ut",
      [
        "Les fasefilen på nytt; aldri fra hukommelsen",
        "Kjør sjekkene",
        "Still de fire spørsmålene",
        "«Rules owed:» i hver PR-tekst",
        "Postmortem; foreslå før du endrer",
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
    s.addText(bullets(items, { gap: 10 }), {
      x: x + 0.15,
      y: 2.38,
      w: w - 0.28,
      h: 3.6,
      fontFace: FONT,
      fontSize: 13,
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
      { text: "«Leser du én seksjon, les løkken.» ", options: { bold: true } },
      {
        text: "Det er den eneste regelen der fraværet er usynlig — hopp over den, og alt ser fortsatt grønt ut.",
        options: { color: "DCE6F2" },
      },
    ],
    { size: 13 },
  );
}

// =====================================================================
// 19. Arkitektur
// =====================================================================
{
  const s = content(
    "Arkitekturdokumentene",
    "En indeks, og hvert faktum på nøyaktig ett sted",
    "ARCHITECTURE.md var en gang hele kartet — 3 160 linjer, seksten seksjoner — og et dokument på den størrelsen slutter folk å lese på nytt, så regelen om at det skal følge koden sluttet i det stille å gjelde. " +
      "Det ble delt opp per modul 18. september. Overskrifter ble flyttet hele, aldri nummerert om, så en §7 i en kodekommentar skrevet for måneder siden peker fortsatt riktig. " +
      "Et faktum bor i én fil og siteres fra alle andre steder, og docs:check feiler CI hvis en henvisning, en lenke eller en festet kopi slutter å peke riktig. " +
      "not-built.md er verdt å nevne: «vi vurderte det og bestemte oss for ikke å gjøre det» overlever sesjonen som vurderte det.",
  );
  node(
    s,
    0.5,
    1.4,
    6.3,
    0.7,
    "ARCHITECTURE.md",
    "indeksen: hvilken fil eier hvilket faktum",
    "navy",
    { titleSize: 15, subSize: 11 },
  );
  const files = [
    ["overview.md", "§1 §2 §5 §6 §8 §9 §11", "løkker, tilstand, feilmodell"],
    ["module-map.md", "§7", "hvilken fil eier hvilken modul"],
    ["triage.md", "§3 §4 §12", "analyser, gate, post"],
    ["solve.md", "§15", "worktree, pass, diff gate"],
    ["configuration.md", "§10", "hver innstilling og hvert flagg"],
    ["invariants.md", "§14", "egenskaper alt avhenger av"],
    ["not-built.md", "§13", "hva den bevisst ikke gjør"],
    ["guardrails.md", "§16", "hooks — og hva de ikke beviser"],
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
          { text: "Var én fil på 3 160 linjer. ", bold: true },
          {
            text: "Delt opp per modul, så det koster omtrent like mye å sjekke kartet mot en endring som endringen selv.",
          },
        ],
        [
          { text: "§N nummereres aldri om. ", bold: true },
          { text: "En §7 i en gammel kodekommentar peker fortsatt riktig." },
        ],
        [
          { text: "Sitert, aldri gjentatt. ", bold: true },
          { text: "Et faktum med to hjem blir før eller siden feil i ett av dem." },
        ],
        [
          { text: "pnpm docs:check, i CI. ", bold: true },
          { text: "Sjekker hver §N, lenke, festet kopi og sitert tall." },
        ],
        [
          { text: "Følger koden. ", bold: true },
          { text: "Når implementasjonen flytter seg, flytter filen seg i samme commit." },
        ],
        [
          { text: "Tall råtner som fakta. ", bold: true },
          { text: "Løsningen som holder, er å ikke oppgi dem." },
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
// 20. Hendelsesløkken
// =====================================================================
{
  const s = content(
    "Hendelser",
    "Hendelser endrer reglene — en selvforsterkende løkke",
    "Ingenting i reglene ble designet ut fra en teori: hver av dem generaliserer noe som slapp gjennom. Den mest verdifulle utløseren er en regel som ble fulgt, og defekten skjedde likevel. " +
      "Postmortem spør etter mekanismen, ikke skylden — «modellen hallusinerte» er ikke en mekanisme; «passet fikk et sammendrag, og ingenting merket det som utledet» er det. " +
      "Én forekomst er en hypotese og venter i INCIDENTS.md som «No rule yet»; regelen om lister med bokstavelige verdier ble først navngitt ved tredje forekomst. " +
      "Og endringer foreslås før de gjøres: endringen, defekten, hvor den hører hjemme, og ærlig talt hva den ville og ikke ville fanget.",
  );
  const Wn = 3.05,
    Hn = 1.3;
  const N = [
    [
      6.67,
      2.0,
      "En defekt slipper gjennom",
      "en bug nådde main · den overlevde tester, review og en kjøring · en betalt kjøring lærte oss ingenting · en regel ble fulgt, og det skjedde likevel",
      "bad",
    ],
    [
      10.85,
      3.35,
      "Postmortem, tre spørsmål",
      "Hvorfor skjedde det? Hva var den egentlige feilen? Hva ville fanget det — og generaliserer det?",
      "neutral",
    ],
    [
      9.3,
      5.65,
      "INCIDENTS.md",
      "Datert, bare tillegg, aldri redigert for å se bedre ut. En Found by-linje sier hva som faktisk fanget det.",
      "neutral",
    ],
    [
      4.04,
      5.65,
      "En regel, lenket til den",
      "Lagt inn i fasen den hører til. Én forekomst er en hypotese: «No rule yet».",
      "harness",
    ],
    [
      2.48,
      3.35,
      "Håndhevet uten hukommelse",
      "Hooks injiserer den ved komprimering og commit · docs:check holder lenkene gyldige · CI krever «Rules owed:»",
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
      { text: "Hver regel er en hypotese", options: { bold: true, breakLine: true } },
      { text: "som har overlevd så langt.", options: { bold: true } },
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
  s.addText("…og er en av dem feil: foreslå endringen, med bevisene, før du redigerer.", {
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
// 21. Fire hendelser
// =====================================================================
{
  const s = content(
    "Hendelser → regler",
    "Fire hendelser, fire regler",
    "Fire representative oppføringer av 64. Allowlisten er den skumleste: i prosjektets tidlige liv påsto tre kodekommentarer en begrensning som ikke fantes, og hver test var enig med dem. " +
      "Faviconet er den beste illustrasjonen på hvorfor review er feil verktøy mot en dyktig produsent: resultatet ser alltid troverdig ut. " +
      "Fail-first-replayen er grunnen til at husregelen er strengere enn red-green. " +
      "Nederste linje er denne ukas levende eksempel: dagens README-gjennomgang fant avvik fra endringer i oppførsel som ikke la til noe nytt flagg eller ny innstilling, og det dekker ikke STARTING sin README-trigger. Endringen er foreslått i PR #91 og venter på enighet.",
  );
  const cards = [
    [
      "Allowlisten som ikke begrenset noe",
      "--allowedTools ble antatt å begrense modellens verktøy. Fire prober med en kontroll viste at den bare forhåndsgodkjenner: hver triage-kjøring noensinne hadde Bash, Write og Edit.",
      "Mål, ikke anta. Verktøy fjernes nå med --disallowedTools.",
    ],
    [
      "Faviconet rekonstruert fra et adjektiv",
      "Løseren kunne ikke åpne den vedlagte SVG-en, så den tegnet «en rød blokk-T» ut fra beskrivelsen. Den overlevde to automatiske reviews, et menneske og tre review-runder. Ingen lastet siden.",
      "Steg 4 i løkken: et menneske bruker funksjonen — leser ikke bare diffen.",
    ],
    [
      "Fail-first-replayen",
      "Sju nye assertions ble alle røde mot den opprinnelige buggen — og bare én mot den plausible feile fiksen. Red-green var oppfylt av en testsuite som var seks sjuendedeler pynt.",
      "Koble fra den plausible feile implementasjonen, ikke buggen.",
    ],
    [
      "Ni mergede PR-er uten én review",
      "Ingenting hadde sjekket en endring bortsett fra agenten som skrev den — sjekklisten ble bekreftet av den som ble sjekket. CIs første kjøring fant format:check rød på main.",
      "Kjør sjekkene der de ikke kan hoppes over: CI, på den pushede ref-en.",
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
      h: 1.02,
      fontFace: FONT,
      fontSize: 13,
      color: C.ink,
      margin: 0,
      valign: "top",
    });
    s.addText(
      [
        { text: "→ Regel  ", options: { bold: true, color: C.siren } },
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
      { text: "Denne uka: ", options: { bold: true, color: C.siren } },
      {
        text: "README-en drev fra koden etter endringer i oppførsel uten nytt flagg eller ny innstilling — og STARTING sin README-trigger nevner bare de. Endring foreslått i PR #91.",
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
    "Guardrails for agenten — og hvor lite de beviser",
    "Disse beskytter menneskene og agentene som jobber på repoet; botens egne løse-pass ser dem aldri. " +
      "branch-guard behandler git som en allowlist: en underkommando den ikke kjenner igjen som lesing, regnes som skriving. " +
      "Den ærlige delen er boksen nederst: hook-suiten beviser at et skript sender ut en avvisning, aldri at runtimen handler på den; worktree-regelen har ingen guard i det hele tatt; og Rules owed-steget kan ikke skille et sant «none» fra et usant. " +
      "Det ble skrevet med sin egen avviklingsbetingelse: hvis den ferske kontekst-revisjonen noen gang svarer «none» på en diff som åpenbart skylder noe, skal steget slettes, ikke justeres. " +
      "Artig detalj for salen: branch-guard nektet å la akkurat denne presentasjonen skrives utenfor en worktree.",
  );
  const H = (t) => ({ text: t, options: { bold: true, color: C.white, fill: { color: C.navy } } });
  const g = (t) => ({ text: t, options: { bold: true, fontFace: MONO, color: C.harnessDark } });
  s.addTable(
    [
      [H("Guard"), H("Utløses av"), H("Hva den gjør")],
      [
        g("branch-guard.sh"),
        "hver Bash, Edit, Write",
        "Avviser skriving på main / master / develop / release/*, push som nevner en av dem, og gh pr merge overalt",
      ],
      [g("branch-stack.sh"), "Bash", "Spør før en ny branch stables mer enn 3 dypt"],
      [
        g("session-brief.sh"),
        "sesjonsstart · komprimering",
        "Injiserer kontrakten; etter komprimering legger den inn de tre reglene og de fire spørsmålene",
      ],
      [
        g("commit-brief.sh"),
        "git commit",
        "Viser de fire spørsmålene i øyeblikket de er til for — blokkerer aldri",
      ],
      [
        g("CI"),
        "hver pull request",
        "typer · lint · tester · format · hook-suite · docs:check — og en «Rules owed:»-linje i PR-teksten",
      ],
    ],
    {
      x: 0.5,
      y: 1.4,
      w: 12.33,
      colW: [2.1, 2.5, 7.73],
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
  s.addText("Anta at ingenting mekanisk holder reglene", {
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
        "Hook-suiten beviser at en guard sender ut en avvisning — aldri at runtimen handler på den.",
        "Regel 3, jobb i en worktree, har ingen guard i det hele tatt.",
        "«Rules owed:» kan ikke skille et sant none fra et usant — den gjør svaret til en påstand en reviewer kan se.",
        "Briefene henter teksten fra CLAUDE.md og FINISHING.md ved kjøring, så de kan ikke drive fra dem.",
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
// 23. De fire spørsmålene
// =====================================================================
{
  const s = content(
    "Før hver commit",
    "De fire spørsmålene — ingen kommando kan svare på dem",
    "Dette er vurderingshalvdelen av kontrakten: ingenting ved dem blir noen gang grønt eller rødt, og det er nettopp derfor de hoppes over. Derfor er de plassert der de ikke kan overses — i CLAUDE.md, som overlever komprimering; injisert etter en komprimering; og skrevet ut ved hver git commit. " +
      "docs:check feiler hvis kopien i CLAUDE.md driver fra FINISHING.md. " +
      "Det fjerde er det som hoppes over i stillhet, så det ble gjort om til et artefakt: hver PR-tekst må ha en Rules owed-linje, laget av en fersk kontekst som ikke gjorde jobben. " +
      "Originalene står på engelsk i repoet; oversatt her.",
  );
  const qs = [
    [
      "Er det en kommentar nær endringen som nå er sann om noe annet?",
      "Ikke de du redigerte — de du ikke redigerte.",
    ],
    [
      "Hvis dette feiler klokka 3 om natta, hva etterlater det seg?",
      "Gå gjennom hver utgang og navngi artefaktet.",
    ],
    [
      "Hva motbeviste kjøringen?",
      "Ingenting motbevist betyr at ingen prediksjon ble notert — eller at kjøringen var for liten.",
    ],
    [
      "Slapp noe gjennom som disse reglene ikke dekker?",
      "Da er det reglene som må fikses. Besvares i hver PR-tekst som «Rules owed:»",
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
    "Injiseres etter hver komprimering og ved hver git commit · CI feiler en PR uten «Rules owed:»",
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
// 24. Den røde tråden
// =====================================================================
{
  const s = content(
    "Den røde tråden",
    "De samme prinsippene, på begge sider",
    "Poenget med hele foredraget: boten og prosessen som bygger den følger de samme få prinsippene. " +
      "Ingen av dem stoler på en aktørs egen beretning om sitt arbeid; begge fjerner kapabiliteter i stedet for å be en aktør la være å bruke dem; begge fortjener privilegier i faser; og begge holder tilstanden der et menneske kan lese den.",
  );
  const H = (t) => ({ text: t, options: { bold: true, color: C.white, fill: { color: C.navy } } });
  const p = (t) => ({ text: t, options: { bold: true, color: C.navy } });
  s.addTable(
    [
      [H("Prinsipp"), H("I boten"), H("I hvordan den bygges")],
      [
        p("Ikke stol på egenrapportering"),
        "Harnessen kjører testene og leser exit-koder; modellen blir aldri spurt",
        "CI på den pushede ref-en; «Rules owed:» skrevet av en fersk kontekst som ikke gjorde jobben",
      ],
      [
        p("Minste privilegium, ved fravær"),
        "Ingen shell, nettverk eller MCP i noe pass; triage har aldri REST-credentialen",
        "Branch-guard; agenten kan ikke skrive sine egne innstillinger; et menneske merger",
      ],
      [
        p("Fortjen privilegier i faser"),
        "tørrkjøring → én navngitt sak → løkken",
        "inert → tørrkjøring → ett navngitt mål → løkke",
      ],
      [
        p("Tilstand der folk kan lese den"),
        "Labels, PR-markøren, Jira-propertyen bak Slack-tråden",
        "PLAN.md, INCIDENTS.md, PR-teksten",
      ],
      [
        p("En avvisning forklarer seg selv"),
        "Årsaken postes på saken, eller besvares til den som spurte",
        "En feil forklarer seg selv ved første kjøring; en Found by-linje på hver ny hendelse",
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
// 25. Oppsummering
// =====================================================================
{
  const s = pptx.addSlide({ masterName: "DARK" });
  s.addText("OPPSUMMERING", {
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
      "Agenter vurderer. ",
      "Deterministisk kode gjør alt som kan sjekkes — inkludert å rette agentene.",
    ],
    ["Privilegier fortjenes. ", "For hånd, så tørt, så én sak, så løkken."],
    ["Reglene kommer fra hendelser, ", "og håndheves der ingen trenger å huske dem."],
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
  s.addText("Et menneske merger. Alltid.", {
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
  s.addText("Spørsmål?", {
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
    "Avslutt med den ene garantien ingen endring har rørt: boten har ingen vei til å merge, og det har heller ikke agenten som bygger den. Sannsynlige spørsmål: kostnad per sak (en triage koster ~$1,56; kostnaden per dag under den ubemannede løkken er ikke målt ennå), og hva som skjer når den tar feil (agent:failed med årsaken på saken, eller en PR et menneske avviser).",
  );
}

await write("the-jira-police-demo.no.pptx");
