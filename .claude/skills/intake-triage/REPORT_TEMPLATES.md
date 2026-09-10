# intake-triage — report templates

Format: **`triage-scorecard`** — built for an operator triaging hundreds of tickets/day who must
decide **accept / reject / route / send-back in <10 seconds**. Verdict first, exceptions only,
everything else compressed. Plain markdown only — the SAME block must render in a terminal AND as
a Jira comment (no HTML, no ANSI, no collapsible, no colour).

## Fixed shape (always these blocks, in this order)

1. **H1 verdict banner** — verdict glyph + ACTION VERB + action + `· <KEY>`. Nothing precedes it. The single-saccade yes/no.
2. **Title line** — `**<title>** · <type> · <status>`.
3. **BLUF reason line** — `· `-separated: `<route · owning_team · jira:PROJECT>(<component>) · <dup verdict> · DoR <PASS|FAIL|n/a> · value <H|M|L> × effort <S|M|L> = <hint>`. Lines 1–3 are a COMPLETE answer even if the table wraps or fails to render.
4. **6-row scorecard** — fixed gate-first order: Ours? → Raised? → Solved? → DoR? → Build → Component. The eye lands on the same gate every ticket.
5. **`→ Next`** — the recommended step(s); carry every FIX / coordination action HERE, never in a cell.
6. **Evidence blockquote** — one line: already-solved fact · where-built detail · route basis. Keeps the cells short.
7. **Caveat footnote** — one italic blockquote line, always last.

## Glyph legend (learn once here; a one-line legend IS appended to the POSTED Jira comment)

- **Banner:** `✅ ACCEPT` · `⛔ REJECT` · `↪ ROUTE` · `↩ SEND BACK`
- **Row flag (centre column):** `🟢` clear · `🟡` proceed but coordinate/caution · `🔴` blocker / reject-driver · `⚪` n/a (moot for this verdict)
- **Emoji-stripped fallback** (client drops emoji): banner keeps the ALLCAPS verb; flags degrade to `[OK]` / `[!]` / `[X]` / `[-]`.
- **Appended to the POSTED comment:** end the Jira comment with ONE legend line so a ticket reader can decode the glyphs, e.g. `_Legend: ✅accept ⛔reject ↪route ↩send-back · 🟢clear 🟡caution 🔴blocker ⚪n/a · CONF H/M/L = match strength._` — printed once, never per row.

## Emit rules

1. Verdict + action is the first token of line 1 — always H1, nothing before it.
2. The reason line (line 3) must carry the whole call on its own, as insurance against table-wrap.
3. Every answer cell **≤8 words**. NAME the risk in-cell (key, filename, repo); put the FIX in `→ Next`.
4. **Why-text appears ONLY when the flag is not 🟢** — a green row's cell is a bare status. Non-green rows are the only prose, so exceptions are literally the only thing to read.
5. **Discipline — protect the flags:** reserve 🟡/🔴 for genuine attention items. A DoR that PASSES with minor follow-ups stays 🟢 with the follow-up noted in-cell — do NOT paint it yellow. Yellow-fatigue destroys the scan.
6. Size/urgency is **advisory only** — it lives in the reason line, NEVER as a scorecard row, so it can never masquerade as a gate.
7. On a reject/route, moot rows stay in place with `⚪ n/a` (fixed positions > reclaimed space — keeps stacked tickets column-aligned).
8. Surface only the single closest dup/related key in the row; extras drop to Evidence or `--deep`.
9. Exactly one Evidence line and one Caveat line, both blockquotes; the Caveat is always present, always last.
10. **CONF = match strength, not candidate count.** Emit **Ours?/route at HIGH only with a corroborating signal** — surface, domain, or description agreement beyond a single fuzzy keyword. A lone fuzzy keyword hit → **MED** or **route:unknown**. The owner read is deterministic ONCE the service is correctly identified; the _service_ match is a keyword heuristic — verify it before handing off.
11. **Dev lens on ACCEPT (default).** An `✅ ACCEPT` reason / `→ Next` always carries a one-line feasibility read for developers — owning repo · blast LOW/MED/HIGH · the single biggest technical question — so they engage DURING prioritization, no `--deep` needed. Draw it from the vault only.
12. **Data and size are advisory.** A missing baseline metric / expected movement (row 9) or an unsized item (row 8) is shown in the DoR cell and carried in `→ Next` as a follow-up — never a `dor:gaps` item, never a send-back question, and NOT a new scorecard row (the six gates are fixed). Note the gap in one clause; do not argue for why passing anyway is defensible.

