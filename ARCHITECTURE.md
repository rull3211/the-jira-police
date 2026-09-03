# the-jira-police — architecture

A Node/TypeScript service that watches the SSX Jira board, runs Storebrand's `/intake-triage`
skill against every new ticket, and — when enabled — posts the verdict back to the ticket as a
comment plus labels.

```
new SSX ticket  →  discover  →  analyse  →  gate  →  post
                                    ↓
                            groomed/SSX-1234.md

labelled ticket →  solve queue  →  (plans a claim, makes none)
                                    ↓
                            groomed/solve-cycle.md
```

The AI step is not ours. `/intake-triage` is Jacob Biørn's skill; a human normally invokes it by
hand. This service automates the trigger, checks the result, and applies it.

Status: running end to end against production Jira. 532 tests, no build step, no deployment
target yet.

A **second queue** exists alongside grooming: tickets a triage assessment marked
`agent:solvable`, waiting to be fixed by an agent. It is read-only today — it selects the right
tickets and reports the exact label edit it _would_ make, and has no function capable of making
it. See §4 for the queue and §13 for what is deliberately unbuilt. Nothing runs it from the
daemon; `pnpm start` is the grooming loop only.

---

## 1. The governing constraint

**Two credentials, two jobs, and they never swap.**

|           | Credential                                                    | Used for                                                     | Never used for                         |
| --------- | ------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------- |
| Discovery | Jira REST (`JIRA_EMAIL` + `JIRA_AUTH`, HTTP Basic)            | Learning _which_ issues are new. Returns keys and metadata.  | Reading issue bodies. Any write, ever. |
| Grooming  | The Atlassian **MCP session** inside the storecode subprocess | Reading what is _in_ an issue, and writing the verdict back. | Discovery.                             |

This is not stylistic. It buys three things:

- **Attribution.** Every comment and label lands as a real Jira user, not a service account. If
  the bot says something wrong, a human can see who to ask.
- **Revocability.** Turning writes off is one setting (`WRITE_BACK=false`), not a token re-scope.
- **Least privilege, enforced in code.** `childEnv()` in `src/triage/runner.ts` strips `/^JIRA_/`
  from the subprocess environment. The grooming half is not _asked_ to avoid the REST credential;
  it is not given it. There is a test asserting the absence.

Consequence worth knowing before you change anything: **nothing in this repo may add a REST write
path.** A second way to mutate a ticket would be a second way to mutate it unchecked.

---

## 2. Runtime shape

```
                      ┌──────────────────────────────────────────┐
   Jira REST          │  index.ts — daemon                       │
   /search/jql   ◄────┤    loop.ts     when to poll, backoff     │
   (discovery only)   │    poller.ts   one cycle                 │
                      │    store.ts    cursor + seen keys        │
                      └──────────────┬───────────────────────────┘
                                     │ one TicketRef → one groom
                      ┌──────────────▼───────────────────────────┐
                      │  wiring.ts — createGroom()               │
                      │                                          │
                      │   1. runTriage()   analyst   ~3 min      │
                      │        storecode -p "/intake-triage KEY  │
                      │        --no-write"  → structured_output  │
                      │                                          │
                      │   2. assertPostable()  gate  ~0 ms       │
                      │        throws → nothing was sent         │
                      │                                          │
                      │   3. runPost()     poster    ~30 s       │
                      │        a second storecode session that   │
                      │        holds the finished text           │
                      └──────────────┬───────────────────────────┘
                                     │
                 groomed/SSX-1234.md │  and, if WRITE_BACK, the Jira issue
```

Both subprocesses go through `src/triage/session.ts`, which owns everything easy to get subtly
wrong: line-buffered NDJSON parsing, a timeout that _kills the child_ rather than merely
rejecting, the MCP connectivity check, and the rule that exit 0 without structured output is a
failure rather than an empty success.

---

## 3. Why grooming is three steps

It used to be one: a single write-enabled session per ticket.

That design cannot be checked. The skill posts its comment **mid-run**, but `structured_output` —
the only thing this service can inspect — arrives with the terminal result event. So every check
we could write was a post-mortem. On **SSX-3822** the run wrote _"baseline `[N]` left unfilled"_
into its own scorecard, marked the row green, and emitted `dor:pass` + `ready-ish`. The
contradiction was detectable. It was also already on the board.

Splitting the run puts the check in the middle, where refusal still costs nothing but a retry.

### analyse — `src/triage/runner.ts`

Always `--no-write`. No write tool in the allowlist. The prompt says dry-run and the permission
layer enforces it: _the belt is a sentence the model could misread, the braces are a check it
cannot._

`--no-write` is a **pure** dry-run in the skill's own words — it still renders the full §11
mutation payload, it just declines to send it. The JSON schema (`src/triage/schema.ts`) asks only
that this render be machine-readable. Nothing new is demanded of the skill; the preview becomes
data instead of prose.

Two fields carry the weight:

- **`mutation`** — the exact §11 payload: comment body, label delta, component, links, and whether
  the comment is a create or an update. This is what makes _the thing checked_ and _the thing
  posted_ the same object.
- **`dorPlaceholders`** — literal unfilled placeholders still in the ticket (`[N]`, `[TBD]`,
  `<beløp>`). Lets the DoR contradiction be read off a field instead of inferred from prose.

The label field is a **delta, not a final set**. §11 requires the write to union against whatever
is live on the issue and forbids "a bare replacement array". A finished set would silently revert
any human label edit made between analysis and post — a three-minute gap. A delta survives it,
because it is applied rather than imposed.

### gate — `src/triage/gate.ts`

`assertPostable(payload, issueKey)`. Purely mechanical: every rule is one `INTAKE_INSTRUCTIONS.md`
states as an absolute, so it can be enforced by comparison. **This gate cannot tell you a verdict
is wrong** — only that it contradicts itself or breaks a rule the skill set for itself.

Current rules:

| Check             | Rule                                                                                                                                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DoR coherence     | `dorPlaceholders` non-empty ⇒ no `dor:pass` label, no `ready-ish` verdict                                                                                                                                                                |
| Comment non-empty | An empty body short-circuits; the follow-on complaints would bury it                                                                                                                                                                     |
| Footer sentinel   | Body must end with `_🤖 Generated by intake-triage · re-run the command to refresh._` — the skill recognises its own prior comment by this, so a body without it can be posted but never _updated_, and every re-run stacks another copy |
| Key pairing       | Body must mention the issue key. The poster is handed text it did not write; this is the only place body-to-key is checked                                                                                                               |
| Owned namespaces  | `labelsRemove` may only touch `route:` `dup:` `dor:` `tier:` `intake:` `next:` `agent:`                                                                                                                                                  |
| Owned `agent:`    | Narrower than the namespace: neither half of the delta may touch any `agent:` label except `agent:solvable`                                                                                                                              |
| Delta agreement   | Every `labelsAdd` entry must also appear in the verdict's own `labels`                                                                                                                                                                   |
| `dor:pass` delta  | `labelsAdd` may not apply `dor:pass` while placeholders remain                                                                                                                                                                           |
| Component         | Must be empty or one of the four policy streams                                                                                                                                                                                          |
| Agent fitness     | `agentFitness.solvable` ⇒ verdict is `ready-ish`, no blockers listed, a repo named, and `agent:solvable` present in `labels`; and the label may not appear without the field                                                             |

Every violation is collected, not just the first. A run costs real money; sending the operator
round the loop once per problem would be miserly with the wrong resource.

**The lesson embedded in these rules.** Two false positives were found while building this, and
both came from the same mistake: reading **prose** instead of **structured fields**. An early
version refused any comment body containing the string `dor:pass` while placeholders remained. It
blocked the _correction_ to SSX-3822 — a send-back whose entire purpose was to repudiate a wrongly
applied `dor:pass`, which it therefore had to name in order to reverse.

> Applying a label is an assertion. Mentioning it is not. Read the delta.

A gate whose false positives cluster on corrective runs is worse than no gate: it blocks exactly
the runs repairing the damage. The test for any future rule is _can it distinguish asserting a
thing from mentioning it?_

**The agent-fitness rules are that lesson applied twice over.** `agentFitness` (`schema.ts`) is
triage's estimate of whether a coding agent could fix the ticket unattended; when it says yes, the
label `agent:solvable` goes on the board and a future solver acts on it.

- The label rule reads `labels`, **never `labelsAdd`**. The delta holds only labels not already on
  the issue, so the second run over an already-marked ticket legitimately omits it. Keying on the
  delta would reproduce the withdrawn prose check exactly: quiet on first runs, noisy on re-runs.
- `solvable ⇒ ready-ish` is not a new restriction, it is three existing ones meeting. Only
  `ready-ish` has passed DoR; DoR passing means acceptance criteria concrete enough to test
  against; and the skill's dev lens — repo, blast radius, file, technique, rejected alternative —
  is only emitted on ACCEPT, and is most of the evidence a fitness call rests on. A `dor:gaps`
  ticket is therefore never agent-solvable, which is the same fact stated a fourth way.
- The field **fails closed everywhere**: it is absent from the schema's `required` list, and
  `parseAgentFitness` reads a missing object, a malformed one, or a truthy-but-not-`true` value all
  as `solvable: false`. A wrong `false` costs a human triaging a ticket they were triaging anyway.
  A wrong `true` costs an unasked-for pull request.

One rule in the table is a security boundary rather than a coherence check. Triage owns
`agent:solvable` and nothing else in the namespace: `agent:start` is a human's authorisation for a
bot to attempt a fix. The analyst's entire input is a Jira ticket, and a ticket is written by
whoever felt like writing one — so if the skill could emit `agent:start`, a ticket body could ask
it to, and the human approval step would be one the bot performs for itself. The solver's own
`agent:solving` / `agent:done` / `agent:failed` are excluded for a different reason: the solve
queue has no local cursor, and its idempotency rests entirely on those labels having one writer.