## Verdict banner set (line 1)

- `# ✅ ACCEPT → queue · <KEY>` — ours, novel, DoR ok
- `# ⛔ REJECT → duplicate · <KEY>` — already raised / delivered — **dup:HIGH only**. Below HIGH use `# ⛔ REJECT → possible duplicate · <KEY>` (proposal-grade: `relates-to` not `duplicates`, label `dup:maybe`, verify before the Trio closes). Variant: `→ out-of-scope`.
- `# ↪ ROUTE → <owning_team> · <KEY>` — not ours; name the receiving team (the Claims squad name if a claims board) and its home project in the reason line, e.g. `↪ ROUTE → Claims Home & Away (ICC)`
- `# ↩ SEND BACK → needs info · <KEY>` — DoR fail / scope unclear
- No-emoji fallback: `# [ACCEPT] -> queue · <KEY>` · `# [REJECT] -> duplicate · <KEY>` · `# [REJECT] -> possible duplicate · <KEY>` · `# [ROUTE] -> <owning_team> · <KEY>` · `# [BACK] -> needs info · <KEY>`

---

## PM report — the template (default run, always complete on its own)

```markdown
# <✅ ACCEPT → queue | ⛔ REJECT → duplicate (dup:HIGH) | ⛔ REJECT → possible duplicate (dup:maybe/MED) | ↪ ROUTE → <owning_team> | ↩ SEND BACK → needs info> · <KEY>

**<title>** · <type> · <status>
<route:ours · SSX | route:other-team · <owning_team>> · jira:<PROJECT> · (<component>) · <dup verdict> · DoR <PASS|FAIL|n/a> · value <H|M|L> × effort <S|M|L> = <size hint>

| Check     |        | Answer (why only if flagged, ≤8 words)                                 |
| --------- | :----: | ---------------------------------------------------------------------- |
| Ours?     | <flag> | <route:ours · SSX · jira:<PROJECT> · CONF H/M/L                        | route:other-team · <owning_team> · jira:<PROJECT> · CONF H/M/L> |
| Raised?   | <flag> | <dup/related key + status · or "none">                                 |
| Solved?   | <flag> | <No — gap · or Yes — where it exists>                                  |
| DoR?      | <flag> | <PASS/FAIL · top gap as a question>                                    |
| Build     | <flag> | <repo · blast LOW/MED/HIGH · risk flag>                                |
| Component | <flag> | <one of the four streams (from ssx_component when SSX) · set,validated | comp:uncertain — suggest X                                      | ⚪ n/a — non-SSX route> |

**→ Next:** <action · links to raise · the FIX · optional `--deep`>

> Evidence: <already-solved fact · where-built detail · route basis>.
> _Caveat: <one accuracy line: dedup cuts BOTH ways — missed-dup (recall over NO/EN) AND false-duplicate (precision, wrong close) · route rests on a keyword match — verify the service before handing off · vault staleness · MCP visibility>._
```

### Worked example — SSX-3533 (accept)