### post — `src/triage/poster.ts`

A second storecode session, arranged to stop it thinking:

- **Not given the skill.** The prompt is a direct imperative checklist. There is no
  `/intake-triage` to re-enter and no second opinion to form.
- **Not given the research tools.** No vault, no Confluence, no `Grep`/`Glob`, no `search`. It
  could not redo the duplicate hunt if it wanted to.
- **Told twice** not to edit the comment text, which arrives verbatim between markers.
- **No `transitionJiraIssue`.** The skill promises never to change status; withholding the tool
  turns that promise into something the service enforces rather than trusts.

It is not _blind_, though — that would break §11. It gets `getJiraIssue` (current labels to union
against, existing comments to match the sentinel), `atlassianUserInfo` ("which comment is mine")
and `getIssueLinkTypes`. The guarantee is not "it cannot see the ticket" but **"it has the finished
text and no means of researching an alternative."**

The receipt it returns is deliberately small — `commentAction`, `labelsWritten`, `linksCreated`,
`problems` — because every extra required field is another way for the run to fail _after_ the
writes have landed. `problems` is logged loudly but does **not** throw: the writes already
happened, so retrying redoes work that partly succeeded. `commentAction: "skipped"` _does_ throw —
that is the run reporting it did nothing.

---

## 4. Discovery

`src/jira/jql.ts` → `src/jira/client.ts` → `src/poller.ts`.

**Relative window, not an absolute cursor.** The query is `created >= -137m`, computed from the
stored cursor, never `created > "<timestamp>"`. Absolute dates in JQL resolve in the **server's**
timezone, not ours — a durable source of off-by-hours bugs. A relative offset has no timezone to
get wrong.

**The window overlaps on purpose.** Jira's date filters are _minute_-precision, so a strict cursor
drops anything created in the same minute as the last issue seen. `CURSOR_OVERLAP_MS` (default 2
min) re-scans, `lookbackMinutes` rounds **up**, and key-level dedupe is what makes the overlap
free. The dedupe is mandatory, not an optimisation.

**JQL has no parameter binding**, so every interpolated value is validated rather than escaped.
`jqlValue()` also encodes a real Jira subtlety: a bare number is resolved as an **id**, anything
quoted as a **name**. `component = 12644` finds the component; `component = "12644"` searches for
a component _named_ "12644" and finds nothing.

**Ordering compares instants, not strings.** Jira returns `created` with a numeric offset
(`2026-09-02T09:55:34.178+0200`), not `Z`. A lexicographic sort orders `02:00+0100` (01:00Z) before
`02:30+0200` (00:30Z) — backwards — and the cursor would advance past the earlier ticket and drop
it permanently. This bug was live and would have fired once a year at the DST rollover. Ties break
on issue key so the resume point is deterministic; an unparseable timestamp throws rather than
letting `NaN` scramble the order.

### The solve queue — a second, stateless discovery path

`src/solve/` + `buildSolveQueueJql` / `buildInFlightJql`. Selects tickets waiting to be **fixed**
rather than groomed. It shares the JQL helpers with the above and nothing else, because the two
queries disagree about the only thing that matters: the first selects on **time**, the second on
**label state**.

|         | new-issue poller  | solve queue                    |
| ------- | ----------------- | ------------------------------ |
| Selects | `created >= -Nm`  | labels                         |
| Cursor  | `state/poll.json` | **none**                       |
| Dedupe  | local `seenKeys`  | **ticket label state in Jira** |
| Run by  | the daemon        | `pnpm solve:once`, by hand     |

**It cannot reuse the first poller.** `isUnseen` (`src/state/store.ts:92`) checks a permanent seen
list, so a ticket triaged in March could never re-enter — but a ticket labelled for solving in
September must. The queue is a _state_, not a window: running it twice reports the same tickets
twice, and that repetition is the queue working.

**Dedupe lives in Jira, not on disk**, so the queue survives a restart, a wiped `state/` and a
second instance with no lock file. The claim is a label transition on the ticket itself.

**`labels NOT IN (...)` also excludes issues whose label field is empty**, which is why the
positive `labels = "agent:solvable"` clause is load-bearing rather than decorative. Measured on
this board 2026-09-03 rather than taken on trust: 57 unlabelled issues, **0** of which survive the
clause; 46 `triaged` issues, all 46 surviving it. Numbers are in the `jql.ts` doc comment.

**The concurrency bound needs its own query.** The queue excludes `agent:solving` by design, so
the tickets counting against `MAX_CONCURRENT_SOLVES` are precisely the ones the queue cannot see;
a bound computed from the queue result would cap claims _per cycle_ and let the next tick start
another. `buildInFlightJql` deliberately omits `statusCategory != Done` — a solve whose ticket
someone closed mid-run is still in flight, and **undercounting** a concurrency limit is the
failure that lets a second claim through. Over-counting only causes waiting.