```markdown
# ✅ ACCEPT → queue · SSX-3533

**Evidence file upload: progress tracking + timeout fix** · Task · Received
route:ours · SSX · jira:SSX · (EDH) · related SSX-3791 (not dup) · DoR PASS · value H × effort S = quick win

| Check     |     | Answer (why only if flagged)                      |
| --------- | :-: | ------------------------------------------------- |
| Ours?     | 🟢  | route:ours · SSX · jira:SSX · HIGH                |
| Raised?   | 🟡  | SSX-3791 **in code review** — same uploader files |
| Solved?   | 🟢  | No — client-side gap (endpoints exist)            |
| DoR?      | 🟢  | PASS · value/why-now? assignee?                   |
| Build     | 🟡  | edh2-customer-web · blast LOW · shared util       |
| Component | 🟢  | EDH (from ssx_component) · set, validated         |

**→ Next:** Accept to queue · link SSX-3791 (relates-to) · in `requestUtils.ts` use a per-request timeout override, not a global 30s→5min bump · optional `--deep` if merge risk unclear.

> Evidence: upload+scan endpoints already exist — client-only change, 4 FE files; blast LOW (depended_on_by empty) · owner read deterministic via owning_team=SSX (service match is a keyword heuristic).
> _Caveat: dedup cuts both ways — missed-dup (recall over NO/EN) AND false-duplicate (precision) · JQL sees readable projects only · vault = last scan._
```

### Worked example — a clear reject

```markdown
# ⛔ REJECT → duplicate · SSX-3610

**Export offer list to Excel from the buy flow** · Task · Received
route:ours · SSX · jira:SSX · (SSX Nettsalg) · duplicate of SSX-2988 (Done, v4.2) · DoR n/a · size n/a (closed)

| Check     |     | Answer (why only if flagged)                       |
| --------- | :-: | -------------------------------------------------- |
| Ours?     | 🟢  | route:ours · SSX · jira:SSX · HIGH                 |
| Raised?   | 🔴  | SSX-2988 — **Done, released v4.2**                 |
| Solved?   | 🔴  | Yes — export shipped in buy-insurance-web          |
| DoR?      | ⚪  | n/a — reject (dup); human closes                   |
| Build     | ⚪  | n/a — no new work                                  |
| Component | 🟢  | SSX Nettsalg (from ssx_component) · set, validated |

**→ Next:** dup:HIGH of SSX-2988 — verify (`--deep`), then the Trio closes · comment the link · tell reporter it shipped in v4.2.

> Evidence: dup:HIGH vs SSX-2988 — shared tokens "export · offer list · Excel · buy flow", ~90% title overlap; release notes confirm v4.2 · owner read deterministic — `index.yaml` buy-insurance-web → owning_team=SSX, jira_project=SSX, ssx_component=SSX Nettsalg.
> _Caveat: dedup cuts both ways — missed-dup (recall over NO/EN) AND false-duplicate (precision, wrong close) · do NOT auto-close below HIGH human-verified confidence · JQL sees readable projects only · vault = last scan._
```

> **Below dup:HIGH, soften line 1.** A MED candidate is `# ⛔ REJECT → possible duplicate` — link `relates-to` (not `duplicates`), label `dup:maybe`, and `→ Next` reads "verify (`--deep`), then the Trio closes if confirmed". Only a HIGH, human-verifiable match earns `→ duplicate` + `dup:solved`/`dup:open`. Line 1 must never claim a certain duplicate the evidence does not support.

### Worked example — route to another team (owner read deterministic)

Once the matched service is confirmed, the vault's `owning_team` / `jira_project` fields make the
OWNER **read, not guessed**: the matched repo is not SSX-owned, so the verdict is `route:other-team`
and the receiving team + home project come straight off `index.yaml`. The _service_ match itself is a
keyword heuristic — verify it before handing off. The component axis is SSX-only, so it is `⚪ n/a`.

```markdown
# ↪ ROUTE → Claims Home & Away · SSX-3620

**Track-my-case: show courier ETA on the status page** · Task · Received
route:other-team · Claims Home & Away · jira:ICC · dup none · DoR n/a (not ours) · size n/a

| Check     |     | Answer (why only if flagged)                            |
| --------- | :-: | ------------------------------------------------------- |
| Ours?     | 🔴  | route:other-team · Claims Home & Away · jira:ICC · HIGH |
| Raised?   | 🟢  | none found in SSX/ICC                                   |
| Solved?   | 🟢  | No — new capability                                     |
| DoR?      | ⚪  | n/a — hand off, not our gate                            |
| Build     | 🟢  | track-my-case-client (Claims Home & Away)               |
| Component | ⚪  | n/a — component axis is SSX-only                        |

**→ Next:** Re-file / move to **ICC** · tag the **Claims Home & Away** board · do NOT queue for the SSX Trio.

> Evidence: `index.yaml` track-my-case-client → owning_team=Claims Home & Away, jira_project=ICC (CLI legacy key → ICC); owning_team ≠ SSX ⇒ route:other-team.
> _Caveat: route rests on a keyword match — verify the service before handing off; the owner read is then deterministic from the vault · ICC ticket visibility depends on MCP project access · vault = last scan._
```