**The target repository is read from the ticket, not carried alongside it.** `repoFromLabels`
reads the existing `svc:<repo>` convention that triage already writes. Every ambiguous reading —
no `svc:` label, two of them, `impl-uncertain` present, or a name failing
`/^[A-Za-z0-9][A-Za-z0-9._-]*$/` — resolves to `null` and the ticket is **skipped, not failed**,
so widening `SOLVE_REPOS` picks it up later with no manual reset. The label proposes; the
allowlist decides. An earlier pattern accepted `..`, the one string guaranteed to escape any
directory it is joined to.

**Nothing here can change anything.** `SolveDeps` has two dependencies and both are readers. The
refusal is structural rather than promised: granting it means changing that interface, which is
where a reviewer looks. See §13.

The one thing a cycle emits is `groomed/solve-cycle.md` — the configuration it ran under, both
queries verbatim, and every candidate with the decision made about it and the labels that
decision was made from. The phase is dry so its picks can be judged before anything acts on
them, and judging needs something that outlives stdout. It is deliberately **not** a section
appended to `groomed/<KEY>.md`: `FileSink` rewrites those wholesale on the next triage, so such a
section would disappear at a moment having nothing to do with the solve queue. Same reasoning
that gives refusals their own `.rejected.md`. Ticket text reaches this file, so summaries and
skip reasons are collapsed to one line — a summary containing a newline and a `## PLAN — SSX-9999`
would otherwise forge a decision in the one document an operator reads to find out what was
decided.

---

## 5. State and the correctness rules

`state/poll.json` — a cursor and a bounded set of seen keys, written via temp-file + rename so a
crash mid-write cannot leave truncated state. Both halves are needed: the cursor bounds the
window, the key set is what actually prevents duplicate paid runs.

Three rules drive the shape of `runPollCycle`:

1. **An issue is recorded as seen only after its report is safely written.** Marking it earlier
   means a transient sink failure drops the ticket for good.
2. **The cursor advances only across an unbroken run of successes from the oldest issue forward.**
   If #3 fails but #4 succeeds, advancing to #4 strands #3 outside the next window. Stopping at
   the gap costs a little rework and loses nothing.
3. **State is persisted after every issue, not once per cycle.** Each triage is a paid model run;
   per-cycle saving made the cost of an ill-timed kill proportional to the backlog. Per-issue
   saving caps it at one.

The shutdown signal is checked **between issues**, not only between cycles. A cycle with a backlog
runs one multi-minute subprocess per issue, sequentially — "finish the current cycle" could mean
several more minutes and several more paid runs after the operator asked it to stop, which reads
as a hang.

---

## 6. The subprocess contract

Every flag below was verified against the local arg parser rather than assumed.

```bash
storecode -p "/intake-triage SSX-1234 --no-write --no-html" \
  --output-format stream-json --verbose \
  --permission-mode dontAsk \
  --allowedTools "<explicit list>" \
  --add-dir "<vault>" \
  --json-schema '<inline draft-07>'
```

- **`stream-json`, not `json`** — the MCP status guard needs the `system`/`init` event, which only
  the streaming format emits. Requires `--verbose`.
- **`--json-schema` takes inline JSON, not a path.** A path is rejected with
  `not valid JSON: Unrecognized token '/'`.
- **`dontAsk`, not `acceptEdits`** — `acceptEdits` does not auto-approve MCP tool calls, so a run
  would stall waiting for input that never arrives. `bypassPermissions` would work but disables
  the safety hooks, which is not a trade worth making for a background job.
- **MCP failure is silent, so it is checked explicitly.** With the Atlassian OAuth session expired
  the run still **exits 0** — it simply reports it could not read the issue, and that failure is
  indistinguishable from a real verdict downstream. `assertMcpReady()` inspects per-server status
  on the init event and kills the child before a turn is spent. This is the single most likely
  production bug in the service.
- **The vault reaches the skill two ways, and neither is the skill's `--vault` flag.** As
  `$INSURANCE_VAULT` (the skill's own second resolution step, so it never hits the "STOP and ask
  the user" branch a headless run cannot answer) and as `--add-dir` (the vault is a _sibling_ of
  this repo, so `Read` otherwise has no business there). A flag value would have to survive the
  model parsing it out of a prompt string; an environment variable does not.
- **`CLAUDE_SKIP_HOOKS` is stripped from the child.** It is undocumented and the two plausible
  readings disagree about the value this file used to set. Removing it is correct under both, so
  the ambiguity does not need resolving.

Parsing is **lenient in the runner, strict in the gate**. A missing comment body becomes `""`,
which `assertPostable` then refuses by name. Rejecting twice in two places with two different
messages would only make the failure harder to read. The exception is issue links: an unknown link
type is **dropped, not coerced**, because `duplicates` is the one that invites a human to close a
ticket. A dropped link costs a re-run; a wrong one costs somebody's ticket.

---

## 7. Module map