---

## Send-back note (DoR fail — leads the write-back comment)

When the verdict is **↩ SEND BACK**, prepend this reporter-addressed note **above** the scorecard,
inside the _same_ idempotent comment. It turns "rejected" into "here is exactly what to add." List
**only the failing DoR items** (1–3), each as a fill-in prompt — never the passing ones. Suppress
it in preview (the default dry-run) / before the operator confirms, and for containers reclassified to verify/archive (they are not a reporter fix).

```markdown
> **@<reporter> — this isn't Ready yet.** To pass Definition of Ready, please add:
>
> - **<missing item>** — <the concrete question, e.g. "which customer segment is affected, and what breaks for them today?">
> - **<missing item>** — <…>
>
> Reply here or edit the ticket, then re-run intake-triage. Everything else already checks out.
```

### Worked example — SSX-3290 (send back)

```markdown
> **@navjot — this isn't Ready yet.** To pass Definition of Ready, please add:
>
> - **Acceptance criteria** — what is the observable, testable result of the CQRS split for this command?
> - **Value / why-now** — what breaks or is blocked while the refactor is deferred?
>
> Reply here or edit the ticket, then re-run intake-triage. Everything else already checks out.
```

> **Tier note.** Do NOT emit a send-back note for an **Epic/container** that failed only because its
> body is empty — roll up its children instead (verify-if-done / keep / archive per `DOR_CHECKLIST.md`).
> The reporter cannot "fix" a container by writing acceptance criteria on it.

---

## Techlead appendix (`--deep` only — appended below the PM report)

````markdown
---

### Technical deep-dive (--deep)

**Target service(s) & module** — <repo(s) · repo_url · type · domain>

**Capability-exists evidence** — <exact method+path / route; schema confirmed via spec_url: yes/no>

**Dependency chain + blast radius** — upstream (`depends_on`): <…>; impacted (`depended_on_by` / `endpoint_consumers`): <…>; shared-lib / monorepo ripple: <…>

**Cross-team / external integration points** — <external systems on the chain; ownership boundary>

**Effort drivers + open technical questions for the Trio** — <…>

_intake-triage dossier — machine-readable, do not edit:_

```yaml
<machine dossier block>
```
````

```

> Jira renders **ADF** (no HTML-comment node), so the dossier is a **visible captioned `yaml`
> code block**, not a `<!-- -->` comment. The same block is also written to
> `.claude/intake/<KEY>-dossier.yaml` for local reuse; the italic caption `intake-triage dossier`
> is the searchable anchor for re-runs.

---

## Jira comment format (write-back)

Post the PM report (plus appendix if `--deep`) as a single comment that **ends** with the
idempotent footer marker so re-runs find and update it in place instead of adding a new one:

```

<the rendered report>

_🤖 Generated by intake-triage · re-run the command to refresh._

```

Jira renders **ADF**, which has no HTML-comment node — a `<!-- -->` marker would show as a
literal visible line. Use the italic footer instead. A write happens ONLY after the operator
confirms at the gate (see "Write-payload preview + confirm gate" below); `--no-write` and
raw-text input never write. To stay idempotent, identify the skill's OWN comment by BOTH (a) its
own Jira account authorship AND (b) the full footer sentinel line
`_🤖 Generated by intake-triage · re-run the command to refresh._` — never the bare substring
`intake-triage`. Update only a comment that satisfies BOTH; else create a new one. The preview
states which (CREATE vs UPDATE).

---

## Write-payload preview + confirm gate (renders BEFORE any Jira write)

**No Jira write happens without an explicit `y`.** Every run that could write first RENDERS the
exact mutation payload, STOPS, and asks — so a non-technical operator can sanity-check the
highest-risk writes before any Atlassian write tool runs. `--no-write` (preview) renders the
payload but does NOT offer to write (demos, learning, CI). Raw-text input NEVER writes — no ticket
exists. A status change is NEVER applied — print it in `→ Next` only. There is no `--apply`.

```