| Path                    | Role                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/index.ts`          | Daemon entry point. Signal handling, `--skill` / `--interval` / `--for` overrides                       |
| `src/loop.ts`           | Scheduling shell: interval, exponential backoff to a 15-min cap, interruptible sleep                    |
| `src/poller.ts`         | One cycle. Ordering, dedupe, failure isolation, the three rules above                                   |
| `src/wiring.ts`         | **The composition.** `createDiscover`, `createGroom`, `shouldPost`, `createPollDeps`, `createSolveDeps` |
| `src/settings.ts`       | Declarative settings table + generic reader, with a `sensitive` marker                                  |
| `src/jira/jql.ts`       | Query builders — new-issue, solve queue, in-flight. Validation, id-vs-name quoting                      |
| `src/solve/labels.ts`   | The `agent:` state machine as pure functions; `repoFromLabels`                                          |
| `src/solve/poller.ts`   | One solve cycle. **Dry run only** — plans the claim, cannot make it                                     |
| `src/solve/report.ts`   | The cycle as `groomed/solve-cycle.md`, so a dry phase can be judged after the fact                      |
| `src/cli/solve-once.ts` | One solve cycle and exit. No `--dry-run` flag, because there is no other mode                           |
| `src/jira/client.ts`    | `/rest/api/3/search/jql`, token pagination, Basic auth                                                  |
| `src/jira/types.ts`     | The slice of the Jira payload actually read, plus `TicketRef`                                           |
| `src/state/store.ts`    | Cursor + seen keys, atomic write                                                                        |
| `src/triage/schema.ts`  | The draft-07 contract handed to the analyst. Descriptions double as instructions                        |
| `src/triage/session.ts` | Shared subprocess machinery for both runs                                                               |
| `src/triage/runner.ts`  | The analyst                                                                                             |
| `src/triage/gate.ts`    | The check                                                                                               |
| `src/triage/poster.ts`  | The writer                                                                                              |
| `src/output/sink.ts`    | `FileSink` (reports) and the rejection artifacts                                                        |
| `src/output/canvas.ts`  | Slack canvas payload builders — **built, never called** (§10)                                           |
| `src/logger.ts`         | JSON lines to stdout/stderr; `console` is banned by lint                                                |
| `src/duration.ts`       | `30s` / `4m` / `1.5h` for CLI flags                                                                     |

`wiring.ts` exists because there are three entry points — the daemon, `poll:once` and
`triage:once` — and a difference in how they wire the same pipeline would be a bug that only shows
up in production. `triage:once` used to build its options by hand; the copy drifted the moment the
real skill grew requirements.

---

## 8. Refusals are artifacts

When the gate throws, `createGroom` writes `groomed/<KEY>.rejected.md` before re-throwing: the
violations, the verdict, the labels, the placeholders, and **the comment body it objected to**.

A throw carries only its message. Without the artifact, the one thing an operator needs to decide
whether a refusal was _correct_ is destroyed at the moment it becomes interesting. That matters
more than it sounds — these checks are heuristics, and **a heuristic you cannot audit is one you
end up switching off out of frustration.** Both false positives in §3 were diagnosed from these
files.

A later run that passes the gate calls `clearRejection` first, so a stale refusal never sits next
to a fresh report for the same key claiming both are current.

### The same rule applies to what the gate lets through

`agentFitness` shipped one run before this was noticed. It was parsed, gated by five rules, and
then dropped on the floor: `TriageResult` stopped at `report`, so the assessment reached neither
the artifact nor the log line. The only surviving trace on disk was whether `agent:solvable`
appeared in `labels` — the conclusion with the reasoning stripped off.

That is a bad way to fail, because the entire argument for Phase A was that the assessment costs
nothing extra per run and **tells you how often the fitness call is right before anything acts on
it.** A yes/no with no rationale, confidence or blockers cannot be marked wrong, so a calibration
period reading those artifacts would have measured nothing while looking like it was working.

`TriageResult.agentFitness` is therefore required rather than optional. Both construction sites
(`toTriageResult`, `triage-once`) already hold the payload, so nothing is burdened by it, and
optional would only have re-created the hole one caller at a time. The generalisation, which is
§8 pointed the other way: **an artifact must record the judgements that were made, not only the
ones that were refused.** A gate you cannot audit gets switched off; an assessment you cannot
audit gets trusted, which is worse.

---

## 9. Failure model

| What breaks                       | What happens                                                                                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| One ticket's triage throws        | Key stays unrecorded, cursor stays behind it, next cycle retries. Nothing is written locally either — an incoherent verdict is not a partial result |
| The gate refuses                  | Nothing posted. Rejection artifact written. Same retry path                                                                                         |
| The poster reports `problems`     | Logged as an error, **not** thrown. Writes already landed; retrying redoes partial work                                                             |
| The poster reports `skipped`      | Throws. It did nothing, so a retry is right                                                                                                         |
| Atlassian MCP not connected       | Child killed on the init event, before a turn is spent. **Fired for real on 2026-09-03** — expired OAuth session, status `pending`; see below       |
| A run exceeds `TRIAGE_TIMEOUT_MS` | Child `SIGKILL`ed, run rejected                                                                                                                     |
| Jira down / credential expired    | Reaches `runLoop`, which backs off exponentially to a 15-min cap. Uncapped backoff would make the service indistinguishable from a dead one         |
| SIGINT / SIGTERM                  | Current issue finishes, then stop. A second signal exits 130 immediately                                                                            |
| Config missing                    | Every missing setting reported at once, exit 78 (`EX_CONFIG`), no stack trace                                                                       |

Retries are safe because the comment is idempotent on its footer sentinel: a re-run **updates in
place** rather than stacking a second copy. That is why the sentinel is a gate rule and not a
nicety.

**The MCP guard has now met reality**, on 2026-09-03, and by exactly the cause it was written for:
the Atlassian OAuth session had expired. The init event reported `pending`, `assertMcpReady`
refused, and the child was killed before a turn was spent. Without it the run would have exited 0
with a verdict formed without the ticket ever being read.

Two things about this are worth more than the incident:

**`storecode mcp list` is not a reliable oracle, and it misdiagnoses in the dangerous direction.**
It reported `⏸ Pending approval (run 'claude' to approve)` both before the re-auth and _after_ it,
while a real subprocess was connecting fine. Its own health check runs in a context that cannot
approve, so it reports an approval problem where the actual problem was authentication. Read the
init event instead — that is what the run itself sees:

```
storecode -p "reply with the single word ok" --output-format stream-json --verbose \
  --permission-mode dontAsk --allowedTools "" | head -1
→ atlassian: connected
```

**Recovery is a human step, and this is a deployment blocker rather than a footnote.** The token is
refreshed by running `/mcp` in an interactive session. A headless run cannot do it, and should not
be able to. So a long-running daemon will stop being able to read Jira every time the session
expires, and will keep refusing — correctly, loudly, and until a person intervenes. Any deployment
story has to answer that: at minimum an alert on `McpUnavailableError` rather than a silent retry
loop, because backoff makes an expired token look exactly like a Jira outage.

---

## 10. Configuration

`.env`, read via `node --env-file-if-exists`. Every setting is declared once in `src/settings.ts`;
`describeSettings()` masks the sensitive ones so the startup dump is safe to paste.

| Setting                      | Default                            | Notes                                                                                                                                                  |
| ---------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `JIRA_BASE_URL`              | `https://storebrand.atlassian.net` |                                                                                                                                                        |
| `JIRA_EMAIL`                 | —                                  | **required**                                                                                                                                           |
| `JIRA_AUTH`                  | —                                  | **required**, sensitive, discovery only                                                                                                                |
| `JIRA_PROJECT`               | `SSX`                              |                                                                                                                                                        |
| `JIRA_COMPONENTS`            | `SSX Advisor`                      | The SSX board is shared by several teams; this is what keeps the service off other teams' tickets                                                      |
| `JIRA_EXCLUDED_TYPES`        | `10009`                            | Deloppgave / sub-task — arrives attached to a parent already triaged                                                                                   |
| `POLL_INTERVAL_MS`           | `300000`                           |                                                                                                                                                        |
| `CURSOR_OVERLAP_MS`          | `120000`                           | See §4                                                                                                                                                 |
| `FIRST_RUN_LOOKBACK_MINUTES` | `60`                               | Deliberately short — a wide first window means one paid run per historical issue                                                                       |
| `SKILL_NAME`                 | `mock-triage`                      | **Defaults to the mock**, so an unconfigured service cannot post real verdicts                                                                         |
| `VAULT_PATH`                 | —                                  | Required for the real skill; checked at wiring time, not first-ticket time                                                                             |
| `WRITE_BACK`                 | `false`                            | The only setting whose effect the whole team can see. Strict `"true"` — a typo fails closed                                                            |
| `TRIAGE_TIMEOUT_MS`          | `600000`                           |                                                                                                                                                        |
| `OUTPUT_DIR` / `STATE_PATH`  | `groomed` / `state/poll.json`      | Both gitignored                                                                                                                                        |
| `SOLVE_ENABLED`              | `false`                            | Master switch for the solve queue. Strict `"true"`. Checked at composition _and_ in the poller                                                         |
| `SOLVE_MODE`                 | `manual`                           | `manual` also requires `agent:start`, the single human step. An unrecognised value is a **startup error**, not a fallback                              |
| `SOLVE_AUTO_ISSUE_TYPES`     | `Feil`                             | Auto mode only. Not `Bug` — **this board is Norwegian**, and an English default would match nothing and make autosolve look enabled while never firing |
| `SOLVE_REPOS`                | — (**no fallback**)                | Repository allowlist. The only solve setting without a default, deliberately: see §14.10                                                               |
| `MAX_CONCURRENT_SOLVES`      | `1`                                | Counted from the board via `buildInFlightJql`, never from local state                                                                                  |
| `MAX_REVIEW_ITERATIONS`      | `3`                                | Unused until Phase D                                                                                                                                   |

Commands:

```bash
pnpm start --interval 20s          # the daemon — grooming only, never the solve queue
pnpm dev                           # daemon, --watch
pnpm poll:once --dry-run           # discovery only; free, and the fastest config check
pnpm poll:once                     # one full cycle
pnpm triage:once SSX-1234 [--write]
pnpm solve:once                    # one solve cycle; reads the board, changes nothing
pnpm check-types && pnpm lint && pnpm test
```

Note the script is **`check-types`**, not `typecheck`.

---

## 11. Test doubles and the testing rule

Two stand-in skills live in `.claude/skills/`, and between them they are the reason any of this
could be tested before the real skill was available:

- **`mock-triage`** — derives its verdict from the issue key, reads nothing, calls no tools.
  Exercises the whole pipeline with no Jira and no vault.
- **`live-triage-probe`** — reads **one real ticket** over MCP and nothing else. Covers exactly
  what the mock cannot: the MCP session _inside the spawned subprocess_ and the real tool
  allowlist.

Neither ever writes. `shouldPost()` pins both to preview regardless of `WRITE_BACK` — a rehearsal
that comments on a real ticket is not a rehearsal.

**The rule this codebase enforces on itself:**

> A guard is not shipped until a test fails when it is unplugged.

It is written down because it has been violated twice. Deleting `assertPostable` from
`createGroom` once left all 264 tests green: the gate was thoroughly unit-tested and called by
nothing that anything asserted on. `src/wiring.groom.test.ts` exists to close that hole, and
asserts the **order** — analyse, then gate, then post — directly rather than inferring it from the
absence of a call.

A second rule, learned from a green suite that shipped the DST bug: **fixtures that agree with
each other can still disagree with reality.** Every timestamp fixture used `Z`; real Jira does
not. At least one fixture in `poller.test.ts` is now copied verbatim out of a real API response,
with a note saying where it came from.

---

## 12. Local divergence from upstream

`.claude/skills/intake-triage/` is vendored from Jacob's `backlog-governance`. **Two local
changes**, both to §11's label-reconciliation list and both flagged in the file itself:

1. **`next:*`.** Skill vocabulary — the same file defines
   `next:to-trio | next:to-reporter | next:to-other-team | next:needs-techlead` — and no human sets
   it, but its omission meant a ticket re-triaged from "send to the Trio" to "send back to the
   reporter" kept the stale `next:to-trio` sitting beside its own contradiction.
2. **`agent:solvable`**, and note it is listed as a single label rather than as `agent:*`. The rest
   of the namespace is not the skill's: see the security boundary in §3. This is the first
   namespace shared with a writer other than the skill, so the list is narrower than a prefix.

The gate's `OWNED_LABEL_NAMESPACES` must **match §11 exactly, not be a superset**. A gate looser
than the contract it enforces has a hole in it. Widen it only by widening §11 first — and tell
Jacob, because neither divergence is upstream yet.

`agent:` is the one entry where the namespace list alone is looser than §11, so it carries a second
check (`TRIAGE_OWNED_AGENT_LABELS`) rather than being expressed as a prefix. If a future namespace
is likewise only partly owned, copy that shape rather than widening the prefix list.

---

## 13. Not built

- **The Slack canvas sink.** `src/output/canvas.ts` renders the markdown and builds the
  `canvases.edit` request bodies, all unit-tested. There is no HTTP call, no token handling and no
  `OutputSink` implementation — **nothing has ever been sent to Slack.** Blocked on canvas write
  access and an Enterprise Grid app install, both human-gated. Constraints already researched and
  encoded in that module's header: one operation per call, markdown must end with `\n`, no
  "append to list X", section ids are unstable and must be re-looked-up every edit.
- **Cost telemetry.** `total_cost_usd`, `usage` and `num_turns` are in the stream and never read.
  A trivial mock run measured **$0.11** on `claude-opus-5`; a real triage reads the ticket,
  searches for duplicates and consults the vault, so it is several times that. At ~4–5 tickets/day
  the floor is real money. This blocks the "should triage run on a cheaper model?" decision.
- **`--max-budget-usd` / `--max-turns` / per-job `--session-id`.**
- **Deployment.** No launchd job, no container, no metrics. `pnpm start` in a terminal is the
  current answer.
- **Concurrency.** Issues are triaged sequentially. Fine at 4–5/day.
- **`AND statusCategory != Done`** in the JQL — closed tickets currently get triaged. Small in
  steady state, not small on a first-run backfill. A question of intent, so it is open.
- **Unproven paths.** REST pagination and REST error handling (401/429/5xx) are unit-tested only;
  the live board has returned a single clean page every time.

### The solve feature, from the claim onward

Everything that _selects_ a ticket is built and was verified against the live board on
2026-09-03. Everything that _changes_ anything is not.

- **The claim write.** The queue reports the edit (`+agent:solving` / `-agent:start`) and cannot
  perform it. This is the next increment, and it is what makes the queue's dedupe testable at
  all — _claim one ticket, confirm a second `solve:once` picks nothing up, release it_ is the
  experiment, and it needs a write to run.