┌─ WRITE PREVIEW · <KEY> ─ confirm before anything is posted ─
│ Target : <KEY> — <title>
│ Action : CREATE new comment | UPDATE existing skill comment (author=<bot-account> AND footer sentinel matched)
│ Transition : none (recommend-only)
│ Labels Δ : + add: triaged, route:ours, jira:SSX, intake:pm-screened, next:to-trio
│ - remove: (verdict change only — own stale namespaced labels: route:_, dup:_, dor:_, tier:_, intake:*)
│ UNION with current labels — no bare replacement array; human labels untouched
│ Links : + relates-to SSX-3791 (none → "—")
│ Comment body (verbatim, exactly as it will post):
│ ----------------------------------------------------------------
<the rendered report, verbatim, including the trailing footer sentinel line>
│ ----------------------------------------------------------------
└─ [y] post · [n] skip · [e] edit the comment first

```

- **`y`** post now (one write) · **`n`** write nothing, the report still prints · **`e`** amend the
  comment, RE-RENDER this preview, ask again.
- If unsure → say `n` and take it to the Trio.
- **`--yes`** (advanced — non-interactive / scheduled cron only) skips the prompt but still honours
  any `--limit` and NEVER transitions. Interactive users ALWAYS get the gate.

---

## Sweep manifest (`--sweep "<JQL>"` — numbered, paged, selective apply)

`--sweep` runs the full pipeline over the matched set **in preview**, then prints a NUMBERED
manifest — one row per ticket. **No hard cap** — large sets warn + confirm, optional `--limit N`.

- If the JQL matches a large set (**> ~50**), print the match count and CONFIRM before running the
  research pipeline — it runs ONCE PER TICKET (warn on cost / time). `--limit N` bounds a run on
  purpose. NEVER refuse a big set outright.
- Present the manifest in readable PAGES (~20 rows/page). Select per page; `next` pages forward.

```

SWEEP PREVIEW · JQL: <the JQL> · matched 63 · page 1/4 (rows 1–20) · NO writes yet

# key verdict would post (one line) labels Δ

1 SSX-3610 ⛔ dup:HIGH of SSX-2988 — verify then Trio closes +dup:solved +next:to-trio
2 SSX-3620 ↪ route → Claims Home & Away (ICC) +route:other-team -route:ours
3 SSX-3533 ✅ accept → queue · relates SSX-3791 +intake:pm-screened +next:to-trio
…
20 SSX-3705 ↩ send back — DoR fail (acceptance criteria) +dor:gaps +next:to-reporter
Select: all · none/n · 1,2,5 · ranges 1-3,7 · accept-only · reject-only · next

````

- **`all`** post every row · **`none`/`n`** post nothing · **`1,2,5`** or **`1-3,7`** post only
  those · **`accept-only` / `reject-only`** convenience filters · **`next`** next page.
- Echo the chosen keys, post ONLY those (one write per selected ticket), then print a per-ticket
  result line: `✓ posted` / `✗ failed`.
- NEVER auto-transition — a selected REJECT posts report + labels only; it does NOT close the
  ticket. Steer non-technical operators to single-ticket mode for anything they must read carefully.

---

## HTML roll-up dashboard (`intake-dashboard-*.html` — always written after a run)

After EVERY run (single ticket, `--sweep`, raw text, or `--no-write`) the skill also writes ONE
self-contained HTML dashboard and prints its path in the run summary. It is a **local report, never a
Jira write** — no confirm gate. A single-ticket run renders a **one-row** dashboard; a sweep renders
the full table. It reflects the FINAL state (`posted` / `skipped` / `preview`), rendered from the same
dossier + scorecard data as the markdown.

**Rules**
- **Self-contained.** ONE `.html`, inline `<style>` + inline vanilla `<script>`, NO external/CDN
  assets — opens offline via `file://`. HTML-escape every ticket field.