- **The solver itself** — worktree isolation, read-only recon, the diff-bounds gate, mechanical
  (not model-asserted) verification. No component in this service has ever held `Write`, `Edit`
  or `Bash`.
- **Delivery** — draft PR, Copilot review, iterate, undraft. `MAX_REVIEW_ITERATIONS` exists and
  is read by nothing.
- **Running it from the daemon, and this one is deliberately *last*.** Not wired into `index.ts`;
  `pnpm start` is the grooming loop and must stay that way until everything above has been driven
  by hand. The property the daemon adds is *nobody is watching*, which is the last property you
  want to add rather than an early one: every phase before it can be verified by a person typing
  a command and reading the output, and wiring the loop converts all of them at once into things
  that happen on a timer whether or not anyone looks. It also adds no capability — by then the
  bot can already do everything, and the daemon only changes who asks. Still needs its own slower
  cadence and a decision about what a solve failure does to `loop.ts` backoff: a failed solve is
  not the same event as a Jira outage, and the backoff only understands the latter.

  The corollary is the rule to hold the line on: **a ticket claimed, solved and PR'd by hand is a
  demonstration; the same sequence on a five-minute timer is a deployment.**

Each phase is expected to ship two hand-operated commands before it counts as done — a dry run
that reports what it *would* change, and a single run against one named ticket, chosen by the
operator rather than by the queue. `triage:once SSX-1234 [--write]` is the shape being copied.
`solve:once` grows one flag per phase (`--claim`, `--solve`, `--pr`), each implying the ones
before it, so the command line reads as the privilege escalation it is.
- **Two probes that gate the above and have not been run:** whether `Bash(pnpm test:*)` scoping
  is honoured by the local arg parser (if not, Phase C changes shape — the harness runs the
  commands and the model gets no `Bash` at all), and whether `gh pr edit --add-reviewer @copilot`
  works for this org. Cost of a solve run is also unmeasured; a triage is $0.11 and a solve is a
  different order of magnitude.

---

## 14. Invariants

Things that look like details and are not:

1. **`erasableSyntaxOnly: true` stays** while there is no build step. Node runs these files by
   stripping types, never compiling them, so parameter properties, enums and namespaces typecheck
   fine and then crash at startup. This bit twice for real before the flag went on.
2. **The analyst never gets a write tool**, and there is no `--yes` path. A second way to post
   would be a second way to post unchecked.
3. **The REST credential never leaves discovery.** `childEnv` is the enforcement; the test
   asserting its absence is the proof.
4. **The gate reads structured fields, never prose.** See §3.
5. **Labels are a delta, unioned against live** — never a replacement array.
6. **The footer sentinel is verbatim and load-bearing.** Change it and every existing comment
   becomes unrecognisable to its own skill, so re-runs stack instead of refresh.
7. **`SKILL_NAME` defaults to the mock.** An unconfigured service must not be able to post.
8. **Anything that grants privilege fails closed.** `agentFitness` is optional in the schema and
   every ambiguity in `parseAgentFitness` — absent, malformed, truthy-but-not-`true` — resolves to
   `solvable: false`. Silence is a refusal, never a default yes.
9. **Triage cannot authorise its own downstream work.** It may set `agent:solvable`; `agent:start`
   belongs to a human and the rest of the `agent:` namespace to the solver. Its only input is
   attacker-controlled ticket text, so this is a boundary rather than a convention.
10. **A privilege allowlist gets no default.** `readSettings` substitutes the fallback whenever a
    value is missing _or blank_ (`settings.ts:209`) — the two are indistinguishable to it. So a
    default on `SOLVE_REPOS` would be a write privilege that survives being deleted from `.env`:
    an operator emptying the allowlist to take the solver off a repository would have it handed
    straight back, revocable only by editing source. It is the one solve setting with no
    fallback, and unset means nothing is allowed. The same reasoning applies to anything future
    that names what may be written to. Note this cuts the opposite way from
    `SOLVE_AUTO_ISSUE_TYPES`, where the fallback _is_ the restriction — the test to apply is not
    "does it have a default" but "does silence widen or narrow what the service may touch."
11. **Every label write is read-modify-write, and must be verified after the fact.** The
    available write path — MCP `editJiraIssue` — exposes only `fields`, never Jira's
    `update.labels.add`/`remove`. There is no compare-and-swap and no way to touch one label in
    isolation: the whole field is replaced. Two consequences. Concurrent claims cannot be
    prevented, only made unlikely (`MAX_CONCURRENT_SOLVES=1`, one host). And any label added by
    anyone between the read and the write is silently dropped — a PM adding `next:to-trio` while
    a solve claims the ticket loses their edit, with nothing in either history explaining it.
    The mitigation is to re-read after writing and confirm the set is what was intended, and to
    keep the window between read and write free of model calls and I/O. This is why invariant 5
    reads _delta, never a replacement array_: the poster path can honour it because the skill
    resolves the delta against live inside a single session, and the claim path cannot, which
    makes the claim the more dangerous of the two writes despite being the smaller one.