- **Location.** `.claude/intake/intake-dashboard-<slug>.html` (`<slug>` = the KEY for a single ticket,
  or a JQL/project slug for a sweep). `--html <path>` overrides; `--no-html` suppresses.
- **Data island.** Embed the run as `<script id="intake-data" type="application/json">…</script>`; the
  inline JS builds the table from it (data and rendering stay separate; nothing to fetch).
- **Content parity, richer form.** The markdown stays plain; the HTML MAY use colour, sortable
  columns, a text filter, verdict filter chips, and an expandable per-ticket detail row (the full
  markdown scorecard + evidence + caveat). NEVER invent data the markdown/dossier lacks.
- **Header** — run mode (single/sweep), JQL or KEY, match count, vault freshness (`last_scanned`),
  generated-at, account; a one-line legend.
- **Summary strip** — counts per verdict (✅/⛔/↪/↩), dor:pass vs gaps, route:ours vs other-team,
  component assigned vs `comp:uncertain`.
- **Columns** — `# · Key (Jira link) · Title · Type · Verdict · Ours?(route) · Component · DoR ·
  Dev-lens (blast + top Q) · Dup/related · → Next · Write status`.
- **Footer** — accuracy bounds (vault staleness · dedup two-sided · MCP visibility) + a "report only,
  reflects Jira state at generation — NOT a live view" note.

**Skeleton (fill `meta`, `rows`, and the footer text; keep the CSS/JS as-is):**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>intake-triage — <slug></title>
<style>
  :root{--acc:#0b6;--rej:#c33;--rte:#36c;--bak:#c80;--bg:#fafafa;--fg:#222;--mut:#777;--line:#e3e3e3}
  *{box-sizing:border-box} body{margin:0;font:14px/1.45 system-ui,Segoe UI,Roboto,sans-serif;color:var(--fg);background:var(--bg)}
  header{padding:16px 20px;border-bottom:1px solid var(--line);background:#fff}
  h1{font-size:16px;margin:0 0 4px} .meta{color:var(--mut);font-size:12px}
  .strip{display:flex;flex-wrap:wrap;gap:8px;padding:12px 20px}
  .chip{border:1px solid var(--line);border-radius:14px;padding:3px 10px;background:#fff;cursor:pointer;font-size:12px}
  .chip.on{background:#eef;border-color:#99f}
  .controls{padding:0 20px 12px} input[type=search]{width:280px;max-width:60vw;padding:6px 10px;border:1px solid var(--line);border-radius:6px}
  table{width:100%;border-collapse:collapse;background:#fff}
  th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
  th{position:sticky;top:0;background:#fff;cursor:pointer;user-select:none;font-size:12px;color:var(--mut)}
  tr.v-accept{border-left:4px solid var(--acc)} tr.v-reject{border-left:4px solid var(--rej)}
  tr.v-route{border-left:4px solid var(--rte)} tr.v-back{border-left:4px solid var(--bak)}
  .verb{font-weight:600} a{color:var(--rte)} tr.row{cursor:pointer}
  .detail{display:none;background:#fcfcfc} .detail.open{display:table-row}
  .detail pre{white-space:pre-wrap;margin:0;font:12px/1.5 ui-monospace,Menlo,monospace}
  footer{padding:14px 20px;color:var(--mut);font-size:12px;border-top:1px solid var(--line)}
</style>
</head>
<body>
<header>
  <h1>intake-triage roll-up · <slug></h1>
  <div class="meta" id="meta"><!-- mode · JQL/KEY · matched N · vault last_scanned · generated <ts> · account --></div>
</header>
<div class="strip" id="strip"></div>
<div class="controls"><input id="q" type="search" placeholder="filter by key, title, team, component…"></div>
<table id="tbl">
  <thead><tr>
    <th data-k="n">#</th><th data-k="key">Key</th><th data-k="title">Title</th><th data-k="type">Type</th>
    <th data-k="verdict">Verdict</th><th data-k="route">Ours?</th><th data-k="component">Component</th>
    <th data-k="dor">DoR</th><th data-k="dev">Dev lens</th><th data-k="dup">Dup/related</th>
    <th data-k="next">→ Next</th><th data-k="write">Write</th>
  </tr></thead>
  <tbody id="rows"></tbody>
</table>
<footer id="foot"><!-- accuracy bounds · report only, reflects Jira state at generation — not live --></footer>

<script id="intake-data" type="application/json">
{"meta":{"mode":"sweep","source":"<JQL or KEY>","matched":0,"vault":"<last_scanned>","generated":"<ts>","account":"<account>"},
 "rows":[
   {"n":1,"key":"SSX-0000","url":"https://storebrand.atlassian.net/browse/SSX-0000","title":"…","type":"Oppgave",
    "verdict":"accept","verb":"ACCEPT → queue","route":"route:ours · SSX · HIGH","component":"SSX Nettsalg",
    "dor":"pass","dev":"buy-insurance-web · blast LOW · per-request timeout?","dup":"none",
    "next":"queue · link SSX-0001 (relates-to)","write":"preview","report":"<full markdown scorecard>"}
 ],
 "footer":"Accuracy: vault = last scan · dedup cuts both ways (recall over NO/EN + false-duplicate) · JQL sees readable projects only. Report only — reflects Jira state at generation, not a live view."}
</script>
<script>
const G={accept:"✅",reject:"⛔",route:"↪",back:"↩"};
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const D=JSON.parse(document.getElementById("intake-data").textContent);
let rows=D.rows.slice(),sortK="n",asc=true,filt="",vf=new Set();
const rowsEl=document.getElementById("rows");
document.getElementById("meta").textContent=`${D.meta.mode} · ${D.meta.source} · matched ${D.meta.matched} · vault ${D.meta.vault} · generated ${D.meta.generated} · ${D.meta.account}`;
document.getElementById("foot").textContent=D.footer||"";
function draw(){
  rowsEl.innerHTML="";
  rows.filter(r=>(!vf.size||vf.has(r.verdict)) && (!filt||JSON.stringify(r).toLowerCase().includes(filt))).forEach(r=>{
    const tr=document.createElement("tr");tr.className="row v-"+r.verdict;
    tr.innerHTML=`<td>${r.n}</td><td><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.key)}</a></td>`+
      `<td>${esc(r.title)}</td><td>${esc(r.type)}</td><td class="verb">${G[r.verdict]||""} ${esc(r.verb)}</td>`+
      `<td>${esc(r.route)}</td><td>${esc(r.component)}</td><td>${esc(r.dor)}</td><td>${esc(r.dev)}</td>`+
      `<td>${esc(r.dup)}</td><td>${esc(r.next)}</td><td>${esc(r.write)}</td>`;
    const dt=document.createElement("tr");dt.className="detail";
    dt.innerHTML=`<td colspan="12"><pre>${esc(r.report)}</pre></td>`;
    tr.onclick=()=>dt.classList.toggle("open");
    rowsEl.append(tr,dt);
  });
}
document.querySelectorAll("th").forEach(th=>th.onclick=()=>{const k=th.dataset.k;asc=sortK===k?!asc:true;sortK=k;
  rows.sort((a,b)=>(a[k]>b[k]?1:a[k]<b[k]?-1:0)*(asc?1:-1));draw();});
document.getElementById("q").oninput=e=>{filt=e.target.value.toLowerCase();draw();};
const strip=document.getElementById("strip");
["accept","reject","route","back"].forEach(v=>{
  const n=D.rows.filter(r=>r.verdict===v).length;const c=document.createElement("span");
  c.className="chip";c.textContent=`${G[v]} ${v} ${n}`;
  c.onclick=()=>{c.classList.toggle("on");vf.has(v)?vf.delete(v):vf.add(v);draw();};
  strip.append(c);
});
draw();
</script>
</body>
</html>
````

> **Verdict keys** map 1:1 to the banner set: `accept`→✅ · `reject`→⛔ · `route`→↪ · `back`→↩. The
> `report` field is the VERBATIM markdown scorecard (rendered inside `<pre>`, HTML-escaped). `write`
> is `posted` / `skipped` / `preview` (preview = `--no-write` / raw text / gate not yet confirmed).
