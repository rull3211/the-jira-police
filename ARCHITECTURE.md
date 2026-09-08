# the-jira-police — architecture

A Node/TypeScript service that watches the SSX Jira board, runs Storebrand's `/intake-triage`
skill against every new ticket, and — when enabled — posts the verdict back to the ticket as a
comment plus labels.

```
new SSX ticket  →  discover  →  analyse  →  gate  →  post
                                    ↓
                            groomed/SSX-1234.md

labelled ticket →  solve queue  →  claim  →  solve  →  draft PR  →  review rounds
                                    ↓
                            groomed/solve-cycle.md

sent-back ticket → watch queue →  did somebody else edit it?  →  re-triage
```

The AI step is not ours. `/intake-triage` is Jacob Biørn's skill; a human normally invokes it by
hand. This service automates the trigger, checks the result, and applies it.

Status: running end to end against production Jira. 2367 tests in 64 files, no build step, no
deployment target yet.

A **second queue** exists alongside grooming: tickets a triage assessment marked
`agent:solvable`, waiting to be fixed by an agent. It selects the right tickets, claims them, and
excludes whatever is already in flight — the dedupe lives in the ticket's own labels rather than
on disk. A **third** watches tickets triage sent back, and re-triages one when somebody other
than this service edits it.

Past that queue the whole pipeline is wired, and every rung of it has been driven by hand before
being given to a loop. `pnpm solve:once <KEY>` climbs a cumulative ladder — `--claim` writes the
Jira label, `--solve` cuts a worktree and runs the model passes under a diff bound and mechanical
verification, `--pr` commits, pushes and opens a draft pull request, `--review` then works the
review to a handover — and `--advance`, a separate mode rather than a rung, runs one review round
against a pull request an earlier run left open. Real tickets have been claimed, solved, pushed,
reviewed and merged this way; §15 records what each step cost.

**`pnpm start` now does all of it.** What this section said for two months was that the pipeline
was "wired to nothing", and then for two days that the daemon "only advances pull requests that
already exist". Both were true when written and both are now false: `createReviewLoop` runs
`runReviewSweep` and then `runSolveClaims` in **one tick**, and `runSolveClaims` calls
`runWriteRungs(..., "pr", ...)` — so an unattended tick claims a ticket nobody looked at, cuts a
worktree, runs the paid passes, pushes a branch and opens a pull request. The ordering rule that
kept the claim out of the daemon has been spent, deliberately; what bounds it now is
`MAX_CONCURRENT_SOLVES`, the attempt ledger (§9) and `SOLVE_ENABLED`, not the absence of a
caller.

**A human still merges. The bot has no merge path**, and that is the one guarantee this change
did not touch.

See §2 for the three loops, §4 for the three queues, §15 for the pipeline, and §13 for what is
genuinely absent.

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
   Jira REST          │  index.ts — daemon, three loops          │
   /search/jql   ◄────┤    loop.ts     when to tick, backoff     │
   (read + agent:*)   │    poller.ts   one grooming cycle        │
                      │    store.ts    cursor + seen keys        │
                      │    review-loop.ts  review, then claim    │
                      │    watch-loop.ts   the sendback watch    │
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

### Three loops, and the separation is the safety property

`pnpm start` awaits three `runLoop`s in one `Promise.all`:

| Loop         | Module           | Cadence            | Switch          | What a tick can spend                         |
| ------------ | ---------------- | ------------------ | --------------- | --------------------------------------------- |
| **grooming** | `poller.ts`      | `POLL_INTERVAL_MS` | always on       | one analyst + one poster per new issue        |
| **review**   | `review-loop.ts` | `REVIEW_POLL_MS`   | `SOLVE_ENABLED` | review rounds, **and a full claim→solve→PR**  |
| **watch**    | `watch-loop.ts`  | `WATCH_POLL_MS`    | `WATCH_ENABLED` | one re-triage per ticket somebody else edited |

**They are separate loops rather than steps of one tick, and the reason is arithmetic.**
`TRIAGE_TIMEOUT_MS` is twenty minutes per issue, so a grooming cycle can legitimately occupy a tick
for longer than a reviewer takes to answer — two and a half to four minutes, measured. Sharing a
tick would tie the review cadence to the slowest thing grooming can do, which is how a timeout
setting quietly becomes a review policy. `REVIEW_POLL_MS` (two minutes) and `POLL_INTERVAL_MS`
(five) pull in opposite directions on purpose: one is a window over time, the other a question
about a state. `WATCH_POLL_MS` is slower again, because its trigger is a person editing a ticket —
an event measured in days.

**The first requirement of adding either was that it cannot stop the grooming loop.** That one has
been in production for two months; the review loop shells out to `git` and `gh` and spends money,
and the watch loop is the only one that spends with nobody having asked for anything. Three
`runLoop`s in a `Promise.all` give each its own backoff and its own failure isolation, so a review
sweep that throws every tick backs off the review side and nothing else. Both new loops return
`null` when their switch is off — a `null` rather than a loop that does nothing, so an operator
running exactly yesterday's configuration gets one line at startup rather than `review.disabled`
every two minutes forever.

#### The review loop advances and then claims, in one tick

This is the load-bearing sentence of the whole file and the thing most recently changed.
`createReviewLoop`'s `runCycle` is a sequence, not a pair of schedules:

```ts
await runReviewSweep(settings, client, runDeps, null, signal); // advance what exists
await runSolveClaims(settings, queueDeps, client, ledger); // then start something new
```

**The ordering is the point, and one tick is the only way to get it.** A ticket already under
review must be moved on before a new one is picked up; two loops on two cadences cannot promise
that at all, because whichever fires first wins, and at `MAX_CONCURRENT_SOLVES=1` losing that race
spends the only slot on a new solve while a pull request a human is waiting on goes unread for
another tick. This file previously predicted exactly that shape — _"when the solve half joins this
file it goes inside the review loop rather than beside it"_ — and that is what landed.

The cost of the ordering is that a tick is now the sum of both halves, which is why the interval is
the review cadence rather than the poll one. The second call is deliberately **not** in a `try` of
its own: `runLoop` catches, and a claim sweep that throws after the review sweep has run has lost
nothing the next tick will not redo, whereas swallowing it here would back off on nothing and hide
the fault from the backoff that exists to slow it.

Ordering rules, all in `createReviewLoop` and all covered by `src/review-loop.test.ts`:

- **The switch is read before the dependencies.** `createSolveRunDeps` throws on a missing
  `VAULT_PATH`; built above the switch, a grooming-only daemon would refuse to start for want of a
  path it will never read.
- **The dependencies are built before the loop starts, not per tick.** Inside the tick, one
  misconfiguration is a cycle that fails identically forever and reports itself as "the cycle
  threw". Outside it, the same mistake is one message and exit 78.
- **The loops are awaited together rather than raced.** A shutdown aborts the shared signal and
  each finishes the cycle it is in; stopping when the first returns would kill a review round
  mid-push to make a poll cycle's exit look tidy.
- **The abort signal is re-checked between tickets, not only before the sweep.** A solve is minutes
  long, and a stop that arrived during one must not be answered by starting another.

Plainly: the three loops can spend at the same time and no setting spans them.

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
| Owned `agent:`    | Narrower than the namespace: neither half of the delta may touch any `agent:` label except `agent:solvable` and `agent:watching`                                                                                                         |
| Delta agreement   | Every `labelsAdd` entry must also appear in the verdict's own `labels`                                                                                                                                                                   |
| `dor:pass` delta  | `labelsAdd` may not apply `dor:pass` while placeholders remain                                                                                                                                                                           |
| Component         | Must be empty or one of the four policy streams                                                                                                                                                                                          |
| Agent fitness     | `agentFitness.solvable` ⇒ verdict is `ready-ish`, no blockers listed, a repo named, and `agent:solvable` present in `labels`; and the label may not appear without the field                                                             |
| Plausible         | `agentFitness.plausible` ⇒ `solvable` is false, `blockers` is non-empty, and `agent:watching` is present in `labels`; and the label may not appear without the field                                                                     |

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

**The `plausible` rules guard a different cost, which is why they are their own function**
(`checkPlausible`, `gate.ts:425`) rather than four more lines in `checkAgentFitness`. Every
`solvable` rule protects against a bot editing source. These protect against a ticket joining a
list that buys a paid triage run every time somebody touches it — F's watch, §4. Two risks, so
two paragraphs, and both worth refusing a post over.

The mutual exclusion is the load-bearing one. `plausible` means _not solvable yet_, so a payload
asserting both has not made the call; left unchecked, the field with the weaker consequence drifts
into being a hedged version of the field with the stronger one, and the first time that mattered
would be a ticket simultaneously queued for a solve and subscribed to a watch. And `blockers` is
not an explanation here, it is the **exit condition**: `plausible` with an empty list is a
subscription with no unsubscribe, re-triaged on every edit until a bound fires, having never been
actionable.

**One case the gate structurally cannot check.** A ticket already carrying `agent:watching` that
is re-triaged into `plausible: false` needs the label _removed_, and `TriagePayload` carries what
the verdict asserts, never the live label set. So the rule catches "asserting a watch while
declining one" and cannot catch "declining a watch that is already running". Ending an existing
watch is the watcher's job, and that is the argument for the watch owning a terminal of its own
(§4) rather than trusting the next triage to tidy up after it.

One rule in the table is a security boundary rather than a coherence check. Triage owns
`agent:solvable` and `agent:watching` and nothing else in the namespace: `agent:start` is a
human's authorisation for a bot to attempt a fix. The analyst's entire input is a Jira ticket, and
a ticket is written by whoever felt like writing one — so if the skill could emit `agent:start`, a
ticket body could ask it to, and the human approval step would be one the bot performs for itself.
**Adding `agent:watching` to that owned set does not weaken the boundary**, and the asymmetry is
the reason: a ticket body can now talk the skill into putting itself on a watch list, which costs
re-triage runs, and it still cannot talk it into `agent:start`, which costs a pull request. The
solver's own six — `agent:solving`, `agent:reviewing`, `agent:review-done`, `agent:done`,
`agent:closed`, `agent:failed` — are excluded for a different reason: the solve queue has no local
cursor, and its idempotency rests entirely on those labels having one writer.

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

### The review queue — a third query, and the cheapest of the three

`buildReviewQueueJql` + `src/solve/review-cycle.ts`. Selects the tickets whose pull request is
still worth looking at, which is neither of the sets above: the solve queue is what has not been
started, the in-flight query is what is being worked on right now, and this is what has been
handed over and is waiting on somebody.

**Both `agent:reviewing` and `agent:review-done`, and watching only the first is the bug the query
exists to prevent.** The second is not a terminal — the loop keeps listening through human review,
and the arrow runs both ways, because a human comment on an undrafted pull request starts another
round and moves the ticket back. Selecting only the drafting half would mean undrafting silently
ends the loop, which is the ending §6.1 of the plan removed, reintroduced through a label instead
of through a `return`.

**It is not the concurrency query with a different label.** `MAX_CONCURRENT_SOLVES` bounds active
work, and a pull request waiting on a person is not that — the in-flight set is measured in
minutes and this one in days. Sharing a query would have made one merge-request-in-review hold the
only solve slot for as long as a human took to read it.

**No `statusCategory != Done` and no `labels NOT IN (...)`**, unlike the two above, and both
omissions are arguments. A ticket somebody closed while its pull request was open still has that
pull request, and the look is what writes `agent:done` or `agent:closed` when it ends — filter the
ticket out and the label is stranded with nothing that could ever clear it. The terminals are
written in the same edit that removes the two watched labels, so a ticket carrying one is already
outside the positive clause, and a second copy of that rule is a second thing to keep in step.

The cycle over that set is a **cheap look for everyone, a paid round for the few**, which is the
split `surveyReview` made possible (see Delivery). Four rules, each of them a bug avoided:

- **One unreadable pull request does not end the cycle.** A renamed repository or a `gh` timeout
  is one ticket's problem; nineteen healthy pull requests losing their tick because of it is much
  worse and entirely silent — the cycle just does less each time.
- **A cycle acts a bounded number of times.** `maxRounds` bounds one _tick_, where
  `MAX_PR_ROUNDS_TOTAL` bounds one pull request's whole life. Without it, a reviewer that answered
  twenty pull requests while the machine slept produces twenty paid rounds in the first tick after
  it wakes. Tickets over the bound are **deferred, not skipped**, and the query's oldest-first
  ordering is what stops the same one being deferred forever.
- **The bound is on the rounds, not on the looks.** Everything is looked at every tick, because a
  look is what notices a merge — and a merge left unnoticed keeps its label, stays in this query,
  and is looked at forever.
- **The cycle writes nothing**, exactly as `runSolveCycle` writes nothing. A merged or closed pull
  request comes back as its own `ended` arm for the caller to label. The write is a visible change
  to an interface a reviewer would look at, not a line inside a loop.

**It has two callers, and they differ only in who is watching.** `runReviewSweep` supplies the two
halves and does the labelling the cycle refuses to do. `solve:once --watch` puts it on a timer with
a person reading the output — the hand-driven rehearsal every phase gets first — and `runWatch`
adds only the loop, the cadence (`REVIEW_POLL_MS`) and the terminal. Since 2026-09-06 the daemon
calls the same function on the same cadence with nobody reading it (§2). That the two share
`runReviewSweep` rather than each composing the cycle is the whole point of the rehearsal: what was
watched by hand is what runs unattended, not a lookalike.

`runReviewSweep` takes its `SolveDependencies` as a parameter rather than building them, for the
reason its first bullet gives below applied one level up — both callers are loops, and a sweep that
built its own would turn one misconfiguration into a failure on every tick, forever. Three things
in it are worth knowing:

- **The look and the act share one `SolveDependencies`, built before the cycle rather than inside
  the look.** Not for the saving — it is a command runner and a clock — but because it throws
  `SettingsError` on a missing `VAULT_PATH`, and a throw inside the look is caught by the cycle and
  filed as _that ticket's_ problem. Built per ticket, one absent setting would report every ticket
  as unlookable, every pass, forever.
- **`act` is `advance`'s tail spelled out rather than a call to `advance`.** Calling it would
  survey a second time, and the second survey reads a comment posted in the intervening seconds —
  so the round would run against a batch the per-tick bound never counted. The bound only means
  anything if it sits between the survey and the round.
- **Watching one named ticket is a filter after the query, not a different query.** The
  subscription _is_ the label pair, so a named ticket carrying neither is genuinely not under
  review; it reports an empty watched set and the loop ends rather than polling something that will
  never arrive. For the same reason the loop **refuses to start when `SOLVE_ENABLED` is off**: the
  cycle would return an empty set without running a query at all, and "nothing is under review" is
  then a true sentence about a question nobody asked, which sends an operator to the board to debug
  their `.env`.

### The sendback watch — a fourth query, and the only one nobody asked for

`buildSendbackWatchJql` + `src/watch/`. A ticket triaged SEND BACK is not a rejection; it is a
ticket with a fixable gap, and the reporter was told exactly what to add. When they add it, nothing
looks again — `isUnseen` checks a permanent `seenKeys` list, so a ticket triaged on Monday can
never re-enter the grooming poller. The watch is the subscription that closes that.

```
project = SSX AND component IN (...) AND labels = "agent:watching" ORDER BY updated ASC
```

**No `statusCategory != Done` and no `labels NOT IN (...)`**, for the review queue's reasons
arriving through the same clauses: excluding closed tickets would strand `agent:watching` on them
forever, and a ticket that has moved on already lost the label in the same edit that wrote whatever
replaced it. A closed ticket here is a look that decides "unsubscribe" and pays for nothing.

**This is the one loop in the service that spends money with nobody having asked for anything**,
and every module in `src/watch/` is shaped by that. The others spend because a ticket was labelled,
a reviewer commented, or an operator typed a command. This one spends because a reporter edited a
ticket, which is not a request. Hence `WATCH_ENABLED` as its own switch, separate from
`SOLVE_ENABLED` rather than folded into it: one lets a bot write code, the other lets it re-open a
conversation it was told to stop.

**The trap the whole design is built around: posting a triage comment is itself an update to the
ticket.** So the obvious rule — _re-triage when the ticket changed since we last spoke_ — is true
the instant we stop speaking, and every watched ticket becomes a standing charge of one triage run
per cycle, each leaving a fresh comment on somebody's bug. The answer is the same shape as the
review cursor's: **compare against what somebody else did, not against what changed.**

Four brakes, in the order a sweep applies them, and each is cheaper than the one after it:

| Step                       | Costs           | Question                                          |
| -------------------------- | --------------- | ------------------------------------------------- |
| `decide.ts` + `signals.ts` | one Jira read   | Did somebody **other than us** move? Pure, no I/O |
| `memo.ts`                  | nothing         | Have we already declined **this exact** activity? |
| `relevance.ts`             | a small session | Did they move **in the direction we asked for**?  |
| `counter.ts`               | nothing         | How many re-triages has this ticket already had?  |

- **`decide.ts` is pure and has no I/O**, because it is the decision that spends and every one of
  its failure modes has to be reachable from a plain object in a test. `signals.ts` exists to keep
  Jira's vocabulary — ADF, the status-category taxonomy — out of it.
- **`relevance.ts` has no tools at all.** Not a narrow allowlist: none. It is a gate on spend, so
  it must cost less than the thing it gates, and a session that can go looking is a session that
  can cost what a triage costs. Everything it needs is in the prompt, sliced by `context.ts` at the
  instant the decision was made — because `decideWatch` returns on its first trigger, which is
  right for a decision and wrong for a question about _what happened_.
- **`memo.ts` closes the gap the relevance check opens.** Every other brake works because the
  action it bounds leaves a mark: a re-triage posts a comment, a reservation writes a label. **The
  relevance check writes nothing.** So a ticket whose latest activity is not an answer — a PM
  linking a duplicate, a reporter promising to get to it next sprint — stays triggered on that same
  activity and is re-judged every sweep, on identical content, forever. Cheap per lap times a
  daemon is not cheap. The memo is in memory, which is why `WATCH_POLL_MS` is six hours and why
  restarting every few minutes is what makes this feature expensive, not lowering the interval.
- **`counter.ts` exists because the obvious counter does not count.** The plan said to read the
  number off the bot's own comments, for the reason everything else keeps state in Jira. Then the
  triage poster turned out to **update its own comment in place** — it finds the previous one by
  the footer sentinel and rewrites it — so a ticket triaged five times has exactly one comment of
  ours and the count is zero forever. A brake wired to a stuck odometer is not a brake. The count
  is a **reservation, not a receipt**, the same rule the review marker arrived at and for the same
  reason: written afterwards, a run that crashes on its way to a verdict hands back a free attempt.

`retriage.ts` is the engine all of that bounds, and `sweep.ts` is one pass over the set. **`sweep.ts`
was the body of `watch:once`'s `main` until the daemon needed it too, and was extracted rather than
reimplemented** — the two callers differ in exactly the way that makes a divergence invisible, since
one is run by a person reading the output and the other by nobody. What they do differ in is
`acting`: a dry run holds no writer at all, so the refusal is structural rather than promised.

The exits are `unsubscribe.ts` (the pure edit — `agent:watching` off) and `end.ts` (performing it:
the label, then a comment if one is owed). A watch ends when the ticket closes, when re-triage
returns `ready-ish` and the normal path takes over, or when `MAX_RETRIAGE_PER_TICKET` runs out.

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
  --disallowedTools "<explicit list>" \
  --add-dir "<vault>" \
  --json-schema '<inline draft-07>'
```

- **`--allowedTools` does not restrict anything, and this document used to say it did.** It is an
  auto-approve list: naming a tool pre-approves it, omitting a tool denies nothing. Probed four
  ways 2026-09-04 — `--allowedTools "Bash(git status:*)"` ran an unscoped `git log`;
  `--allowedTools "Read"` ran `Bash`, with `dontAsk` and without it, inside this repo and from
  `/tmp`. So every triage run this service made before that date had `Bash`, `Write` and `Edit`
  available. **`--disallowedTools` is the guard**, and it is the strongest available form: the
  tool never enters the model's tool list, so there is no call to permit. Comma-separated form
  verified (`bash=NO write=NO read=YES`). Both flags are passed — the allowlist still suppresses
  prompts and documents intent — but only one of them is load-bearing. See §14.12.
- **The filesystem is not a boundary either, and this document used to imply it was.** Three
  probes 2026-09-07, with the exact flag shape `buildSolveArgs` produces: a pass read an absolute
  path in a sibling checkout with no `--add-dir` naming it; a pass with `Write` pre-approved wrote
  to a path outside its worktree; and it did so again with `--permission-mode dontAsk` removed. So
  the working directory confines nothing, `--add-dir` is not what grants a read, and no permission
  mode the harness can pass changes it. `--add-dir` widens the _workspace_ for every tool a pass
  holds, which is why it is given to the read-only recon pass and withheld from the write passes,
  and why the prompt block naming `SOLVE_READ_DIRS` goes to all of them — on a write pass the flag
  would authorise and the prose forbids. What actually catches a stray write is `escape.ts`, which
  snapshots the watched checkouts before and after each run; the only mechanism observed to _stop_
  one is a `PreToolUse` hook, which lives outside this repository. See PLAN.md §5b.
- **Whether MCP tool names are honoured by `--disallowedTools` is _unverified_.** A bare
  `storecode -p` run has no MCP server connected, so the probe returned `edit=NO get=NO` and
  distinguished nothing. The Atlassian mutators are named in both denylists on principle, and an
  unrecognised name is inert, but nothing in this service should be described as mechanically
  unable to edit a Jira issue on that basis. What actually keeps the analyst from writing is
  `--no-write` in the prompt plus `gate.ts` sitting between it and the poster.

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

71 production modules, 65 test files. Grouped by what they belong to rather than alphabetically,
because the grouping is the architecture.

**The shell — scheduling and composition**

| Path                 | Role                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/index.ts`       | Daemon entry point. Three loops, signal handling, `--skill` / `--interval` / `--for` overrides       |
| `src/loop.ts`        | Scheduling shell: interval, exponential backoff to a 15-min cap, interruptible sleep                 |
| `src/poller.ts`      | One grooming cycle. Ordering, dedupe, failure isolation, the three rules above                       |
| `src/review-loop.ts` | Review schedule + **the advance-then-claim tick**: `SOLVE_ENABLED`, `REVIEW_POLL_MS`, deps once      |
| `src/watch-loop.ts`  | The sendback watch's schedule: `WATCH_ENABLED`, `WATCH_POLL_MS`. The switch that most earns one      |
| `src/wiring.ts`      | **The composition.** Every `create*Deps` and every `build*Request`, for all six entry points         |
| `src/settings.ts`    | Declarative settings table + generic reader, with a `sensitive` marker                               |
| `src/logger.ts`      | JSON lines to stdout/stderr; `console` is banned by lint. `q`: ⏳ nothing happened, 🔧 it did        |
| `src/duration.ts`    | `30s` / `4m` / `1.5h` for CLI flags                                                                  |
| `src/text.ts`        | Text bounds shared by anything placing untrusted content where it must fit. Two callers, so one copy |

**Jira**

| Path                 | Role                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `src/jira/client.ts` | `/rest/api/3/search/jql`, token pagination, Basic auth, the changelog and activity reads         |
| `src/jira/jql.ts`    | Query builders — new-issue, solve queue, in-flight, review, sendback watch. Injection-safe       |
| `src/jira/types.ts`  | The slice of the Jira payload actually read, plus `TicketRef`                                    |
| `src/jira/adf.ts`    | Atlassian Document Format rendered down to plain text. No I/O, so testable against real payloads |
| `src/state/store.ts` | Cursor + seen keys, atomic write                                                                 |

**Triage — the grooming half**

| Path                         | Role                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `src/triage/schema.ts`       | The draft-07 contract handed to the analyst. Descriptions double as instructions             |
| `src/triage/session.ts`      | Shared subprocess machinery for every run: NDJSON, killing timeout, MCP check, cost          |
| `src/triage/runner.ts`       | The analyst                                                                                  |
| `src/triage/gate.ts`         | The check                                                                                    |
| `src/triage/poster.ts`       | The writer                                                                                   |
| `src/triage/single.ts`       | Triaging one named key, when discovery is the half being skipped. One copy for three callers |
| `src/triage/fitness-note.ts` | Renders the fitness call into the comment from the field, so prose cannot disagree with it   |

**Solve — selection, claim and the model passes**

| Path                        | Role                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/solve/labels.ts`       | The `agent:` state machine as pure functions; `repoFromLabels`                                    |
| `src/solve/poller.ts`       | One solve cycle: selection, capacity, and the planned claim                                       |
| `src/solve/report.ts`       | The cycle as `groomed/solve-cycle.md`, so a dry phase can be judged after the fact                |
| `src/solve/claim.ts`        | The claim and its release. Read, re-check, write, read back                                       |
| `src/solve/attempts.ts`     | How often the **daemon** has claimed each ticket, so it stops claiming one that keeps coming back |
| `src/solve/branch.ts`       | What may be written to: a work-prefix allowlist and a protected-name denylist                     |
| `src/solve/worktree.ts`     | The throwaway worktree, the branch name, and the `CommandRunner` interface                        |
| `src/solve/ticket.ts`       | The ticket rendered as the text a pass is given — description, comments, attachments              |
| `src/solve/read-scope.ts`   | Which other checkouts on this machine a pass may read for context                                 |
| `src/solve/skill-root.ts`   | A throwaway read-only copy of the `agent-solve` skill, staged per pass                            |
| `src/solve/schema.ts`       | The draft-07 contracts handed to `agent-solve`, one per pass                                      |
| `src/solve/runner.ts`       | The pass command lines and their parsers. Where `Write` is granted — and everything withheld      |
| `src/solve/passes.ts`       | The real `PassRunner`. Working directory is the worktree; no MCP server required                  |
| `src/solve/exec.ts`         | The real `CommandRunner`. No shell, executable allowlist, killing timeout, scrubbed env           |
| `src/solve/diff-gate.ts`    | The bound on what a solve run may have changed. Pure — no git, no fs                              |
| `src/solve/escape.ts`       | Notices when a pass wrote somewhere it was never meant to reach                                   |
| `src/solve/verify.ts`       | Mechanical verification. `passed` / `failed` / `refused`, never collapsed. Plus `checkFailFirst`  |
| `src/solve/orchestrator.ts` | The sequence: worktree → recon → fix → simplify → review → gate → verify                          |

**Solve — delivery and the review round-trip**

| Path                        | Role                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/solve/pr.ts`           | `git` and `gh` as argv arrays. Commit, push, draft PR, read review and threads, reply, resolve |
| `src/solve/pr-text.ts`      | The title and body of the draft pull request. Pure, so the wording is readable in a test       |
| `src/solve/marker.ts`       | The round cursor as one comment: render, parse, locate, refuse rather than reset. No I/O       |
| `src/solve/delivery.ts`     | `publish`, `surveyReview` and `advance` — the review round-trip as callable steps              |
| `src/solve/base-sync.ts`    | Bringing a PR's branch up to its base before a round spends. Built after a $16 invoice         |
| `src/solve/review-cycle.ts` | One pass over every watched pull request. Cheap look for all, paid round for the few           |
| `src/solve/silence.ts`      | How long a pull request has been quiet, in wall-clock. Pure; the clock is injected             |
| `src/solve/feedback.ts`     | What a run says back to the ticket. `safeText` and `shorten` bound what a model wrote          |
| `src/solve/commenter.ts`    | Posting that comment over an Atlassian MCP session. The narrowest tool surface in the tree     |

**The sendback watch**

| Path                       | Role                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/watch/decide.ts`      | Whether a watched ticket is worth paying to re-triage. Pure, no I/O — it is the money decision  |
| `src/watch/signals.ts`     | Jira's vocabulary (ADF, status categories) turned into what the decision reads                  |
| `src/watch/context.ts`     | Everything foreign since we last spoke, sliced at the instant the decision was made             |
| `src/watch/relevance.ts`   | Did they move _in the direction we asked for_. A gate on spend, and it has **no tools at all**  |
| `src/watch/memo.ts`        | What the watch already declined, so it does not pay to decline it again                         |
| `src/watch/counter.ts`     | Re-triages already given, as a reservation. The obvious counter does not count — see the header |
| `src/watch/retriage.ts`    | Running a re-triage, in the order that makes the brakes work                                    |
| `src/watch/unsubscribe.ts` | Taking a ticket off the watch list, as a pure edit                                              |
| `src/watch/end.ts`         | Performing that unsubscribe: the label off, then a comment if one is owed                       |
| `src/watch/sweep.ts`       | One pass over the watched tickets. Shared by `watch:once` and the daemon, so they cannot drift  |

**Entry points and their argument parsing**

| Path                       | Role                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `src/cli/poll-once.ts`     | One poll cycle, then exit. The daemon minus the loop, from the same factory          |
| `src/cli/triage-once.ts`   | One triage against a named key, no discovery. `--write` to post it                   |
| `src/cli/solve-once.ts`    | The solve ladder. Dry by default; every write is a typed flag                        |
| `src/cli/solve-args.ts`    | The ladder and the `--advance` mode, and which rungs the settings can actually reach |
| `src/cli/solve-run.ts`     | The rungs themselves. **The one module that writes to Jira, a worktree or GitHub**   |
| `src/cli/solve-outcome.ts` | Outcomes to an operator's terminal, and the rule deciding `$?`                       |
| `src/cli/bot-once.ts`      | The whole bot against one ticket: triage, fitness, claim, solve, PR, review          |
| `src/cli/bot-args.ts`      | The same ladder, with an issue key always required                                   |
| `src/cli/watch-once.ts`    | What the sendback watch would do; `--write` does it                                  |
| `src/cli/watch-args.ts`    | Its argument and output shapes, kept out of a file that ends in a top-level `await`  |
| `src/cli/docs-check.ts`    | `pnpm docs:check`. Development tooling, not a service entry point — see below        |

**Output**

| Path                 | Role                                             |
| -------------------- | ------------------------------------------------ |
| `src/output/sink.ts` | `FileSink` (reports) and the rejection artifacts |

`wiring.ts` exists because there are six entry points — the daemon, `poll:once`, `triage:once`,
`solve:once`, `bot:once` and `watch:once` — and a difference in how they wire the same pipeline
would be a bug
that only shows up in production. `docs-check.ts` is the seventh file in that directory and is
deliberately not a seventh entry point: it composes nothing, reads no settings, and touches neither
Jira nor a repository. It lives here because this is where a file you can run lives, and it is
called out rather than left to be counted, since "six" above is a claim about the composition and a
new CLI file is exactly what would quietly falsify it. The two solve commands go further than sharing `wiring.ts`: their
write rungs are literally the same functions, in `src/cli/solve-run.ts`, so a command file is now
argument parsing plus a call into the one module that writes to Jira, a worktree or GitHub.
`triage:once` used to build its options by hand; the copy drifted the moment the real skill grew
requirements. `wiring.ts` composes the solve pipeline too — `createSolveRunDeps`,
`createClaimCapabilities`, `buildSolveRequest`, `buildPublishRequest`, `buildFindPrRequest`,
`buildAdvanceRequest` — which is what makes the ladder a real escalation rather than six commands
that happen to look alike.

**The daemon is now a seventh caller of those same rungs, and that is the point.** `review-loop.ts`
does not reimplement a claim or a solve; it calls `runReviewSweep` and `runSolveClaims`, which call
`runWriteRungs` — the same function `bot:once --pr` reaches. So the unattended path and the
hand-driven one cannot diverge, which is the only reason it was safe to give the loop the write
rungs at all. The same argument produced `watch/sweep.ts`, extracted out of `watch:once` when the
daemon needed it: the two callers differ in exactly the way that makes a divergence invisible, since
one is run by a person reading the output and the other by nobody.

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

### The solve path fails differently, and the difference is that a retry costs money

Every row above is free to retry. On the solve side a retry buys a checkout, an install, and one
to four model passes, so the failure model is mostly a set of counters — and each of them exists
because the obvious one did not cover the case.

| What breaks                                     | What happens                                                                                                                                                                                                          |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createWorktree` refuses                        | `no-worktree`. No pass ever started, so nothing is labelled and the claim is released exactly as found                                                                                                                |
| A checkout outside the worktree moved           | `escaped`, carrying the paths and the verdict it overrode as `would`. Deliberately **not** applied over `no-worktree`: nothing of ours ran, so there is no candidate to accuse                                        |
| The same, caught during a review round          | `refused` with `stage: "write-escape"` — the same guard, reported in the shape `advance` already had for the diff gate and verification                                                                               |
| A run releases and the queue offers it again    | `AttemptLedger` counts claims per ticket, bounded by `MAX_SOLVE_ATTEMPTS_PER_TICKET`. In memory, daemon-only: `solve:once` and `bot:once` never consult it, because an operator running a ticket twice is a decision  |
| A round is decided on but never reached         | `MAX_FAILED_STARTS`, counted in the marker. Every other round bound is read _from_ the marker and the marker only moves when a round reserves, so an attempt dying before the reservation is invisible to all of them |
| A reviewer never answers                        | `REVIEW_SILENCE_MS`, measured from the newest dated thing on the pull request. The round caps cannot see this: no rounds run, so they sit at zero while the loop spins                                                |
| The machine sleeps mid-pass                     | `SESSION_IDLE_TIMEOUT_MS` is a silence budget, not a wall clock, and `session.ts` detects a suspend by timer drift and credits the gap back. A slept laptop no longer converts a claimed ticket into an abandoned one |
| A local `PreToolUse` hook denies the write pass | `abandoned` with cause `environment` — no terminal label, because a hook says nothing about whether the ticket is solvable, but the ticket **is** commented on, since the run spent a claim (`reportsToTicket`)       |

**Three outcomes deliberately write no terminal label** — `refused`, `failed`, and a transient
`abandoned` — and the attempt ledger exists because that is the right call and it has a cost. Those
outcomes say nothing about the ticket, so labelling them would convert a slept laptop or a policy
hook into a state only a human can clear; but the run then releases the ticket **exactly as it
found it, `agent:start` included**, so the queue offers it again on the next tick. Manual mode does
not save it: `runRelease` puts the go-ahead back with everything else, which is what makes a
hand-driven rehearsal repeatable.

The ledger is in memory, and that is the opposite of §1's rule on purpose. Losing the poll cursor
causes a **double claim**; losing this causes **one extra attempt per ticket after a restart**,
which is the behaviour of the day before it existed, re-bounded the moment the process has ticked
once. A label would survive a restart and be visible to a human, and is deliberately not what this
is: a write per attempt, on the path §3a's clobber risk is worst on, for a bound whose whole job is
to stop a loop that only exists while a loop is running.

`MAX_FAILED_STARTS` is not hypothetical either. **SSX-3835 retried once every two minutes for four
days**, and the only reason it cost nothing is that the failure happened to be free.

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

| Setting                         | Default                                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JIRA_BASE_URL`                 | `https://storebrand.atlassian.net`     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `JIRA_EMAIL`                    | —                                      | **required**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `JIRA_AUTH`                     | —                                      | **required**, sensitive. Discovery **and `agent:` label writes** — `updateLabels` only, namespace-bound by `assertOwnedLabel`; see §12. Not "discovery only", which is what this row said until 2026-09-08                                                                                                                                                                                                                                                                                                                                                          |
| `JIRA_PROJECT`                  | `SSX`                                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `JIRA_COMPONENTS`               | `SSX Advisor`                          | The SSX board is shared by several teams; this is what keeps the service off other teams' tickets                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `JIRA_EXCLUDED_TYPES`           | `10009`                                | Deloppgave / sub-task — arrives attached to a parent already triaged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POLL_INTERVAL_MS`              | `300000`                               |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `CURSOR_OVERLAP_MS`             | `120000`                               | See §4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `FIRST_RUN_LOOKBACK_MINUTES`    | `60`                                   | Deliberately short — a wide first window means one paid run per historical issue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `SKILL_NAME`                    | `mock-triage`                          | **Defaults to the mock**, so an unconfigured service cannot post real verdicts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `VAULT_PATH`                    | —                                      | Required for the real skill; checked at wiring time, not first-ticket time                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `WRITE_BACK`                    | `false`                                | The only setting whose effect the whole team can see. Strict `"true"` — a typo fails closed                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `TRIAGE_TIMEOUT_MS`             | `1200000`                              | Raised from `600000` on 2026-09-04 after a run was killed that was slow rather than stuck (§13). Floor of 1 — zero is a timer that has already expired                                                                                                                                                                                                                                                                                                                                                                                                              |
| `OUTPUT_DIR` / `STATE_PATH`     | `groomed` / `state/poll.json`          | Both gitignored                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `SOLVE_ENABLED`                 | `false`                                | Master switch for the solve queue **and for the daemon's review loop**. Strict `"true"`. Checked at composition _and_ in the poller; off means `pnpm start` schedules the grooming loop alone and says so once at startup                                                                                                                                                                                                                                                                                                                                           |
| `SOLVE_MODE`                    | `manual`                               | `manual` also requires `agent:start`, the single human step. An unrecognised value is a **startup error**, not a fallback                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `SOLVE_AUTO_ISSUE_TYPES`        | `Feil`                                 | Auto mode only. Not `Bug` — **this board is Norwegian**, and an English default would match nothing and make autosolve look enabled while never firing                                                                                                                                                                                                                                                                                                                                                                                                              |
| `SOLVE_REPOS`                   | — (**no fallback**)                    | Repository allowlist. The only solve setting without a default, deliberately: see §14.10                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `MAX_CONCURRENT_SOLVES`         | `1`                                    | Counted from the board via `buildInFlightJql`, never from local state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `MAX_REVIEW_ITERATIONS`         | `3`                                    | Counts **reviewer rounds only**, from the marker's third line, which is appended after the high-water mark so markers written before the split still parse. A person's request is the outside information the cap exists to protect against the absence of, so it is exempt; a mixed batch counts as human. Reaching it undrafts and keeps listening                                                                                                                                                                                                                |
| `MAX_PR_ROUNDS_TOTAL`           | `20`                                   | The absolute per-pull-request stop, deliberately **not** the same number as above. One is a policy, this is a brake, and conflating them lets a policy change disable a safety stop. Hitting it does not undraft                                                                                                                                                                                                                                                                                                                                                    |
| `SOLVE_WORKTREE_ROOT`           | — (blank means the temp dir)           | Grants nothing. Exists because macOS `tmpdir()` lands under `/private/var`, and the by-hand diff review phase C depends on needs a path a person can open                                                                                                                                                                                                                                                                                                                                                                                                           |
| `SOLVE_GITHUB_OWNER`            | — (**no fallback**)                    | The account a pull request is opened against. No default for the same reason as `SOLVE_REPOS`, plus one of its own: an owner inferred from the checkout's remote is right until somebody adds a fork as `origin`                                                                                                                                                                                                                                                                                                                                                    |
| `SOLVE_BOT_NAME`                | `jira-police`                          | Commit author. Widens nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `SOLVE_BOT_EMAIL`               | `jira-police@users.noreply.github.com` | Commit author                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `SOLVE_GH_TIMEOUT_MS`           | `60000`                                | Every `git` and `gh` command in the delivery path. Floor of 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `SOLVE_GIT_TIMEOUT_MS`          | `120000`                               | The worktree commands — `fetch`, `worktree add`, `checkout`. Longer than the `gh` budget because a cold `fetch` is the one git operation that is genuinely slow                                                                                                                                                                                                                                                                                                                                                                                                     |
| `SOLVE_STEP_TIMEOUT_MS`         | `600000`                               | One discovered verification step — test, typecheck, lint                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `SOLVE_INSTALL_TIMEOUT_MS`      | `900000`                               | Dependency install, which is separate because a fresh worktree has no `node_modules` and the first install in a repository is not comparable to any later step                                                                                                                                                                                                                                                                                                                                                                                                      |
| `SOLVE_TIMEOUT_MS`              | `1800000`                              | One model pass. The setting that machine sleep defeats: a pass killed here did nothing wrong and is deliberately not retried (§13)                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `SOLVE_BASE_REF`                | `origin/main`                          | What a worktree is cut from and what `verifyBase` and the fail-first probe are judged against                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `SOLVE_REPO_ROOT`               | — (**no fallback**)                    | Where the pilot checkouts live. No default for the same reason as `SOLVE_REPOS`: a path that survives being deleted from `.env` is a write privilege that cannot be revoked without editing source                                                                                                                                                                                                                                                                                                                                                                  |
| `SOLVE_READ_DIRS`               | — (**no fallback**)                    | Other checkouts under `SOLVE_REPO_ROOT` a pass may read for context, by name. Named to every pass in its prompt and `--add-dir`'d on the read-only one only; the same set the write-escape guard watches. No default for the same reason as `SOLVE_REPOS`, and names are validated rather than joined blind, since `join(root, "../..")` is a directory above the root                                                                                                                                                                                              |
| `REVIEW_POLL_MS`                | `120000`                               | How long `--review` waits between rounds, and `--watch` and the daemon's review loop between passes. A second cadence rather than a share of `POLL_INTERVAL_MS`, because polling for new issues is a window over time and looking at a pull request is a question about a state. Two minutes from measurement, not taste — every Copilot review on #2658 landed two and a half to four minutes after the request. A look that finds nothing costs two `gh` reads and no checkout, so lowering it is cheap — and no longer shortens the service's patience           |
| `REVIEW_SILENCE_MS`             | `1200000`                              | How long a pull request may go with nothing happening on it before the loop hands it to a human. The only bound that catches a reviewer who never answers: every other cap reads the marker, and the marker only moves when a round runs. Measured in wall-clock from the newest dated thing on the pull request, so a cadence change is not a policy change                                                                                                                                                                                                        |
| `MAX_REVIEW_ROUNDS_PER_TICK`    | `3`                                    | How many paid rounds one review pass may run across the whole watched set — `--watch`'s and the daemon's alike, and at $0.94 a round it is what a daemon tick's worst case is computed from and logged as at startup. The only bound in this table that bounds a _tick_ rather than a pull request, and the one that stops a reviewer who answered twenty pull requests while the machine slept from buying twenty rounds in the first pass after it wakes. Over the bound a ticket is deferred, not skipped; `0` looks at everything and acts on nothing           |
| `MAX_SOLVE_ATTEMPTS_PER_TICKET` | `3`                                    | How often **the daemon** may claim one ticket before it stops offering it, in memory for the life of the process. Bounds the runaway the label machine cannot: `refused`, `failed` and a transient `abandoned` all release the ticket exactly as found — including the `agent:start` the claim consumed — so the queue re-offers it next tick at full solve cost with no condition that ever clears. A terminal label cannot close that, because those outcomes deliberately write none. Hand-driven runs ignore it: a person typing the command again is the bound |
| `MAX_FAILED_STARTS`             | `3`                                    | How many rounds in a row may be decided on and never reached, from the marker. Closes the hole the other round bounds share — both read the marker, and the marker only moves when a round **reserves**, so an attempt that dies before the reservation is invisible to both. Not hypothetical: SSX-3835 did exactly this every two minutes for four days, and only cost nothing because that particular failure was free. Any successful reservation resets it, so it counts a stuck pull request rather than an unlucky one                                       |
| `SESSION_IDLE_TIMEOUT_MS`       | `600000`                               | How long **any** model session may go without producing a byte before it is killed. One number for every session because silence is the same question whichever pass is quiet. **Time the machine spent asleep does not count** — the watchdog detects a suspend by timer drift and credits the gap back, which is the answer to the machine-sleep failure §13 recorded as an E blocker. Sized for the slowest single tool call, not for the pass                                                                                                                   |
| `WATCH_ENABLED`                 | `false`                                | Master switch for the sendback watch, and **the switch that most deserves to be one**: every other loop spends because somebody asked for something, and this one spends because a reporter edited a ticket, which is not a request. Separate from `SOLVE_ENABLED` rather than folded in, because the two grant unrelated privileges — that one lets a bot write code, this one lets it re-open a conversation it was told to stop                                                                                                                                  |
| `WATCH_POLL_MS`                 | `21600000`                             | Six hours — the slowest cadence in the service by two orders of magnitude, because its trigger is the slowest event: a person reading a sendback, going away, and coming back. Note the memo is in memory, so restarting every few minutes is what makes this expensive, not lowering it                                                                                                                                                                                                                                                                            |
| `MAX_RETRIAGE_PER_TICKET`       | `3`                                    | Re-triages one watched ticket may be given before the watch is dropped with a comment. Counted from this service's own comments rather than disk. **Chosen against a triage cost of $0.11 that later measured $1.56**, so it is understated as a spending limit by roughly an order of magnitude — re-derive it before the watch runs unattended                                                                                                                                                                                                                    |
| `FAIL_FIRST_CHECK`              | `true`                                 | **The one setting that defaults on**, and the mirror of `flag()` on purpose — `!== "false"`. Every other switch fails closed so a typo cannot arm a privilege; this one grants nothing, so a typo must not silently withdraw a guard                                                                                                                                                                                                                                                                                                                                |
| `STORECODE_PATH`                | `storecode`                            | The subprocess binary. Overridable so a probe can point at a different build without editing source                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `LOG_LEVEL`                     | `info`                                 | Widens nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Commands:

```bash
pnpm start --interval 20s          # the daemon — grooming, plus review+claim if SOLVE_ENABLED,
                                   #   plus the sendback watch if WATCH_ENABLED
pnpm dev                           # daemon, --watch
pnpm poll:once --dry-run           # discovery only; free, and the fastest config check
pnpm poll:once                     # one full cycle
pnpm triage:once SSX-1234 [--write]
pnpm solve:once                    # whole queue; reads the board, changes nothing
pnpm solve:once SSX-1234           # the same, narrowed to one ticket
pnpm solve:once SSX-1234 --claim   # B2 — claims, proves the queue drops it, releases
pnpm solve:once SSX-1234 --solve   # C  — ... and runs the solver; nothing is pushed
pnpm solve:once SSX-1234 --pr      # D  — ... and opens the draft PR, reviewer @copilot
pnpm solve:once SSX-1234 --review  # ... and works the review to a handover
pnpm solve:once SSX-1234 --advance # one review round on the PR a previous run opened
pnpm solve:once --watch            # poll every watched PR until the queue empties
pnpm solve:once SSX-1234 --watch   # ... or poll just that ticket's PR
pnpm bot:once SSX-1234             # triage + the fitness call; writes nothing
pnpm bot:once SSX-1234 --claim     # ... writes the verdict, then claims the ticket
pnpm bot:once SSX-1234 --solve     # ... and runs the solver; nothing is pushed
pnpm bot:once SSX-1234 --pr        # ... and opens the draft PR
pnpm bot:once SSX-1234 --review    # ... and reviews it out of draft — the whole bot, one command
pnpm watch:once                    # every agent:watching ticket; reports, writes nothing
pnpm watch:once SSX-1234           # ... or just that one, label or no label
pnpm watch:once --write            # ... and act: drop the watch, or pay for a re-triage
pnpm check-types && pnpm lint && pnpm test
```

Note the script is **`check-types`**, not `typecheck`.

**Two different watches, and the names are close enough to be worth separating.**
`solve:once --watch` polls a **pull request** for reviewer activity, on a cadence of minutes.
`watch:once` is F's **sendback** watch: it asks whether a ticket a reporter was asked to fix has
been fixed, on a cadence of days. Nothing connects them but the word.

**`watch:once` had `--unsubscribe` where every other command here has `--write`, and the rename
is the flag catching up with what it does.** The narrow name was honest for exactly as long as
only one of `decideWatch`'s three outcomes had a writer: `unsubscribe` dropped the label,
`retriage` was unbuilt, and `quiet` writes nothing by definition. A flag called `--write` in that
state would have done nothing at all on the outcome that matters most while reporting a clean
run, which is the divergence this codebase is organised around, spelled as a command-line flag.
`runRetriage` exists now, so the honest name is the broad one — a flag that reads as a brake is
the wrong label on the switch that arms an engine.

**The rename is safe because an unrecognised flag is refused, not ignored.** `watchKey` filters
anything beginning with `-` out of the positionals, so without `watchWrites`'s unknown-flag check
an operator's muscle memory for `--unsubscribe` would produce a silent dry run reporting a clean
sweep over tickets it declined to touch — the same divergence, arriving through the rename meant
to close it. The error message names the old flag.

The shipping order was also deliberate: unsubscribing is the only action in F that _reduces_ what
the watcher can spend, so the brake shipped before the engine and `decideWatch`'s two runaway
terminals — `exhausted` and `uncountable` — became reachable before anything could run away.

All four escalating flags are wired, and **the ladder is cumulative** — `--review` claims, solves,
opens the pull request and then works the review. This paragraph used to say they refused, each
naming the module that would have to be composed; that was accurate for two phases and is now
history. `--advance` and `--watch` are the two things on the list that are not rungs, and the
parser refuses to combine either with one — or with each other. `--advance` acts on a pull request
an earlier run opened, so implying `--solve` would mean re-solving the ticket from scratch before
touching the review; `--watch` is the review cycle on a timer over a whole set of them, and is the
only mode here that runs at all without a ticket key. What `unavailable`
(`src/cli/solve-args.ts`) still does is refuse a rung that is not _configured_, which today means
`--pr` without a `SOLVE_GITHUB_OWNER` — checked before the claim rather than discovered after the
solver has run.

Dry is the default, so there is no `--dry-run`: the flag that has to be typed is the one that
escalates. Every flag past the first **requires an issue key**, because `solve:once --pr` would
otherwise mean "open a pull request for every ticket in the queue" — an unbounded write from a
command line one character shorter than the safe one, at the moment an operator is experimenting.

A run that does not reach a pull request releases its own claim on the way out, in a `finally`, so
a ticket is not left claimed by a run that crashed — unless the outcome _decides_ the ticket's
fate, in which case it leaves a terminal label and the reason behind instead. A run that opened a
pull request does not release either: it moves the ticket to `agent:reviewing`, because releasing
there would return a solved ticket to the queue for a second solver to duplicate, and keeping
`agent:solving` would hold the only concurrency slot for as long as a human takes to review.

### `bot:once` — the same ladder with triage on the front

`solve:once` starts from a ticket the board has already assessed. `bot:once` assesses it first: it
runs triage, reads `agentFitness`, and escalates only if that call says the ticket is agent-fixable.
The rungs are the same four functions — they were extracted into `src/cli/solve-run.ts` so that both
commands run the same code rather than two copies that drift.

Three things about it are worth stating, because each is a boundary being moved rather than reused.

**It is the first thing that acts on `agentFitness`.** Until now the fitness call was recorded — in
the artifact, in a label — and consumed by nothing, which meant a wrong `solvable` cost nothing and
therefore taught nothing. Here `solvable: false` ends the run before the claim and prints the
blockers. That also gives the calibration period its other half: `devLensAccurate` says how often
recon disagreed with triage on tickets that ran, and the refusals now say how often triage declined.

**`agent:start` is satisfied by argv rather than by the board.** `ClaimAuthority` (`src/solve/
labels.ts`) is `SolveMode | "named"`, and `"named"` skips the human-label check the way `auto` does.
It is deliberately not a third `SolveMode`: `solveMode` refuses any value that is not `manual` or
`auto`, so `"named"` cannot arrive from `.env` or from the daemon, which has no argv. Widening
`SolveMode` instead would have turned "skip the human" into a setting. What `"named"` does **not**
skip is `agent:solvable`, the blocking lifecycle labels, or `SOLVE_REPOS` — naming a ticket answers
"may this run", not "can an agent fix this", and the second question is triage's.

**It is broader than auto mode in exactly one way: no issue-type filter.** `SOLVE_AUTO_ISSUE_TYPES`
narrows a poller choosing its own work to `Feil`. A named ticket has already been chosen, so the
filter has nothing left to protect — and the pilot ticket is an `Oppgave`, so applying it would have
made the command refuse the only ticket it was built to run.

Triage always runs, and always first, even on a recently-triaged ticket. The claim reads
`agent:solvable` off the board, so escalating past the free rung implies a triage write — not as a
convenience but because the alternative is a claim that cannot succeed. That coupling is why there
is no separate `--write` flag here.

**Untested, and named as such:** `bot-once.ts`'s `main` passes the literal `"named"` to
`runWriteRungs`, and no test covers `main` — the same gap `solve-once.ts` has, for the same reason
(a module that runs on import). The pure parts either side of it, `resolveSettings` and
`fitnessRefusal`, are tested and mutation-tested; the wiring between them is read, not asserted.

Numeric settings carry a floor as well as a type. `numeric` rejects a negative everywhere, and the
two values that become a delay — `TRIAGE_TIMEOUT_MS` and `POLL_INTERVAL_MS` — additionally refuse
zero. Neither is pedantry: `setTimeout` clamps a negative delay to zero, so a stray minus sign does
not disable a timeout, it fires it immediately and kills every run at the starting line, while a
zero poll interval is an unthrottled loop against Jira rather than an eager one.

---

## 11. Test doubles and the testing rule

`.claude/skills/` holds five directories and only four are the service's. `intake-triage` (§12) and
`agent-solve` (§24) are the real ones; the two below are their stand-ins. **`dev-house-rules` is not
a runtime skill at all** — it is the development discipline for this repository, read by whoever is
editing it and by nothing the service runs. That is structural rather than a convention:
`prepareSkillRoot` stages `agent-solve` alone into a root that "must contain nothing else", so a
directory added here cannot reach a pass.

The two stand-ins are between them the reason any of this could be tested before the real skill was
available:

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

`.claude/skills/intake-triage/` is vendored from Jacob's `backlog-governance`. **Five local
changes.** The first four are to §11's label-reconciliation list; the fifth is to §1's ingest and
is the only one that changes what the skill reads:

1. **`next:*`.** Skill vocabulary — the same file defines
   `next:to-trio | next:to-reporter | next:to-other-team | next:needs-techlead` — and no human sets
   it, but its omission meant a ticket re-triaged from "send to the Trio" to "send back to the
   reporter" kept the stale `next:to-trio` sitting beside its own contradiction.
2. **`agent:solvable`**, and note it is listed as a single label rather than as `agent:*`. The rest
   of the namespace is not the skill's: see the security boundary in §3. This is the first
   namespace shared with a writer other than the skill, so the list is narrower than a prefix.

   **`agent:watching` joined it 2026-09-06** and is the same kind of label by the same test — the
   skill's own assessment, written by nothing else, authorising no access to code. What is not the
   same is the cost of leaving it behind. Every other entry on this list decays into a stale
   _reading_: a contradictory `next:`, a duplicated `svc:`. This one decays into a **standing
   charge**, because the label is a subscription to a six-hourly re-triage sweep, and the two events
   that end that subscription — the gap gets filled, or the ticket turns out not to be nearly
   solvable — are both this skill's own conclusions. Omitted from the removal list, the skill can
   enter the state and not leave it, which is the one failure F exists to prevent. The harness
   refuses a payload where `agent:watching` and `agentFitness.plausible` disagree in either
   direction, so the pairing cannot rot quietly; the removal list is what lets the skill satisfy it.

3. **The taxonomy namespaces — `team:`, `jira:`, `domain:`, `svc:`, `value:`, `effort:` — but only
   as a swap.** §11's removal list named the skill's _assessments_ and not its _facts_, while the
   skill's label vocabulary (`INTAKE_INSTRUCTIONS.md`, "Labels") sets both. The asymmetry: a
   re-triage could revise its verdict freely and could never revise a fact. A ticket re-routed to
   another squad kept the old `team:` beside the new one; a corrected `svc:` left two, which
   `repoFromLabels` reads as ambiguous and resolves to `null`, taking the ticket out of the solve
   queue entirely. The skill was the only writer of those labels and the only party unable to fix
   them.

   They are a **second tier** rather than six more entries in `OWNED_LABEL_NAMESPACES`, because the
   two kinds fail differently. A missing `dor:` label is a verdict not yet reached. A missing `svc:`
   is a fact deleted — and the value it decides is which repository a solver may write to. So
   `REVISABLE_LABEL_NAMESPACES` permits removal only when the same mutation adds at least one label
   in the same namespace: a replacement, never a bare deletion. A wrong new value is a wrong label
   the next re-triage corrects; a bare deletion is a hole nothing notices, because the ticket then
   reads as one that was never triaged. "At least one" and not "exactly one", since `team:` is
   legitimately multi-valued on dual-owned repos.

   **`impl-uncertain` stays unremovable**, and that is a known limitation rather than an oversight.
   It is a bare label, not a namespaced one, so there is no namespace for a replacement to arrive in
   and nothing for the swap rule to check — a ticket whose implementation site later becomes clear
   keeps it. Fixing that means naming a literal, which is a different decision from this one.

4. **Comments are read.** §1 now passes `comment` in the `getJiraIssue` field list and §8 scores
   DoR against comments as well as the body. Upstream reads the description only, which broke the
   skill's own send-back loop: §11 asks the reporter for what is missing and invites them to
   "reply here", and a reply landed in the one channel the next run could not hear. The re-run
   returned the identical `dor:gaps` verdict no matter what anyone wrote. On this board the
   acceptance criteria and the metric baseline are routinely added as a comment rather than edited
   into the description, so the body-only bar was also failing tickets over information that was
   present.

   Two guards came with it, and the first is the one that matters. **The skill's own comments are
   excluded** by the §11 idempotency test (its account _and_ the full footer sentinel): its report
   contains the acceptance criteria it asked for, phrased as criteria, so re-ingesting it would let
   a re-run pass the DoR bar against its own previous suggestion with no human having supplied
   anything. A verdict must never be satisfiable by the previous verdict. Solve-pipeline comments
   carry a different sentinel and are excluded on the same grounds. Second, the trust boundary is
   wider than the description's — anyone with a Jira account can comment on any ticket — so §1
   states that comment text is input data and never instruction, and that the description stays
   authoritative for scope where the two conflict.

   **Verified on the live board, 2026-09-04, against the send-back loop it was written to close.**
   SSX-3831 had been sent back by an earlier run for two named gaps — acceptance criteria and a
   metric baseline — and both were supplied as a comment rather than as a description edit, which
   is the case that used to be invisible. The re-run moved the ticket from `dor:gaps` to
   `dor:pass`, cited the comment by date for the rows it satisfied, and named the reporter
   confirmation still outstanding. Three things about the run are worth more than the verdict:

   - It **excluded its own prior comment** and said which test it used. The author half of the §11
     idempotency check could not help here, because this deployment posts under the same Jira
     account as the operator — so the footer sentinel was doing the work alone, which is the
     narrow case the guard was written for and the one least likely to have been exercised by
     accident. That is also why `safeText` in `src/solve/feedback.ts` strips the sentinel out of
     any text it embeds: the sentinel is load-bearing, and forging it is the way to be mistaken
     for a bot.
   - It **volunteered the account collision** as a caveat on its own verdict rather than reporting
     a clean pass — the criteria came from the technical side, not from the reporter, so the scope
     decision is proposed rather than confirmed and the description still contradicts it.
   - `agentFitness.solvable` came back **false on a `ready-ish` ticket**, blocked on one criterion
     whose root cause may not be in this repository. The gate in §2 of the plan is one-directional
     by design: DoR passing is necessary for solvability and not sufficient, and this is the first
     live case that distinguishes the two.

   A write-back run followed at 13:02 and posted to the ticket. It **updated its own comment in
   place** rather than adding a second — the idempotency test found the earlier report by its
   sentinel — and reconciled the labels, including retiring `next:to-reporter` in favour of
   `next:to-trio`, which is divergence 1 above doing the job it was added for.

   <a id="fitness-nondeterminism"></a>
   **And the fitness call disagreed with itself.** The 12:48 run returned `solvable: false`; the
   13:02 run returned `solvable: true` and wrote `agent:solvable` to the board. Same ticket, same
   two comments, same skill at the same commit, fourteen minutes apart. Both runs identified the
   same AK6 problem — the receipt already prefers the registration number, so the empty field has a
   root cause nobody has located, possibly outside this repository — and they disagreed only about
   whether that is a blocker or a caveat. Neither reading is unreasonable, which is the point: this
   is a judgement call sitting on a boolean.

   Three consequences, in descending order of how much they should change behaviour:

   1. **`SOLVE_MODE=manual` is not a starter setting to be graduated from.** The label that
      autosolve keys on is, on this evidence, not reproducible for tickets near the line. A human
      adding `agent:start` is not ceremony around a reliable signal; it is the thing making the call
      deterministic. Revisit `auto` only with a measured flip rate, not with a run of good results.
   2. **The queue must not read `agent:solvable` as a fact about the ticket.** It is one sample of
      a distribution, and phase A exists precisely to find out how wide that distribution is —
      "how often the fitness call is right before anything acts on it". This is the first datum and
      it is a disagreement, so the sample of runs matters more than the sample of tickets: re-run
      the same ticket, not only new ones.
   3. **The recon pass matters more than the plan gave it credit for.** It was justified as the
      check on triage having no source access. It is also the check on triage having been unlucky,
      and it is the only one, because nothing between the label and the worktree re-examines the
      call. `devLensCorrection` (`src/solve/feedback.ts`) is the channel that carries the
      disagreement back, and the append-only `dev-lens.md` is where a flip rate becomes visible.

   What this does **not** show is a bug. Nothing malfunctioned, no guard failed, and the ticket
   ended in a defensible state. It shows that a model's boolean is not a measurement, and that the
   design already assumed as much in the places that count — the human gate, the recon bail, and
   the dry phase that produced this observation instead of a pull request.

Both of the gate's lists must **match §11 exactly, not be a superset**. A gate looser than the
contract it enforces has a hole in it. Widen either only by widening §11 first — and tell Jacob,
because none of the divergences is upstream yet.

Two entries are looser as a bare prefix than §11 allows, and each carries a second check rather than
being widened or dropped:

- `agent:` is only partly owned, so `TRIAGE_OWNED_AGENT_LABELS` narrows it to the one label triage
  writes. If a future namespace is likewise only partly owned, copy that shape.
- The six `REVISABLE_LABEL_NAMESPACES` are owned but not freely removable, so removal is conditional
  on a same-namespace add. If a future namespace holds a fact rather than an assessment, copy that
  shape instead — the test is whether "absent" is a state the ticket may legitimately be in.

---

## 13. Not built

- ~~**The Slack canvas sink.**~~ **Deleted 2026-09-08, on an operator's call.** `canvas.ts` (123
  lines) and `canvas.test.ts` (134 lines) rendered the markdown and built the `canvases.edit`
  request bodies. There was never an HTTP call, a token, or an `OutputSink` implementation —
  **nothing was ever sent to Slack.** It was blocked on canvas write access and an Enterprise Grid
  app install, both human-gated, and neither arrived.

  What the reachability sweep added to "blocked" was that the module was **unreachable from all six
  entry points**, its only importer was its own test file, it dated from the initial commit, and
  the string "Slack" appeared nowhere else in `src/`. `formatChecklistLine` in `sink.ts` was the
  same lineage with zero references anywhere. So it was not a feature waiting on an install but 257
  lines of tested code for an integration the service does not have — and its tests were the kind
  this file warns about: **they passed, and they were testing nothing anyone could reach.**

  The header it left behind is the part worth keeping. `sink.ts` said the `OutputSink` interface
  existed "to keep that swap cheap", which is the standard defence of an abstraction with one
  implementation. It went untested for the whole life of the project, so the interface was never
  shown to be flexible — only unexercised. `git log -- src/output/canvas.ts` has it back if the
  access ever lands.

- ~~**Cost telemetry.**~~ **Done 2026-09-04.** `sessionCost` in `session.ts` reads
  `total_cost_usd`, `duration_ms`, `num_turns` and the four token counts off the `result` event
  and logs them as `session.cost`. One place, so it prices everything: triage, the poster, the
  relevance check and every solve pass. Two properties are load-bearing and both are mutation-tested — every field is
  `number | null` because **an unreported cost is not a free one**, and the log line sits _above_
  the success check because a failed run has still been paid for, so a total that skipped failures
  would look best on the days that went worst.

  The measurement that motivated it: `storecode -p "say ok"` — a two-word answer — cost
  **$0.127**, on 2 input tokens, 4 output tokens and **20,351 cache-creation tokens** billed at
  list. So the old "$0.11 per triage" figure was almost entirely fixed overhead rather than the
  cost of reading a ticket, and the per-invocation floor is about a tenth of a dollar before the
  model does any work. A solve is four such sessions.

- **`--max-budget-usd` / `--max-turns` / per-job `--session-id`.** Now actionable: `session.cost`
  supplies the number a cap would be set from.
- **Deployment.** No launchd job, no container, no metrics. `pnpm start` in a terminal is the
  current answer.
- **Concurrency.** Issues are triaged sequentially. Fine at 4–5/day.
- **`AND statusCategory != Done`** in the JQL — closed tickets currently get triaged. Small in
  steady state, not small on a first-run backfill. A question of intent, so it is open.
- **Unproven paths.** REST pagination and REST error handling (401/429/5xx) are unit-tested only;
  the live board has returned a single clean page every time.
- **Open decision: attachment bytes on the discovery credential.** `fetchAttachmentText` downloads
  attachment content and `solve/ticket.ts` inlines it into the solver's prompt. §14.11 records why
  this is a fresh widening of the governing constraint rather than an ordinary read, and that it
  landed without the invariant being updated with it. It is bounded three ways and it opens one new
  trust boundary — bytes uploaded by anyone who can edit the ticket, reaching a session that holds
  `Write` and `Edit`. **Keep, narrow, or revert is an operator's call and has not been made.**
- **Dead code, found by a reachability sweep 2026-09-08. The declarations are gone; the reporting
  channels are not.** Removed the same day, with `canvas.ts` above: `isEligible` and `AgentLabel`
  (`labels.ts`), `formatChecklistLine` (`sink.ts`), and `REQUIRED_MCP_SERVERS` (`triage/runner.ts`).

  **Two of those four are worth more than the line count.** `isEligible` looked like the recurring
  defect this file names — a guard with 21 assertions and zero production callers — and it was
  **not**: it was a boolean wrapper over `eligibility`, which _is_ called, at `poller.ts:304` and
  `claim.ts:406`, with the same rule mirrored in the JQL at `jql.ts:388`. So the rule is enforced
  three ways and only the wrapper was unreachable; the 21 assertions were exercising `eligibility`
  through it and were redirected onto it rather than deleted. Recorded because the first reading of
  the sweep had this backwards, and "a tested guard nothing calls" and "a tested guard called
  through one indirection" are the same shape from the outside and opposite findings.

  `REQUIRED_MCP_SERVERS` is the same trap from the other side, and the first reading of it here was
  wrong in the dangerous direction. Its doc comment — _"MCP servers that must report `connected`
  before the run is trusted"_ — was written up as a precondition **nothing enforced**, on the
  strength of the constant having no readers. That was a call-graph conclusion about a symbol
  presented as a behavioural conclusion about the system, and this document already contradicted it
  in two places (§7's failure table, which records the check firing for real on 2026-09-03, and
  `README.md`'s smoke-test description). The precondition is enforced: `assertMcpReady`
  (`triage/session.ts:205`) throws `McpUnavailableError` on the init event for any required server
  not reporting `connected`, and `["atlassian"]` reaches it from `wiring.ts:165`, `poster.ts:321`
  and `commenter.ts:329`.

  So what died was a **module-level constant superseded by a per-call option**, which is a
  strictly better shape and the reason it went unreferenced: a fixed `REQUIRED_MCP_SERVERS` cannot
  express `passes.ts` needing no server at all or the mock path needing none, and both pass `[]`
  today. The deletion was right and the epitaph was not. Recorded at length because the failure was
  this file's own defect class committed by the sweep meant to find it — **an unreferenced
  declaration is evidence about a name, not about a guarantee**, and the guarantee has to be traced
  to the code that would break.

  **Still dead, and both are decisions rather than sweeps.** `injectionNoticed` is `required` in
  three schemas and instructed for in two prompts, parsed in three places, and **read by nothing**;
  recon's copy reaches the fix pass only incidentally inside the JSON brief, and the fix, simplify
  and review copies go nowhere — a reporting channel for prompt injection with no listener. Deleting
  it is not obviously right: the field costs a schema entry and the plumbing already exists, so
  wiring a listener is cheaper than rebuilding it after the first injection nobody heard about. Four
  fields are computed and dropped: `ReviewState.reviewerErrored` (the standing debt item, now
  proven), `ReviewThread.isOutdated`, `VerificationPlan.toolchain` and `StepResult.output`. Clean by
  the same sweep: **all 46 settings are read**, and there are no orphan files.

### The solve feature, from the claim onward

Everything that _selects_ a ticket is built and was verified against the live board on
2026-09-03. **Everything that _changes_ anything is now built, composed and driven by hand** —
claim, solve, push, draft pull request, and a review round against an open one. §15 records what
each step did and what it cost. This list is what is still missing, and it is shorter than the
five bullets it replaced; the four that went are kept below in one line each, because a reader
who remembers them should be able to see that they were retired rather than quietly dropped.

- **Retired, 2026-09-03 to 2026-09-05.** _A composition_ — `wiring.ts` now builds a
  `CommandRunner`, a `PassRunner` and a `ClaimCapabilities`, and `settings.ts` declares every
  value they need. _The claim write_ — driven, and the queue-drops-it experiment ran. _A run
  against a real repository_ — worktrees cut, passes spawned, `pnpm test` run in
  `buy-insurance-advisor-web`, pull requests opened and merged. _Delivery end to end_ — `publish`
  and `advance` are both called from `src/cli/solve-run.ts`, and `buildAdvanceRequest` passes
  `MAX_REVIEW_ITERATIONS` and `MAX_PR_ROUNDS_TOTAL` in.
- **Retired, 2026-09-05.** _`agent:reviewing`, and the pull request as the terminal._ Both are
  written. `reviewTransition` replaces the claim when the pull request opens,
  `reviewStageTransition` mirrors the draft flag onto `agent:review-done`, and
  `completionTransition` writes `agent:done` on a merge, `agent:closed` on a close and
  `agent:failed` on a bail. `state` (`OPEN`/`CLOSED`/`MERGED`) is read, and the loop no longer
  ends at the undraft. **The review step moved to the daemon rather than stalling**, and landed
  there 2026-09-06 — see below.
- **Retired, 2026-09-05.** _Both reviewers._ `waiting` now asks whether anyone actionable spoke,
  not whether the requested reviewer did, so a human who comments first is acted on rather than
  collected and discarded. Every `ReviewComment` and every `ThreadComment` carries an `origin`
  (`reviewer` | `human`), the marker carries a second count, and `MAX_REVIEW_ITERATIONS` reads
  only the reviewer's half — a person's request no longer burns a budget invented to bound two
  machines talking to each other. A mixed batch counts as human, a thread's origin is its first
  comment's, and `exhausted` became `reviewer-exhausted` because it stopped being an ending: the
  pull request undrafts and the loop keeps listening. `MAX_PR_ROUNDS_TOTAL` still counts
  everything, since a brake a person's comment could step past is not a brake.
- **Retired, 2026-09-07/08. _Running it from the daemon._** This bullet said "half done" for two
  days: the review sweep ran unattended and the solve queue did not, so the daemon only advanced
  pull requests a person had already asked for. **Both halves now run.** `createReviewLoop`'s tick
  is `runReviewSweep` and then `runSolveClaims`, and `runSolveClaims` calls
  `runWriteRungs(..., "pr", ...)` — an unattended tick claims, cuts a worktree, pays for the
  passes, pushes and opens a pull request. The sendback watch (`watch-loop.ts`) landed beside it
  behind `WATCH_ENABLED`.

  **The three gates that were holding the solve half were closed, not waived**, and each one is
  now a setting rather than a promise:

  | Was blocking                     | Closed by                                                                                        |
  | -------------------------------- | ------------------------------------------------------------------------------------------------ |
  | a **per-ticket attempt count**   | `MAX_SOLVE_ATTEMPTS_PER_TICKET` + `attempts.ts` — the ledger `runSolveClaims` reserves against   |
  | **machine sleep**                | `SESSION_IDLE_TIMEOUT_MS` + the drift watchdog in `session.ts`, which credits back the slept gap |
  | rounds that die before reserving | `MAX_FAILED_STARTS`, after SSX-3835 retried every two minutes for four days unnoticed            |

  **What has _not_ been closed is the one that was named first: cost per ticket per day.** §4 of
  the plan's Verification asked for it before the loop was switched on, and it is still not
  measured. A completed solve has never been costed end to end. So the daemon's per-day spend is
  bounded by arithmetic over `MAX_CONCURRENT_SOLVES`, `MAX_SOLVE_ATTEMPTS_PER_TICKET` and
  `MAX_REVIEW_ROUNDS_PER_TICK` rather than by observation, and the difference between those two
  is what an invoice is for. **This is the largest open item in the file.**

  One thing the split already answered, which was listed as a blocker: **what a solve failure does
  to the backoff.** Separate loops mean it does nothing to grooming. A review sweep that throws
  backs off the review side alone, and `loop.ts` needs no new notion of failure kind.

  The corollary the file held for two months has now been spent, and it should be read as spent
  rather than quietly dropped: **a ticket claimed, solved and PR'd by hand is a demonstration; the
  same sequence on a timer is a deployment.** This is a deployment. What still holds is the part
  underneath it — every rung was driven by hand, against a named ticket, with a person reading the
  output, before the loop was given it, and the loop calls those same functions rather than a
  lookalike (§7).

Each phase is expected to ship two hand-operated commands before it counts as done — a dry run
that reports what it _would_ change, and a single run against one named ticket, chosen by the
operator rather than by the queue. `triage:once SSX-1234 [--write]` is the shape being copied.
`solve:once` grows one flag per phase (`--claim`, `--solve`, `--pr`), each implying the ones
before it, so the command line reads as the privilege escalation it is.

- **Probes.** The `Bash(pnpm test:*)` scoping question was run 2026-09-04 and answered in the
  worst available way — see §6 and §14.12. Phase C took the shape the fallback described, not
  because that was preferred but because the alternative turned out not to exist.

  **Copilot review — answered 2026-09-04, with no write.** The plan called for a throwaway pull
  request; the org's own history answers most of it for free. In
  `storebrand-digital/buy-insurance-advisor-web`, **8 of the last 60 pull requests carry a review
  by `copilot-pull-request-reviewer[bot]`**, the most recent the day before. So the feature is
  enabled for this org and this repo, and it posts substantive findings rather than a rubber
  stamp. Two details that matter to `pr.ts`, both already handled and now confirmed against
  reality rather than assumed:

  - The login that answers is `copilot-pull-request-reviewer[bot]`, not `copilot`. This is why
    `matchesReviewer` is a prefix match on the requested handle; the case is pinned in
    `pr.test.ts`.
  - Copilot's review state is **`COMMENTED`**, never `APPROVED`. `readReview` never reads
    `state` to decide whether anyone spoke — today `anyoneResponded` asks only whether a
    non-ours entry exists at all, and the login decides `origin` rather than whether the loop
    wakes. Had either keyed off an approving state, the review loop would have waited forever on
    a reviewer that had already spoken.

  One sub-question genuinely needed a write and was **deferred to phase D** rather than probed on
  a throwaway pull request: whether `gh pr edit --add-reviewer @copilot` succeeds with this token's
  `repo` scope. Phase D opens a real draft pull request anyway, so the probe cost nothing there and
  would have cost a junk PR in a team repo. Deferring was safe because of _where_ the answer lands:
  the reviewer request happens after the PR exists and before anything is undrafted, so an
  insufficient scope surfaces as a loud failure on a draft a human can finish by hand — not as a
  skip nobody sees. What phase D must therefore **not** do is treat a failed `--add-reviewer` as a
  warning and carry on to `gh pr ready`: that would undraft a PR nobody has reviewed, turning a
  missing scope into a merge candidate.

  **Answered on PR #2657, 2026-09-04, and the answer had a second half nobody asked for.** The
  request succeeded — `repo` scope is enough, the app was assigned, and its job ran. The app then
  failed: `Resource not accessible by integration` on `GET /repos/…/pulls/2657`, because the
  Copilot installation lacks `pull_requests: read` on that repository. That is an org
  configuration, not something this codebase can fix, and re-requesting produced the same result.

  **Granted since.** On PR #2658, 2026-09-05, Copilot reviewed for real. `reviewerErrored` stays:
  the permission can be revoked, and a guard removed because the thing it caught stopped happening
  is a guard removed at exactly the wrong time.

  The part that is ours is **how the failure came back**: as an ordinary `COMMENTED` review whose
  whole body was "Copilot encountered an error and was unable to review this pull request." Read
  as feedback, that spends a paid review round asking a model to address an error message. Read as
  a review with no comments, it is an approval — the loop undrafts and moves the ticket to
  `agent:review-done` on a review that never happened, which is the pipeline telling a human their
  code was reviewed when it was not. `ReviewState` therefore has a third state, `reviewerErrored`, sitting between
  "no response" and "a review". It is recognised from the reviewer's own text, which is brittle
  and is the only signal there is; both phrases must match, and the match is scoped to the
  requested reviewer so a person quoting the failure keeps their comment.

- **`main` is protected, and that is a stronger backstop than the plan claimed.**
  `required_approving_review_count: 1` with `require_code_owner_reviews: true`. Since Copilot only
  ever `COMMENTED` and a bot is not a code owner, **a human code owner must approve before
  anything merges** — enforced by GitHub, not by this codebase. "A human merges, always" therefore
  holds even if every guard here were removed. Worth knowing precisely because it means the guards
  here are not the only thing standing between a bot and `main`.

  The other half is less comfortable: `required_status_checks.contexts` is **empty**. There is no
  CI gate on that repo, so the harness's own `verify` run is the only mechanical check a
  bot-authored change passes before a person looks at it. That raises rather than lowers the value
  of verification being mechanical and of the diff gate refusing edits to the files that define
  what verification means.

- ~~**Cost of a solve is still unmeasured.**~~ **Measured 2026-09-04**, across three consecutive
  `--pr` runs on SSX-3822. Recon does cost more than the fix, and by a wide margin:

  | pass      | cost                | duration      | turns   |
  | --------- | ------------------- | ------------- | ------- |
  | recon     | $1.40 – $1.71       | 3.8 – 4.7 min | 41 – 48 |
  | fix       | $0.85 – $0.96       | 1.3 – 1.6 min | 22 – 29 |
  | simplify  | $0.32 – $0.42       | 0.6 – 0.9 min | 8 – 9   |
  | verify    | **$0**              | ~40 s         | —       |
  | **total** | **≈ $2.60 – $3.00** | ~7 min        |         |

  Verify is free because it is mechanical — the harness runs the commands and reads exit codes,
  and no model is asked whether the tests passed (invariant 13). Recon is roughly half the bill,
  which is the read-only pass that can decline the work: the pass most worth paying for is also
  the one that most often produces no code. Against a triage run — **$1.56 measured on 2026-09-05,
  not the $0.11 this line used to quote** — a solve is under 2×, which is a very different shape of
  budget from the one the old figure implied.

  The spread across three runs of the _same ticket_ is itself a reading. Same ticket, same repo,
  same base — 15% variance in cost and a different `simplify` verdict each time.

- **The host's own safety hook can abandon a fix pass, non-deterministically.** Observed
  2026-09-04 on the second solve of SSX-3822. The fix pass tried to write
  `src/utils/setFavicon.ts` and storecode's `pipelock` PreToolUse hook denied it —
  `pipelock: blocked (Credential Path Directive)`. The likely trigger is content, not path: this
  ticket is about detecting non-production environments, and the Credential Path Directive fires
  on text containing the `.env` substring, which `import.meta.env.PROD` contains. **The first
  solve of the same ticket wrote the same feature and was not blocked**, so this varies with
  whatever the model happens to write, not with the ticket.

  Three things to take from it, in order of importance:

  1. **The refusal contract held under real pressure.** The pass did not retry a variation, did
     not look for a way around the hook, and — the part worth keeping — **declined to ship the
     half of the change that had succeeded**, on the grounds that a lone `favicon-test.svg` would
     read as a complete fix. That is the failure mode the pass contract names, refused
     unprompted.
  2. **`abandoned` is now known to be overloaded.** It currently means both "the model judged
     this ticket unfixable" and "the environment would not let the model write", which are
     different facts with different remedies — the first is feedback about triage, the second is
     a host misconfiguration and says nothing about the ticket. The calibration record cannot
     currently tell them apart, so `dev-lens.md` will slowly accumulate environment failures
     scored as ticket assessments.
  3. **It is not this service's bug to fix.** The hook lives in `~/.storecode/`, a protected path,
     and editing a safety hook so that this project's own agent can write is exactly the move the
     operating rules forbid. It needs a human to decide whether the directive is over-matching.

- **Triage duration is high-variance, and the first reading of that was wrong.** On 2026-09-04 a
  triage of SSX-3831 exceeded the 600 s `TRIAGE_TIMEOUT_MS`. The obvious inference — that the
  ticket's two long comments had made the run expensive, comments having just been added to §1 —
  was recorded here and then falsified by the retry: the same ticket, the same comments, the same
  skill, **266 s**. More than 2x apart on identical input, so the cause is variance in the session
  and not the size of what it reads. Worth keeping as an example of the failure this document
  exists to catch, in the document itself: a plausible cause arrived at the same moment as a
  change that would explain it, and it took one more measurement to notice the two were unrelated.

  `TRIAGE_TIMEOUT_MS` was raised to 1 200 000 all the same. The asymmetry decides it rather than
  the diagnosis: a cap that fires early costs a fully-billed session and produces no artifact,
  while a cap set too high costs only that a genuinely wedged run is reaped later. See §10.

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

   **Verbatim on the way out, and not on the way back — found 2026-09-06 building the watch.**
   The sentinel is written `_…_`; Jira stores ADF, so the underscores become an `em` mark and
   stop being characters; `renderAdf` re-emits emphasis as `*…*`. So a reader comparing the
   sentinel _whole_ against a comment fetched back matches nothing this service has ever posted.
   Anything identifying our own comments therefore keys on `FOOTER_TEXT` — the sentinel with its
   delimiters stripped, derived from it so the two cannot drift. The general rule: **the words
   survive the round trip and the markup does not**, so identity belongs to the words.

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
    that names what may be written to — **`SOLVE_GITHUB_OWNER` is that future**, and carries a
    second reason of its own: an owner inferred from the checkout's remote is correct right up
    until somebody adds a fork as `origin`, at which point a bot opens a pull request against a
    repository nobody chose. Note this cuts the opposite way from
    `SOLVE_AUTO_ISSUE_TYPES`, where the fallback _is_ the restriction — the test to apply is not
    "does it have a default" but "does silence widen or narrow what the service may touch."
11. **A label write names the labels it changes, and nothing else.** Every label edit goes
    through `JiraClient.updateLabels`, which sends Jira's `update.labels.add` / `.remove` and
    refuses any label failing `/^agent:[a-z][a-z0-9-]{0,60}$/`. So the write is physically
    incapable of touching `triaged`, `svc:*`, `dor:*` or a human's `next:*`, and verification
    asks only whether the delta took — `diffEdit`, not a whole-field comparison.

    **This inverts what this invariant said until 2026-09-04, and the history is the point.**
    It used to read _every label write is read-modify-write, and must be verified after the
    fact_, because the only write path was MCP `editJiraIssue`, whose input schema has one field
    for issue data — `fields` — and is `additionalProperties: false`. There was no `update` key
    to pass. Adding one label meant reading all N, appending, and writing all N back, so any
    label anyone added in between was silently dropped: a PM adding `next:to-trio` while a solve
    claimed the ticket lost their edit, with nothing in either history explaining it. The
    mitigation was read-back-and-verify, which narrows the window and cannot close it — and
    `claim.ts` shipped its own limit as a passing test saying so.

    What changed is not the tool surface but a **decision about the standing rule** that the
    REST credential is discovery-only. The amendment is deliberately the narrowest one that
    closes the hole: one method, one HTTP verb, labels only, the `agent:` namespace only, and
    **comments stay on the MCP path** — those are Atlassian Document Format, the MCP tool does
    the markdown→ADF conversion, and reimplementing that to move a write off a path that works
    would be widening the credential for no benefit.

    Three things follow. **Concurrent claims are still not prevented**, only made unlikely
    (`MAX_CONCURRENT_SOLVES=1`, one host) — a delta is not a compare-and-swap. **Verification
    narrowed on purpose**: with a delta, a bystander label appearing between the write and the
    read-back is a colleague working, and reporting it as `unverified` would fire the check on
    innocent events, which is how a check ends up switched off (§8). **And `releaseClaim`
    derives its delta from the receipt, not from the live set** — "remove whatever is live and
    was not there before" reads as the careful version and is the old clobber by another route.

    Invariant 5 (_delta, never a replacement array_) now holds on both write paths rather than
    on one, which is what it was always asking for.

    **The rule has a second amendment, authorised 2026-09-06: `JiraClient.fetchActivity` reads a
    ticket's changelog.** It is read-only, so it does not touch what the first amendment was
    about — but the standing rule is _discovery_, not _reads_, and issue history is not
    discovery, so it is an amendment rather than an ordinary use. What it buys is the sendback
    watch (F): the trigger for re-triaging a watched ticket is a reporter editing the field that
    was blocking it, and the changelog is the only place that fact exists. The alternative was
    keying on the changelog's **author** as the plan originally proposed, which is both a wider
    read and a worse rule — the poster writes through an MCP session on a human's Atlassian
    account, so authorship cannot separate this service from the operator, and a field-based
    trigger is immune to whoever holds the credential.

    Two bounds keep it narrow. The method reads status, comments and changelog for **one named
    issue** and nothing else, and it is called only from the watch path. And it **refuses a
    partial read**: both lists are paged to completion, and a ticket past the cap throws rather
    than returning a prefix, because the count of our own comments is the whole bound on what a
    watched ticket may cost and a count of some of them reads exactly like a count of all of
    them.

    **That same GET was widened the same day, and it is recorded as a widening rather than as a
    third amendment.** `fetchActivity` now asks for `summary,description,environment,attachment`
    alongside `status,labels` — four read-only fields, on a request already being made, for one
    named issue. What forced it: `BLOCKER_CLEARING_FIELDS` are content fields, and the relevance
    check was being handed the _name_ of a field that moved with none of its text, so the
    commonest way a reporter answers a sendback — editing the description — could only ever be
    refused. It failed closed, so it never spent; it simply declined everything, and each refusal
    read like judgement. The distinction from the two amendments above is deliberate and is the
    line to hold: those added a **write** and a **new endpoint**, this asks the discovery
    credential for more of a ticket it is already reading.

    **The line named in the sentence that used to end this invariant has since been crossed, and
    it was not recorded here until 2026-09-08.** That sentence read: _"Nothing about attachment
    **bytes** is fetched — names, types and sizes only — and widening past that is a fresh
    decision."_ `JiraClient.fetchAttachmentText` (`client.ts:699`) GETs
    `/rest/api/3/attachment/content/{id}` on the discovery credential and returns the file's
    contents, which `solve/ticket.ts:158` inlines into the prompt a solve pass is given. That is
    a **third endpoint** and it is **bytes**, so it is the fresh decision the sentence reserved —
    taken in `0d42074` ("Let the solver read the whole ticket, not just its title") without the
    invariant being updated in the same commit.

    Recorded here rather than quietly deleted, because the mechanism that failed is the one this
    file exists to describe. The house rule is that prose which has become false is rewritten in
    the same commit as the behaviour; the rule held for the two amendments above and did not hold
    for this one, so the file asserted a bound the code had already stepped past. **It is the
    project's own defect class, in the invariant list, about the governing constraint** — which
    is the worst place in the repository for it to happen and the reason it is written up rather
    than tidied.

    Four properties bound it, and they are the argument for keeping it if it is kept. The
    endpoint is read-only. `assertAttachmentId` rejects anything that is not a bare id, so the
    path cannot be steered. `isInlineable` fetches nothing that is not a text-like MIME type, and
    `DEFAULT_TICKET_RENDER_OPTIONS` caps the run at **five attachments of 32KB each** — small
    enough that a ticket cannot push the real instructions out of the context window by attaching
    a large file. And the size is checked **twice**, before and after the download, because
    `content-length` is absent on chunked responses and a cap that trusted it is a cap any
    sufficiently large file steps around; over the cap the reader returns `null` and the caller
    says "attachment too large to inline" and names the file, which is true, rather than handing
    over a truncated head that would produce a confidently wrong artifact.

    What is genuinely new and is **not** bounded by those three is the trust boundary:
    attachment bytes are uploaded by whoever can edit the ticket, and they are inlined into a
    prompt given to a session holding `Write` and `Edit`. That is a fresh untrusted-input path
    into the solver, and the plan named it as one — _"a new privilege and a new untrusted-bytes
    path, so not now"_. It is now. Whether the capability stays is an operator's decision and is
    flagged as open in §13 rather than settled here.

12. **A capability is only withheld if something withholds it.** `--allowedTools` pre-approves;
    it does not restrict. This service ran for its whole life with three comments in
    `runner.ts` and one in `poster.ts` asserting that omission from that list was denial, and it
    never was — every triage run had `Bash`, `Write` and `Edit`. The general form is worth more
    than the specific bug: **an absence is not a control.** A list of what is permitted restricts
    nothing unless the mechanism reading it denies the complement, and whether it does is a fact
    about the tool, not about the intention of whoever wrote the list. Probe it, and write down
    what the probe showed rather than what the flag is named. The corollary for reviewers: a
    comment claiming something is prevented should name the mechanism, so the claim can be
    checked against it.
13. **Nothing may edit the definition of whether it passed.** Mechanical verification is only
    worth anything if the thing being verified cannot move the goalposts — and the harness reads
    its test, typecheck and lint commands out of the repository it is checking. So the diff gate
    refuses `package.json`, `tsconfig*.json` and the lint and test configs unconditionally, and
    exempts them from every size cap. The reasoning generalises to anything later that discovers
    behaviour from data an agent can write: **discover from the pristine base, not from what the
    run produced**, and treat "the check passed" as meaningless until you know the check was the
    one you meant.
14. **An escalation that does not arrive undoes itself.** Every rung above the dry run opens by
    claiming the ticket and closes, in a `finally`, by releasing it. A crash, a bail, a failed
    verification and a refused push all leave the board exactly as they found it, because a claim
    left behind by a run nobody watched is a ticket the queue can never offer again — and the
    manual repair for that is a human editing the label field by hand, which is the whole-field
    clobber invariant 11 exists to have eliminated.

    The single exception is a pull request that exists, including one whose reviewer could not be
    added. There the work is real and ongoing, and releasing would return a solved ticket to the
    queue for a second solver to duplicate. So the rule is not "always release" but **release
    unless the run produced something someone else can now see** — which is the same line the
    ladder is ordered along.

    Two things make this checkable rather than aspirational. The release is derived from the
    receipt (invariant 11), so it is arithmetically the inverse of the claim and cannot touch a
    label this service did not write. And it never throws: it runs on the way out of a run that
    has usually already failed, and turning "the claim was gone before I could undo it" into an
    exception would replace the operator's real error with a bookkeeping one.

15. **The pull request body is composed from what the harness measured, not from the model's
    account of itself.** The model writes the commit subject and body — it just made the change
    and is the only thing that knows why — and that prose is the only model-authored text in the
    document. It is quoted under a heading naming whose words they are, and neutralised by
    `asProse`. Everything else is harness-established fact: exit codes it read, file and line
    counts it measured, the recon verdict it parsed.

    This matters more here than anywhere else in the pipeline, because the pull request body is
    the most widely-read artifact the service produces and the one most likely to be believed. A
    model asked to summarise its own work will say the tests pass, and it has no way to know — the
    harness ran them (invariant 13, §15). So the body says, in the document itself, that the model
    was never asked.

    The neutralising is not tidiness. The commit prose descends from ticket text, which is
    attacker-controlled, and text that can create document structure can forge a heading, a table
    row, a link, or a checklist that reads as though the harness wrote it.

    **This was a code fence until 2026-09-04, and the trade is worth recording.** `safeFence`
    counted the longest run of backticks in the text and fenced with one more, which is the
    stronger guarantee: nothing inside a fence renders as anything. It was traded away after the
    first live pull request (#2657) was read by a human, whose verdict was that the body was "a bit
    long and hard to read" — a fence renders prose as a monospace dump with a horizontal
    scrollbar, and the body's whole job is to be read. A document nobody reads has no integrity
    property worth protecting.

    So `asProse` replaces it: paragraphs are reflowed to one line each, then `\`, `` ` ``, `[`,
    `]` and `|` are escaped, `<` becomes `&lt;`, and a leading `#`, `>`, `-`, `+`, `*`, `=`, `~`
    or `1.` is escaped at the one line-start each paragraph now has. The backslash goes first, or
    a backslash already in the text cancels an escape added after it. Emphasis (`*`, `_` inline)
    is deliberately left renderable: it is cosmetic, it cannot forge a section or a link, and
    escaping it would mangle every `snake_case` identifier in the prose.

    It is a weaker guarantee than the fence and an enumerated one, so it is enumerated in tests —
    fourteen cases in `pr-text.test.ts`, each mutation-tested. **If a construct is found that gets
    through, the fix is another line in `escapeInline` or `escapeLeading` plus a test, not a
    retreat to the fence.** The old reasoning that escaping "would corrupt code samples" was
    overstated: an escaped backtick renders as a backtick.

    The same change moved recon's correction, the fix pass's summary and simplify's log into
    `<details>`, leaving on the page only what a reviewer decides with — is it green, how big is
    it, and did anything disagree with anything. `details` escapes its own text rather than
    accepting rendered markdown, so that "there was nothing to say" is decided in one place; the
    first attempt composed it with the `_(nothing said)_` marker and therefore rendered a widget
    for every absent field, because that marker is not empty.

16. **The commit message is bounded by the harness, not by the model's restraint.** The fix pass
    is asked for one or two sentences and `composeCommitMessage` keeps two, wraps every kept line
    at 72 columns, and strips trailing whitespace from each. Asking is not enough on its own:
    the request is arithmetic about text, which a model satisfies most of the time, and "most of
    the time" is a solve that dies at the last step after three paid passes.

    This is written from the failure. The first live `--pr` run passed recon, fix, simplify and
    all four verification steps, and was then rejected by the target repository's own
    `commit-msg` hook — `@commitlint/config-conventional` caps body lines at 100 characters and
    the model had written one 190-character paragraph. Nothing upstream was wrong; the harness's
    own Conventional Commits check passed, because it checks the subject.

    Two smaller rules fall out of it. The width is 72, git's convention, rather than the 100 that
    happened to be configured here — this service does not read the target repository's
    commitlint config, so the margin has to come from choosing a number below every value anyone
    sets. And the shortening is a **cut, not a summary**: lines are wrapped and never rejoined,
    a word longer than the width gets its own line rather than being broken, and the long-form
    reasoning is not lost because `summary` and `residualRisk` carry it into the pull request,
    which is where a reviewer reads prose. A commit message is read in `git log --oneline`.

    The same run taught the diagnosis rule beside it. Commitlint echoes the message it was given
    before printing its verdict, so `why()` keeping the first 300 characters of output kept 300
    characters of our own commit body and cut the rule name. It now keeps **both ends** and marks
    the gap: a tool names the failing step at the top and gives the verdict at the bottom, and a
    truncation that can only preserve one of those will eventually drop the one that mattered.

17. **A new loop in the daemon may not be able to stop the old one.** The grooming loop is the
    part that has run in production for two months; the review loop shells out to `git` and `gh`
    and spends money. They are two `runLoop`s in a `Promise.all` rather than two steps of one
    tick, so each has its own cadence, its own backoff and its own failure isolation — a review
    sweep that throws every tick backs off the review side and grooming does not notice.

    **Everything the new loop needs is decided before either starts ticking.** `createReviewLoop`
    reads `SOLVE_ENABLED` first and returns `null` when it is off, so a grooming-only daemon never
    builds the solve dependencies and never refuses to start for want of a `VAULT_PATH` it will
    not read; when it is on, those dependencies are built once, out here, so a misconfiguration is
    one message and exit 78 rather than an identical failure every two minutes forever. The
    general form: **a configuration error belongs at startup, and a loop is where errors go to
    become invisible.**

    It lives in `src/review-loop.ts` rather than in `index.ts` because `index.ts` runs `main` on
    import, so anything decided there cannot be asserted about without starting a service. That is
    not tidiness either — the ordering above is the whole of the safety property, and a safety
    property with no test is a comment.

---

## 15. The solve pipeline

Everything below is built, tested and **reachable from the command line** — the claim, the model
passes, the commit, the push and the draft pull request are one `solve:once SSX-1234 --pr` away.

This paragraph has been rewritten four times as that stopped being true in stages, and the shape
of what is left is worth stating precisely rather than as "mostly done". **`advance` is wired** —
`solve:once SSX-1234 --advance` runs one review round against a pull request an earlier run opened
— and `--review` chains the whole thing, opening the pull request and then working rounds until
the reviewer stops or a bound fires. **The label state machine is wired too**, since 2026-09-05:
nothing on the solve path is moved by hand any more. A ticket goes
`agent:solving → agent:reviewing → agent:review-done` and ends on `agent:done`, `agent:closed` or
`agent:failed`, and every outcome that spent a claim says so on the ticket.

**Nothing structural is left here, and this paragraph used to name two things that are now
false.** It said human reviewers were collected and then dropped by the `waiting` gate: they are
not, since that gate asks whether anyone actionable spoke rather than whether the requested
reviewer did, and `origin` splits the round count so a person's request cannot burn a budget
invented to bound two machines (§13). And it said the daemon would not claim on a timer: it does,
since 2026-09-07 — `createReviewLoop`'s tick advances and then claims, and the claim goes all the
way to a pull request. Both sentences were true when written, which is exactly why they are worth
naming rather than deleting.

What is left is not a slice of the pipeline but a number: **cost per ticket per day** under an
unattended loop has still never been measured. §13 keeps the open items; what this _does_ is here.

<a id="what-running-it-cost"></a>

### What running it cost

Four solve attempts against one ticket, 2026-09-04. Each got further than the last, and **each
surfaced a defect that 1245 passing tests did not** — which is the finding, more than any of the
individual bugs:

| #   | Defect                                                                 | Why no test caught it                                                     |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | `/agent-solve` resolved to nothing from the worktree                   | no test ran a pass from a foreign working directory                       |
| 2   | `simplify` handed a `--numstat` where the prompt said "diff"           | one function served two callers; the test asserted the value it was given |
| 3   | the diff gate could not see created files                              | the harness fixture replied to `git diff`; real git has an index          |
| 4   | an honest "I gave up after touching something" was rejected as invalid | the guard was tested against its own premise                              |
| 5   | no bail reason was ever logged anywhere                                | nothing asserts on the absence of a log line                              |

Two of the five (2 and 4) were guards behaving exactly as unit-tested while being wrong about
reality, and two (1 and 3) were the harness's own test doubles agreeing with the code and
disagreeing with the world — §11's second rule, met again in a new place. The general lesson is
already in §11 and got its most expensive demonstration here: **a fixture that agrees with the
code proves the two agree, and nothing else.** Running it once was worth more than the five
hundred tests written since the last time anything ran.

Of the two defects that were left open when the above was written, one is now fixed:

- **A pass timeout used to kill the process.** `passes.run` throws two ways — `runSession`
  rejects on a timeout or a non-zero exit, and the parsers throw `SolveParseError` when the
  model's output contradicts itself — and neither was caught. A solve is a long-running job
  holding a worktree, so the throw took the process down and orphaned the worktree.

  Fixed by `runPass`, which converts both into the same thing, because the caller's decision is
  identical: **no verdict was reached.** Which of the two it was survives in the reason string.
  It produces a new outcome kind, `crashed`, rather than another `refused` stage, so that every
  exhaustive `switch` had to be edited to admit it — and each of those edits is a place where
  the difference between "no verdict" and "a verdict of no" had to be decided deliberately:

  |                    | what `crashed` does                                                                    |
  | ------------------ | -------------------------------------------------------------------------------------- |
  | ticket comment     | says the step did not finish and that this says nothing about the ticket's solvability |
  | calibration record | scores the lens `n/a`, never `**wrong**`                                               |
  | shell exit code    | `1` — nothing was learned, at full cost                                                |
  | `devLens`          | absent from the type, because the pass that produces it may be the pass that died      |

  The calibration row is the sharpest of the four. Booking a harness timeout as a wrong fitness
  call would make the triage assessment look worse the flakier the harness got, which is the one
  bias that would make the scoreboard argue for the opposite of the truth.

  The review round is the deliberate exception: a dead review pass returns `abandoned`, not
  `crashed`, because by then a pull request exists, so there is a human on the other end and
  somewhere to put the reason.

  Two things the fix does **not** do. `runPass` wraps `passes.run` only — a throw from git, from
  the verification steps or from the worktree layer still propagates, which is why
  `solveTicket`'s skill-root cleanup is still a `finally` and why the test for it now has to
  make _the shell_ fail rather than a pass. And the process still dies if the throw comes from
  there; bounding that is Phase E's problem, not this one's.

  This also cost the CLI's outcome reporting its excuse for being untested. `solve-once.ts` ends
  in a top-level `await`, so importing it runs the command, and the exit-code rule had therefore
  never been exercised — the `crashed` clause could be deleted and every test still passed.
  Split into `src/cli/solve-outcome.ts`, the same move `solve-args.ts` made earlier and for the
  same reason.

The second is fixed too, though not in the shape it was filed in:

- **`removeWorktree` was never called.** Filed as "call it on success". That would have been data
  loss — nothing in this phase commits, so a successful run's worktree is the only copy of the
  work. It is now called on `bailed` only, which is the one outcome whose worktree is provably
  empty. The full reasoning, and what is still not cleaned up, is under "Never a protected branch".

And one non-defect worth recording, because diagnosing it wrongly was itself instructive: a run
appeared to hang for thirty minutes in `recon`. It was not API slowness. **The laptop was
closed.** `SOLVE_TIMEOUT_MS` bounds elapsed wall-clock time, not time the process spent running,
so suspending the machine spends the budget. Anything later that treats a timeout as evidence
about the model has to survive that.

```
  worktree      cut from origin/<base> after a fetch, on a fresh work branch
    ↓
  recon         read-only. may say no, and saying no is a success
    ↓
  fix           the only pass that makes the change
    ↓
  simplify      a cold read of the diff; usually changes nothing
    ↓
  diff gate     bounds what may have been touched, against git's account
    ↓
  verify        install, typecheck, lint, test — exit codes, not opinions
    ↓
  publish       commit → push → draft PR → request the reviewer
    ↓
  advance       read the review and its inline threads → count the round from the
                marker on the pull request → reserve the next one by editing that
                marker → resolve → push → answer the threads → re-request, or undraft
```

`orchestrator.ts` owns the first half, `delivery.ts` the second. Neither touches Jira and neither
takes a Jira client: labels and comments belong to the caller, which keeps the whole thing
runnable by hand against one ticket with nothing on the board changing.

### The first end-to-end run, 2026-09-05

`bot:once SSX-3822 --pr`, 15 minutes wall clock: triage 3½ min → poster → claim → recon 7 min →
fix → install → vitest → commit → push → **draft PR #2658**, five files, +70/-1. Every stage ran
as designed and nothing needed a hand on it.

Three things it settled:

- **Copilot review works in this org.** It reviewed #2658 (`COMMENTED`), closing the last open
  verification item. Nothing acted on the review — `advance` was unbuilt that day — so the ticket ends on
  `agent:solving`.
- **The fitness call refused a ticket for the first time.** A second run, `bot:once SSX-3801`,
  stopped before the claim: DoR row 9 unmet, so the verdict could not be `ready-ish`, so
  `solvable` had to be false. Two further guards would have caught it independently — the change
  is consumed by an external partner, and its repo is not on `SOLVE_REPOS` — and the cheapest
  fired first, which is the ordering the ladder is for. Nothing was claimed and no worktree cut.
- **A stale solve comment steered a verdict.** SSX-3822 had been label-reset but still carried the
  previous run's comment, and triage's `recommendedNextStep` came back asking why a branch and PR
  already existed. Harmless here, and it is the §1-reads-comments divergence working as specified
  — solve comments are excluded from _satisfying_ DoR, not from being read as context. Worth
  knowing before reading any re-run's verdict as independent of the run before it.

One gap the refusal exposed and no label yet expresses: **"not ready yet" and "not ever" both land
as `solvable: false`.** SSX-3801's DoR gap is fixable by a reporter; its partner-contract blast
radius is not. The distinction survives only in `rationale` prose.

### The two actors

The important structural fact about this phase is that there are two of them and only one has a
shell.

|           | The model's session                                | The harness (Node)                              |
| --------- | -------------------------------------------------- | ----------------------------------------------- |
| Runs      | `agent-solve`, once per pass                       | `git`, `gh`, the package manager                |
| Sees      | the worktree, as its working directory             | the worktree and the repository it was cut from |
| May write | files, in four of the five passes                  | nothing but the branch it created               |
| Cannot    | run anything, reach the network, spawn a sub-agent | form an opinion                                 |

This is enforced the only way it can be. **`--allowedTools` does not restrict** (§6, §14.12) — it
pre-approves — so the control is `--disallowedTools`, which keeps the tool out of the model's list
entirely. `Bash` is on the denylist for every pass. With no shell there is no `git`, no test
runner and no package manager in the session, which is what makes _"the harness runs the
verification"_ a property of the argument list rather than a convention. The skill file describes
it the same way: not a rule the session is asked to follow, but the absence of a tool.

Two further denials are worth their own sentences, because neither is obvious:

- **`Task`.** Whether a sub-agent inherits the parent's `--disallowedTools` is **unverified**.
  Until it is probed, a model that cannot run `Bash` but can spawn something that can has not been
  restricted — it has been inconvenienced. Denying it costs the solver nothing.
- **`WebFetch` and `WebSearch`.** The ticket text reaches the session verbatim and is written by
  whoever opened the issue. With no network tool there is no in-session path from "text in a Jira
  description" to "a request leaving this machine", which removes exfiltration from the threat
  model rather than mitigating it.

The Atlassian mutators are named in the denylist too, carrying the same caveat as the analyst's
(§6): whether MCP tool names are honoured is unverified, an unrecognised name is inert, and
nothing here should be read as mechanically enforced. It matters less in this direction — the
solve passes are given no MCP server at all (`requiredMcpServers: []` in `passes.ts`), because a
solve pass reads the ticket as text handed to it and has no reason to hold a connection to
something it could also write through.

### The skill root

`skill-root.ts` exists because of defect 1 above, and the shape of the fix is the interesting part.

Every pass sends `/agent-solve <KEY> --<pass>` as its first line. The skill lives in _this_
repository; the pass runs with its working directory set to the worktree, deliberately, because
that is `passes.ts`'s first containment property. Claude Code discovers skills from the working
directory and from `--add-dir`, and neither pointed here — so every pass would have shipped
sending a slash command that resolved to nothing. Probed from a foreign directory:
`Unknown command: /agent-solve`.

The obvious fix is `--add-dir <the-jira-police>`, and it is still the wrong one, though **the
reason written here first was stronger than the facts support.** It said `--add-dir` plus a
pre-approved `Write` is write access to everything in the added directory, implying the converse:
that a directory left out is safe. The 2026-09-07 probes above refute the converse — a pass wrote
outside its worktree with no `--add-dir` involved at all — so withholding the flag was never the
thing keeping this service's source, settings and gates from being edited. Nothing was. What the
flag does change is what the pass is _pointed at_: a session told the harness's own repository is
part of its workspace will read and edit it as a matter of course, where one that is not has to
go looking. Instead the harness copies the two skill files into a throwaway directory, adds
_that_, and deletes it afterwards — so the pass gets exactly the text it needs to resolve the
command and is never handed a path back to the repository that wrote it. The distinction to keep
is that this is a narrowing of attention, not a wall, and the wall does not exist.

Worth generalising: the failure was not that a guard was missing but that **a string was assumed
to resolve**. Nothing in the type system distinguishes a slash command that dispatches from one
that is echoed as prose, and no unit test noticed because none of them ran a pass from anywhere
but this repository's root. The class is the same as §14.12 — an intention with no mechanism under
it — and the tell was identical: prose describing a skill-driven pipeline, behaviour sending a
dead string.

**The harness half is `CommandRunner`, and `exec.ts` is its only real implementation.** Every
other module in `src/solve/` takes one and was written and committed without granting anything;
that file is the grant, and it is deliberately short enough to read in one sitting. Four
properties:

1. **No shell.** `spawn` is called without the shell option, so argv is argv and nothing between
   here and the kernel splits on whitespace, expands a glob or notices a `;`. Every caller builds
   argv arrays for this reason, and this is the end of that chain.
2. **An executable allowlist.** `argv[0]` must be `git`, `gh`, `pnpm`, `npm` or `yarn`. Not a
   defence against the callers in this repository — they are all literal — but against the shape
   of the system: attacker-controlled text goes through a model and the result eventually
   influences arguments, so bounding _which binary runs_ makes the worst case a malformed `git`
   command rather than an arbitrary one. The list holds no general-purpose interpreter, because
   each one is a way to run something else, which is what an allowlist of programs is for.
3. **A timeout that kills.** `SIGTERM`, then `SIGKILL` after a grace period. A promise that
   rejects while the child keeps running is worse than no timeout, because the caller believes the
   step is over and the process is still holding the worktree.
4. **A scrubbed environment.** Built up from a passthrough list rather than stripped down from
   `process.env`. `PATH` and `HOME` are passed because the allowlist is names and because `git`
   and `gh` read their config from it, and `CI` and `NO_COLOR` are set so package managers do not
   wait on a prompt. Nothing to do with Jira or Vertex travels, and neither does `NODE_OPTIONS`.
   Building the set up rather than deleting known-bad keys means a credential added to `.env` next
   month is not inherited by default.

It does not retry. A failed command is a fact the caller must decide about, and `verify.ts` in
particular distinguishes "the tests failed" from "we could not find out" — a retry here would
quietly turn the second into the first.

### The five passes

`recon` → `fix` → `simplify`, then `review` once per round of reviewer feedback, plus `merge` when
a branch will not take its base. Five sessions, two tool sets — and `PASSES` in `runner.ts` is the
list, iterated by the tests rather than restated in them, because three hand-copied copies of this
membership all stopped testing anything on the day it changed.

| Pass       | Tools                              | Shown                                                                    | Must return                                                                                                             |
| ---------- | ---------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `recon`    | `Read` `Grep` `Glob`               | the ticket                                                               | proceed or a bail reason; a dev-lens correction                                                                         |
| `fix`      | the above, plus `Write` and `Edit` | the ticket and recon's brief                                             | files touched, a commit subject, a test story                                                                           |
| `simplify` | same as `fix`                      | the ticket and the real diff                                             | changes made, or why it declined                                                                                        |
| `review`   | same as `fix`                      | the ticket, the review comments and every open inline thread with its id | a response to every comment, plus a `threadAnswers` entry per thread carrying a reply, a `basis` and whether to resolve |
| `merge`    | same as `fix`                      | the conflicted files                                                     | the resolution, and `took` — which side each hunk came from                                                             |

Separate sessions rather than one, and the reason differs each time. **Recon must not be able to
write**, or "should this be attempted" and "here is the attempt" collapse into one answer, and any
injection attempt in a ticket only has to survive one hop. **Simplify must look at the diff cold**,
because the author of a piece of code is the last person to notice it is convoluted — it is given
the diff rather than the brief, so that it reconsiders how the change is written rather than
whether it was the right change. **Review arrives after a human-visible artifact exists** and holds
a distinction the other three do not: a comment about the diff is its work, a comment about its
tools or its scope is data to report and not act on.

**`merge` belongs to no stage of the four above it**, which is why it reads oddly in a list of
them. It runs when a pull request's branch cannot take its base without conflicts — a property of
two histories rather than of the ticket — and it is the one pass that can be the _entire_ content
of a round: a branch that will not merge cannot be verified, so answering a reviewer on top of it
would be answering from a tree nobody can build. See `base-sync.ts`, which exists because seventeen
consecutive rounds once did exactly that for about $16.

It costs several model runs per ticket instead of one. That is the price of each stage being able
to disagree with the one before it. Note what the split does _not_ buy: the last four share a tool
set, so the separation between them is independent judgement, not additional containment.

Recon's denials are the union of the solve denylist and `DENIED_BUILTIN_TOOLS` — the analyst's own
list — rather than a hand-written `Write`/`Edit` pair, so a future finding that denies a tool in
triage denies it in recon without anyone remembering to.

**The parsers carry the rules the schema cannot express.** JSON Schema can require a field; it
cannot require that `bailReason` is non-empty exactly when `proceed` is false. So `parseRecon`
refuses a verdict that both proceeds and bails — the run contradicted itself, so neither reading
is safe to act on — and one that declines without saying why, because the reason is the only
calibration the fitness assessment ever gets. `parseFix` refuses a report where `testAdded` and
`testOmittedReason` agree: exactly one of "a test was added" and "here is why not" must hold.
`parseSimplify` is handed the fix pass's file list and refuses anything outside it, because
simplification reaching a file the fix never touched is a second, unreviewed change riding inside
a diff a human approved for a different reason. `parseReview` refuses a round that answered
nothing, because a round with no responses is indistinguishable from the loop having quietly
stopped working. Each is the same shape as `assertDorCoherent` in triage.

Two smaller decisions in `runner.ts` generalise past this feature. The commit subject is checked
against Conventional Commits and a minimum description length, and **deliberately not** against
any "tests pass" phrasing: the skill forbids that claim in three places, but a pattern for it is
trivially reworded around, and a guard that catches the three phrasings someone thought of is
worse than none because it reads as enforcement. The structural answer is that the harness runs
the suite and its exit codes are the only evidence anything downstream acts on, so a false claim
in a commit body is inert. And the `Refs: <KEY>` trailer is appended by the harness rather than
asked for, because **everything derivable should be derived and the model asked only for what
requires judgement** — every field requested is a field that can come back wrong. That replaced a
real defect: the schema used to instruct the model to reference the key and nothing checked that
it had, which is a promise in prose with no mechanism behind it.

### Never a protected branch

`branch.ts` answers two questions and keeps them apart. `isWorkBranch` — may we create and push
this? — is an allowlist of prefixes (`fix` `feat` `chore` `docs` `test` `refactor` `perf`).
`isProtectedRef` — must we refuse this whatever else is true? — is a denylist of integration
names, compared case-insensitively, with `release/`, `hotfix/` and `support/` protected as whole
subtrees.

Both are needed, and the reason is that the allowlist is not the only path to a ref: a base ref, a
push target and a PR base arrive from three different places and only one of them goes through
`branchNameFor`. So the denylist is checked at every point a ref becomes an argument to `git`, and
`isWorkBranch` calls it too — `chore/main` and `feat/release/2026-09` satisfy the prefix rule while
naming exactly what the denylist exists to stop. Belt and braces is normally a smell; a rule stated
as absolutely as _"never main, never a protected branch"_ should not depend on one call site being
right.

Two details that were arrived at rather than assumed. A ref is refused if **either** reading of it
is protected — the raw name, and the name with a leading remote segment stripped — because
stripping is a guess that is wrong in both directions: `origin/main` needs the strip to be
recognised, and `release/2026-09` loses the very prefix that makes it protected. A test caught the
single-reading version passing `release/2026-09`. And the list is not fetched from the remote,
which would be the authoritative answer and the wrong mechanism: the natural failure mode of a
network call, a token and a permission scope is to return nothing, which a naive caller reads as
"not protected". A guard that fails open under load is worse than a short hardcoded list.

`worktree.ts` builds the branch name from the issue key and a slugified summary, then re-checks the
assembled string as a whole. The slug is an allowlist — everything outside `[a-z0-9]` becomes a
separator — rather than an escape, because the input is a Jira summary and the list of characters
git treats specially in a ref name is long enough that enumerating what to remove invites missing
one. A summary yielding no usable characters refuses rather than substituting a placeholder, since
two tickets sharing `untitled` would race for one branch. That module's own header is candid that
the final whole-string check kills no test on its own and cannot while the other two guards hold:
it is a backstop against a future edit loosening one of them, recorded as such rather than dressed
up as active defence. **A guard whose test passes when you unplug it is exactly what §11's rule
distrusts, and the honest version is to say which one it is.**

A failed run's worktree is **kept**. It is the only copy of what the solver actually did, and that
diff is the evidence a human needs to decide whether the ticket was mis-assessed as
`agent:solvable` or the solver simply got it wrong. `--force` is absent from the removal: if git
refuses because the worktree is dirty, that is git reporting uncommitted work at a point where
there should be none.

**Which run gets cleaned up is narrower than "on success", and the narrowing is the point.**
`removeWorktree` used to be called by nothing at all; the obvious fix — call it whenever the run
succeeded — is wrong, and working out why produced the better rule.

Nothing in this phase commits. `composeCommitMessage` composes a message and no `git commit` ever
consumes it, so the worktree of a `verified` run holds uncommitted work that exists in exactly one
place. Removing it on success would delete the artifact the run was for, and `describeSolveOutcome`
would still be telling the operator to go and read it. "Clean up on success" reads as tidiness and
would have been data loss.

So the rule is **remove when the run cannot have written anything**, which today means exactly one
outcome: `bailed`. Recon is the only pass with neither `Write` nor `Edit`, so its checkout is
pristine, and a bail is the _expected_ result whenever triage's blind fitness call was optimistic —
making it both the safest worktree to remove and the one that would otherwise accumulate fastest.
Every other outcome keeps its worktree, and now says so accurately.

Three things hold that reasoning in place rather than leaving it as a comment. The removal is not
forced, so if the assumption is ever falsified — a future recon that can write, or anything else
dirtying the checkout — git refuses and the run keeps the evidence. The refusal is not swallowed:
`RemoveResult` rides out on the outcome, so the CLI prints either "removed" or the path plus git's
reason, and cannot claim a directory is waiting when it is not. And the field is **required** on
the outcome type, so the compiler made every construction site state what happened to the worktree
instead of letting the question go unasked.

Still not cleaned up: the branch. `git worktree remove` leaves it behind, so a bailed run still
costs one empty ref on the pilot repository. Deleting it is a separate privilege and is not taken
here.

### The diff gate

`diff-gate.ts` is `assertPostable` for code — a mechanical check between the model finishing and
anything leaving the machine, deciding on the evidence rather than on the model's account of
itself. It is pure: no git, no fs, no subprocess, so every rule is testable without a repository
and the gate cannot itself be the thing that breaks. The orchestrator reads the real diff fresh
after the simplify pass and never from either model's self-report.

It parses `git diff --numstat -z`, and the `-z` is load-bearing rather than a preference: without
it git quotes and escapes unusual paths, so a filename containing a newline renders as two lines
and can forge a second numstat record — and the ticket text that suggested the filename is
attacker-controlled. Renames are handled explicitly and **both** the source and the destination
path are inspected, so a run cannot move a forbidden file somewhere innocuous and have only the
harmless half checked. An unparseable numstat throws rather than returning a verdict: a gate that
does not know what it is looking at must not reach the caller looking like a gate that refused.

Two refusal families, and a third that was deleted:

- **Location** — paths that escape the worktree, plus the git database, the CI configuration
  directories, environment files, the agent's own instruction and skill directories, and
  lockfiles. Each is a place where a change is either unreviewable by eye or grants the run more
  than the ticket did: a workflow file runs with repository privileges rather than being code, and
  a lockfile change can introduce code nobody in the repo wrote. A path that climbs with `..` is
  refused rather than normalised, because a normalised path is a different string from the one git
  will act on.
- **Verification integrity** — the subtle one, and §14.13. `package.json`, `tsconfig*.json`, the
  lint config and the vitest config are refused **unconditionally, at any size**, because they
  define what passing means. A one-line edit there is the dangerous size, not the safe one. It is
  a separate list from the forbidden paths only so the refusal can say why in the terms that
  matter: not "you touched a config file" but "you edited the scoreboard you are being scored on".
- **~~Size~~** — five files, two hundred lines, hardcoded, with no setting. **Deleted
  2026-09-06.** Both families above are sound in both directions: a path that escaped the worktree
  escaped it, and a run that edited `vitest.config.ts` has invalidated its own verification, no
  judgement required. A cap is sound in one — a run that lost the plot is usually wide, a wide
  diff is usually not a run that lost the plot — and the gate was deriving the second from the
  first. Three things made a veto the wrong tool for it specifically: it fires **after** the model
  pass, so it discards a spend rather than preventing one; it reads the diff cumulatively against
  `SOLVE_BASE_REF`, so it measures how large the pull request has become rather than what this run
  did; and a human merges every pull request this service opens, so it duplicated a judgement the
  reviewer makes anyway with more context. The argument was already written in this repository
  about `checkFailFirst`, which reports and never refuses for the same reason, and had simply not
  been applied here. `files` and `lines` are still computed and still printed on every verified
  run — the measurement survived, only the veto went.

  The evidence was PR #2663: a review round answering a human's request to widen a type touched
  six files, was refused at the gate after $1.77 had been spent on the pass, and posted nothing
  public. Four of the six files were one line each. The prose the cap shipped with claimed the
  recovery path was that _"a human looks, and either widens the cap for that ticket or agrees the
  ticket was mis-assessed"_ — there was no way to widen it for a ticket, and a `refused` round
  writes nothing to the pull request, so nobody looked.

An empty diff is refused too. A run that edits a file and reverts it, or writes only to an ignored
path, otherwise reaches the end looking exactly like success and opens an empty pull request.
Every reason is collected rather than the first, for the same reason the triage gate collects
them.

### `verify.ts` and its three outcomes

The model is never asked whether the tests passed. The harness runs them and reads exit codes,
because "did it work" is the one question the thing being judged must not answer about itself.

The commands are discovered from the pristine manifest — `git show <base>:package.json`, or
`git show <base>:pom.xml` for a Java repository, per _Two toolchains_ below — never from the
worktree. The header is blunt that this is necessary and **insufficient**, which is the
part it would be easy to stop at: knowing the base said `"test": "vitest run"` does not help if the
command executes in a worktree where `package.json` now says something else, because the package
manager reads the manifest on disk and not the one we consulted. So there are two halves, and the
second is that verification **refuses to run at all** unless the files defining what passing means
are still byte-identical to the base. That list is shared with the diff gate on purpose: the gate
refuses such a diff after the fact, this refuses to produce a verdict about it, and if the list
grows it grows for both.

For a Node base, the package manager comes from an allowlist keyed with `Object.hasOwn` rather than `in` — `in`
walks the prototype chain, so a manifest declaring `constructor@1` would satisfy an allowlist that
was never given that name. The step names (`check-types`/`typecheck`, `lint`, `test`) are literals
from a table and never keys read out of the manifest, which is why nothing here has to sanitise a
script name. `test` is required; a repository without one is refused rather than passed, because
with nothing to verify against a passing run and an untested one are indistinguishable.

The three outcomes are the point of the type:

| Outcome   | Means                                               | Example                                           |
| --------- | --------------------------------------------------- | ------------------------------------------------- |
| `passed`  | every step ran and passed                           | the only outcome that may become a pull request   |
| `failed`  | a step ran and did not pass — a fact about the code | the tests are red; a step timed out               |
| `refused` | no verdict was reached at all                       | the manifest was edited; install died; git failed |

**`refused` must never be reported as `failed`**, and the distinction is carried unchanged all the
way out of the orchestrator so that no caller can flatten it. `failed` is a statement about the
change the run produced; `refused` is the harness declining to have an opinion. Collapsing them
would let a broken harness read as a broken fix — and the `agent:solvable` assessment would then be
calibrated against evidence that was never gathered.

One outcome is assigned against intuition on purpose: **a timed-out step is a failure, not a
refusal.** It ran, it did not pass in the time allowed, and a hang is a plausible thing for a bad
fix to cause; the other reading is the one that lets an infinite loop through. Conversely a failed
`install` is a refusal, because nothing was verified and so there is nothing to have failed.

**The package manager's _version_ used to be discovered from nothing, and that is the limitation
the first real run hit.** `packageManagerOf` read `packageManager` from the manifest, split on `@`,
kept the name and threw the version away — so which binary ran was a property of `PATH`. On this
machine `PATH` gives pnpm 11; the pilot repo pins pnpm 9 in CI, its lockfile is
`lockfileVersion: 9.0`, and pnpm 11 no longer reads the `pnpm.overrides` block that lockfile was
generated from. So `install` died and no verdict was reached.

The outcome was right — `refused`, not `failed`, exactly as the table above requires, and the
solver's change was never blamed for a toolchain mismatch. Note also what the repository's own
declarations say: `engines.pnpm` is `">=9"`, which pnpm 11 satisfies, while the configuration only
works on 9. **The machine-readable claim and the machine-readable behaviour disagree, in someone
else's repository** — the same defect class this service exists to catch, found by running against
it.

The harness half is now fixed, and the shape of the fix is worth more than the bug. A declared
version is kept and the invocation becomes `corepack <name>@<version>`, which is Node's own shim
for this and needs nothing pre-installed. That immediately creates a new hole, because
**`packageManager: "pnpm@https://example.com/x.tgz"` is valid input to corepack** and means
"download this and execute it" — sourced from a manifest belonging to the repository under
verification. So `PACKAGE_MANAGER_VERSION` admits plain semver and nothing else: no URLs, no
ranges, no dist-tags. Ranges are refused for a second reason — they make "which pnpm ran" a fact
about the day rather than about the manifest, which defeats the point of reading the field.
`corepack` had to join `ALLOWED_EXECUTABLES`, where it is the one entry that contradicts that
list's own rule against programs that run other programs; it earns the place because it shims only
the three managers already listed, and because that version pattern is what stops it being
general. The two are coupled and must not drift apart.

**What this does not fix is the pilot repository**, which declares no `packageManager` at all and
so still gets whatever `PATH` offers. Refusing every repository without the field would mean
verifying almost nothing, so instead the undeclared case is _reported_: `versionNote` appends the
version that actually ran and points at a CI pin as the first thing to check. Diagnosing this the
first time took four runs and a detour through someone else's `package.json`; the refusal now says
in one line what that cost an afternoon.

**Verification needs registry credentials, and that is an architectural constraint, not a
detail.** The install step is the first thing in this whole service that talks to a package
registry, and the pilot repository's dependencies are private GitHub Packages. So a solve can
fail for a reason that has nothing to do with the ticket, the model or the repository: an expired
PAT, or one that was never SSO-authorised for the org. Both were hit while getting the first run
through, and they present differently — `401 unauthenticated` for the expired token, `403 …
protected by organization SAML enforcement` for the unauthorised one.

Diagnosing it was harder than it should have been because **a warm pnpm store hides a dead
token**. pnpm keeps its content-addressable store per major version (`store/v3` for pnpm 9,
`store/v11` for pnpm 11), so installs that resolve entirely from a warm store make no network
request at all and succeed with credentials that would be rejected. Switching pnpm major version
switched to a cold store, and that is what finally surfaced the 401 — the token had in fact been
expiring for some time, silently, behind a cache.

The consequence for the phases: this is fine for the daemon, which runs as the user's own process
and inherits `~/.npmrc`, and fine for hand-driving. It is not fine for anything that would run
this in CI or as another user, and it means a `refused` at the install step should always be read
as "check the credential" before it is read as anything about the code.

### `failed` is only true relative to a base that passes

This section used to end by declining to solve a known limitation. It said: if the base itself is
already failing lint or typecheck, every run on that repository fails through no fault of the
solver — and that proving otherwise would mean verifying the base too and doubling the runtime of
every solve. That reasoning was written with Node in mind, and on 2026-09-05 a Maven run produced
the counter-evidence, so the paragraph is replaced rather than qualified.

**What happened.** SSX-3801, `insurance-commerce-rest-api`. The model wrote a fix, the diff gate
passed it, `mvn -B test` exited 1, and the run was reported as `failed` — a verdict about the
change. It was not. `git-commit-id-plugin:4.9.10` is bound to `initialize` and reads `.git`
directly; in a linked worktree `.git` is a _file_ containing `gitdir: …`, not a directory, and
that plugin version predates worktree support. The build died eleven lines in. `Tests run:` never
appeared. The fix was never compiled, let alone tested, and the service said it had failed.

The control run settles it: same Maven, same JDK, same plugin, `BUILD SUCCESS` in the main
checkout and `BUILD FAILURE` in the worktree.

**Why Node never surfaced this.** Nothing in the Node toolchain reads `.git` — `pnpm install`,
`tsc`, `vitest` and `oxlint` read files in the tree and nothing else. Maven was the first
toolchain whose build depends on repository _metadata layout_, so worktree isolation, the thing
that makes the solver safe to run at all, was the thing that broke it. Node was immune by
accident. And the pilot repo's base was always green, so the missing premise never said anything
false; it was simply never tested.

**The fix.** `verifyBase` runs the discovered plan against the pristine worktree, immediately
after it is cut and deliberately before any pass. Green means a later red is genuinely about the
change. Red returns the `unusable-base` outcome, which is a statement about the repository — the
sentence posted to the ticket names the repository as its subject, and a mutation swapping that
subject for "the change" is caught by test.

**The runtime argument was wrong in the case that matters.** Doubling is the cost on a _green_
base, and there it is real: one extra typecheck, lint and test, with the install nearly free the
second time because the worktree is already populated. On a _red_ base — the case the old
paragraph was about — the base check is strictly cheaper than what it replaces, because it
refuses before spending a solve. So the old text traded a saving in the good case against a
wrong answer in the bad one, and the wrong answer is the expensive half: it costs a reviewer's
time and it feeds the dev-lens calibration a score for a fix nobody ever ran.

**Measured rather than feared.** The worry about the doubling was that a large Java suite would
make it intolerable, and a cache of base results keyed by `(repo, baseRef)` was sketched to avoid
it. It is not needed yet: `mvn -B -Dmaven.gitcommitid.skip=true test` on
`insurance-commerce-rest-api` — 4562 tests — runs in **1 minute 4 seconds** warm. That is the
whole cost of the base check on the largest repository in scope, so the cache stays unbuilt until
something measures worse. Recorded here because the guess that prompted it was an order of
magnitude out, and the next person to worry about this should start from the number.

Two properties are pinned by test rather than left to reading. `verifyRequestOf` is the only
place a `VerifyRequest` is built, so the base check and the real check cannot drift apart into
different experiments; and the base check runs before the first pass, asserted by a harness that
throws if any pass runs at all.

The per-step reporting the old paragraph offered as a mitigation is kept — it is still how a step
failing identically across tickets is spotted — but it is no longer the answer.

### Two toolchains, and why the second one looks nothing like the first

Added 2026-09-05, after a run against `insurance-commerce-rest-api` — a Java service — refused at
verification. The refusal was correct and it was predicted before the run: `discoverPlan` read
`git show <base>:package.json`, got nothing, and said so. But "this service can only verify
JavaScript" is a limit of the harness, not of the idea, and half the board's bugs are in Java.

The toolchain is now chosen by which manifest the **base** carries: `package.json` ⇒ Node,
`pom.xml` ⇒ Maven. The base and not the worktree, for the reason the whole module exists — a run
that added a `pom.xml` would otherwise get to pick which build system grades it.

**A base carrying both is refused rather than resolved.** Two build systems define what passing
means, and whichever were checked first would win, which would make the verdict a property of the
order of two lines in this file. This is the same shape as `repoFromLabels` refusing a ticket with
two `svc:` labels: a contradiction must not be resolved into a decision. The cost is real —
a polyglot repository cannot be verified here at all — and it is the cost worth paying, because
the alternative failure is silent and this one is a sentence in an artifact.

Four things about the Maven plan are deliberately unlike the Node one:

**No install step.** `mvn test` resolves its own dependencies; a separate install phase would
either be a no-op or a second full download. So `VerificationPlan.install` became nullable, and
`verify` skips the phase rather than running something harmless. An "install" line in the report
that never ran is a step a reader would count as evidence.

**The single test step is marked `cold`, and a cold step is charged the _install_ budget.** A first
Java build on a machine downloads most of Maven Central. On the step budget it times out, and a
timed-out step is `failed` — so the machine's empty `~/.m2` would be reported as the change being
wrong. That is exactly the `refused`/`failed` confusion the outcome table exists to prevent,
arriving through the timeout instead of through the outcome mapping. `Step.cold` is what keeps the
two apart, and it is a property of the step rather than of the toolchain so that the budget rule
stays readable in `verify` without a `toolchain === "maven"` test.

**`mvn` from `PATH`, and deliberately never `./mvnw`.** Running the wrapper is the conventional
thing to do and it pins the version, which is the one thing `PATH` cannot do. It is also a file
inside the repository being verified, which a solve run has write access to — so executing it
would make "which program verifies this change" answerable by the change. That is the single
property `ALLOWED_EXECUTABLES` exists to deny, and the same reason `sh` and `make` are excluded by
name. The accepted cost is a possible version mismatch with the repository's CI; it is a mismatch
rather than an execution channel, and `plan.note` says so on every Maven refusal and on the cold
step's failure. The wrapper is refused by the diff gate all the same, for a different reason: this
harness will not run it, but everyone else's CI will.

**Exactly one flag, `-B`, and exactly one property.** The temptation is `--no-transfer-progress`,
`-q`, `-Dstyle.color=none`. Each is a way for the _test_ step to exit non-zero because Maven did
not recognise a flag — and a non-zero test step is reported as `failed`, which is a harness
mistake printed as a verdict about the model's code. `-B` (batch mode) has been in Maven since 2.0
and does the one necessary thing: stops it waiting on a terminal that is not there.

The property is `-Dmaven.gitcommitid.skip=true`, added 2026-09-05, and it is the only concession
this harness makes to how a particular repository builds. **The flag/property distinction is what
makes it safe**: Maven silently ignores a user property no plugin claims, so this is inert on a
repository that does not have the plugin, whereas an unrecognised flag would fail the test step
everywhere. A test asserts that every argument between `mvn` and the goal is either `-B` or starts
with `-D`, so the next person to reach for a flag has to read this paragraph first.

Why it is needed: `pl.project13.maven:git-commit-id-plugin:4.9.10` binds its `revision` goal to
`initialize`, so it runs before anything compiles, and its `GitDirLocator` parses the `.git` file
with `split(":")` and no trim. In a linked worktree that file reads `gitdir: /abs/path`, so the
plugin receives `" /abs/path"` with a leading space, `File.isAbsolute()` returns false, and an
absolute path is resolved as a relative one. Measured: `Could not get HEAD Ref` nine seconds into
the build in a worktree, `BUILD SUCCESS` for the same commit in an ordinary checkout.

Three properties make skipping it acceptable rather than merely convenient. It writes
`git.properties`, a metadata file — it compiles nothing, runs nothing, and skips no test; nothing
in that repository's source, tests, `Dockerfile` or CI reads the file it produces; and the
plugin's other goal, `validateRevision`, binds to `verify`, which this plan never reaches.

The cost is real and is printed in the failure reason rather than buried here: **this is not
byte-for-byte the build CI runs.** The alternative that avoids that — cutting a full local clone
per solve so Maven sees an ordinary `.git` directory — was measured and works, but it buys
fidelity on a metadata file at the price of a second isolation strategy and reworked push
mechanics for Phase D, since a local clone's `origin` is a path on disk rather than GitHub. If a
second worktree-hostile plugin ever turns up, that trade flips and the clone is the right answer.

The same logic ruled out a Maven warm-up step. `mvn -DskipTests test-compile` before the real run
would separate "downloading the world" from "the tests", which is what the Node split buys — but
it also compiles the model's code, and an install failure maps to `refused`. A fix that does not
compile would then be booked as "no verdict reached" instead of `failed`, which is the worst
single error this module can make. So Maven gets one step that does everything, and the budget
does the work the split would have done.

What _is_ checked before planning is that Maven exists: `mvn -v` at plan time, and a refusal
naming the harness if it does not. Without that probe an absent Maven makes `mvn -B test` exit
non-zero, and a machine with no Java installed reports every Java fix as broken.

One repair fell out of the rewrite. `git show` failing used to mean one thing, "could not read the
manifest"; with two manifests, non-zero legitimately means "this one is not here". So `Shown`
distinguishes `found`, `absent` and `unreadable`, and only the timeout can be told apart
mechanically — `git show` exits 128 both for a missing path and for a missing ref. A wrong base ref
therefore reads as both manifests absent, and that refusal names the ref rather than asserting the
repository has no build system.

Nothing else in the pipeline branches on language. The `agent-solve` skill was checked line by
line for it and needed no change: it never names TypeScript, React, pnpm or vitest, and asks the
model to find the project's own conventions rather than supplying any. The Node-versus-Maven split
lives entirely in `discoverPlan`, and the tests assert the negative in both directions — no Node
command is ever issued against a Maven base, and no `mvn` against a Node one.

### An undeclared package manager, and the temporary shim for one

`invocationOf` runs `corepack <name>@<version>` when the base manifest declares `packageManager`,
and the bare name from `PATH` when it does not. `versionNote` appends a sentence to any install
refusal saying which of the two happened, because the second case is the likelier explanation for
an install that dies in a repository whose own CI is green.

That sentence earned itself on 2026-09-05, on the first real `--advance`. `buy-insurance-advisor-web`
declares no `packageManager`, so the install ran this machine's pnpm 11 — which **no longer reads
the `pnpm` field from `package.json`** — and refused the frozen install because the seven security
overrides recorded in the lockfile were not in its configuration. The harness named the cause in
its own refusal text without being asked.

The fix belongs in that repository and is open as
[buy-insurance-advisor-web#2659](https://github.com/storebrand-digital/buy-insurance-advisor-web/pull/2659):
declare `pnpm@9.15.9`, and every consumer — corepack, `pnpm/action-setup`, a developer's shell and
this harness — resolves the same version. **Until it merges**, a solve or review round against that
repository needs pnpm 9 on `PATH`:

```sh
PATH="$HOME/.local/share/pnpm9-shim:$PATH" \
  node --env-file-if-exists=.env src/cli/solve-once.ts SSX-3822 --advance
```

`~/.local/share/pnpm9-shim/pnpm` is a two-line `exec corepack pnpm@9.15.9 "$@"`. Three notes, each
of which cost a run to learn:

- **`node` directly, not `pnpm solve:once`.** The shim shadows `pnpm` for the whole process tree,
  and this repository's own `engines.pnpm` is `>=11`, so the outer command refuses before the inner
  one gets a chance.
- **Not `/tmp`.** The previous shim lived there and was gone by the time it was next needed, which
  is how this was rediscovered rather than remembered.
- **It expires by itself.** Once #2659 merges the manifest declares a version, `invocationOf` takes
  the corepack path, and `PATH` stops mattering. Delete the directory then; the block above is the
  reminder.

### Delivery

`pr.ts` is the dumbest module in the phase on purpose: it builds argv arrays, hands them to the
runner, and translates exit codes into a small closed set of outcomes. It decides nothing about
whether the delivery _should_ happen — that was answered upstream, and answering it twice in two
places is how the two answers start disagreeing.

- **argv arrays, never a command string.** This matters more here than anywhere else in the phase
  because of where the arguments come from: ticket text → model → `--title` / `--body`. With a
  shell in that path, a summary containing shell metacharacters is remote code execution against
  the machine running the solver; with argv it is a pull request with a stupid title. There is no
  escaping function in the file and there must not be one — an escaper is a thing that can have a
  bug, and the absence of a shell is a thing that cannot.
- **No `--force`, in any form.** The branch was created with `git worktree add -b`, which fails if
  it already exists, so a push rejected as non-fast-forward means something this service does not
  model is writing to that ref — a second solver, a human correction, a retried run. Every one of
  those is a case where stopping is right. The temptation will come from a real failure; the fix
  is to stop reusing the branch, not to learn to overwrite.
- **The PR number is parsed, not guessed** — an end-anchored regex against the trimmed last line
  of `gh pr create`, and a `failed` outcome if it does not match. No fallback to `gh pr list`, no
  "the newest PR on the branch is ours". The number is then passed to `gh pr edit`, `gh pr view`
  and `gh pr ready`, and a wrong one does not fail: it succeeds against somebody else's pull
  request, and `gh pr ready` in particular takes a human's draft out of draft.
- **The commit identity is passed per-invocation**, with `git -c user.name=… -c user.email=…`
  before the subcommand, never read from ambient config and never written into the worktree's.
  The solver runs in a worktree of somebody else's repository on a machine whose `~/.gitconfig`
  belongs to a human, and inheriting that identity would attribute machine-written commits to
  them — in `git blame`, in the PR author line, and in whatever reads CODEOWNERS.
- **The pull request is a draft, and nothing merges.** There is no merge call in `pr.ts` or
  `delivery.ts`. A human merges, always. Undrafting is a _transition_, not the end — see below.
- **Reviewer chrome is dropped before the pass sees it.** Copilot ends every review with a
  promotional block, and the pass answered it as though it were a request. `stripReviewerChrome`
  needs two signals together — a trailing rule _and_ a link to GitHub's own Copilot docs — for the
  same reason `isReviewerError` needs two phrases: a rule alone, or a 💡 alone, is something a
  reviewer writes when making a real point, and swallowing feedback is the one failure here nobody
  recovers from by noticing. It is scoped to the reviewer, so quoting the block back does not get a
  person's own words edited.

`delivery.ts` splits the round-trip into `publish` and `advance`, and `advance` **looks once and
returns** rather than polling. The caller decides when to look again, which is what lets the review
cycle survive a restart: the state lives in the pull request and on the ticket, not in a promise
somebody is awaiting. Opening the pull request is the only step that creates something durable and
externally visible, so the case where the PR was created but the reviewer request failed gets its
own outcome — `published-unreviewed` — precisely so that an ordinary retry cannot open a second
pull request against the same branch.

Our own comments are filtered out of the feedback, or the second round is handed the first round's
replies as though a reviewer had written them, which is a loop with no new information in it.
**What identifies them is the `bot: ` prefix on the body, never the author.** `gh` is
authenticated as the operator, so a comment this service posts is authored by a human's account
and is indistinguishable by login from that human's own review — matching on `BotIdentity` would
both miss every comment we wrote and, worse, mistake a person's comment for machine state to
overwrite. The threads use the same rule in a different shape: `unansweredThreads` drops a thread
whose **last** comment is ours, which answers a bot reviewer restating a settled point without
needing a timestamp, and retries by itself when a reply failed to post.

#### The look is cheap and the round is not, so they are two functions

`advance` used to cut a worktree and then find out whether there was anything to answer. It is now
three steps — `surveyReview`, `request.attach()`, `runRound` — and the seam falls where the money
starts.

**The survey needs no checkout, which was not obvious until the `gh` calls were read side by
side.** `readReview` passes `--repo owner/name`, `readReviewThreads` passes the owner and the name
as separate GraphQL variables, and `markReady` passes `--repo` too. None of them care what
directory they run in, so `worktreePath` in those requests is only a cwd. Everything decidable
about a pull request — merged, closed, waiting, capped, out of rounds, ready to hand over — is
decidable from two reads. A look that finds nothing costs those two reads and stops: no `fetch`, no
`worktree add`, no install, no model call.

**The worktree is therefore a function, not a value.** `AdvanceRequest.attach` is a
`WorktreeSource` the survey never calls if there is nothing to do, and a refusal from it gets its
own `failed` stage (`"worktree"`) because of where it happens: after the round is decided and
before it is reserved, so no marker has moved and no round has been spent. **The reservation stays
on the far side of the checkout on purpose** — reserving first and then failing to attach would
spend a round on a pull request nothing had touched.

**Silence is wall-clock, read from the pull request.** `MAX_REVIEW_WAITS` counted consecutive quiet
polls in a `let` on the chain's stack, which made it the only bound in this service living in a
process rather than in the remote system — it could not survive a restart, and a second look could
not see it. Worse, `MAX_REVIEW_WAITS × REVIEW_POLL_MS` _was_ the patience, so halving the interval
silently halved it and nothing in either name said so. `REVIEW_SILENCE_MS` is measured by
`silence.ts` from the newest dated thing on the pull request, with the pull request's own
`createdAt` as the floor. Three rules there are load-bearing: a payload with no readable
`createdAt` is **refused**, not defaulted to `""`, because a default disables the bound on exactly
the pull requests that have nothing else dated on them; `newestAt` is computed over every entry
_before_ the whitespace filter, since an approving review with an empty body is still something
that happened; and `hasGoneQuiet(null, …)` is **false**, because a bound that fires when it cannot
measure is a timeout on the measurement, and what it would end is a pull request somebody is
waiting on.

One latent write went with it: `undraft` and `leaveDraft` called `gh pr ready` unconditionally, and
`ready` is the outcome of every look at an undrafted pull request waiting for a human to merge. At
one look a minute that is a write per pull request per minute, forever. Both check `isDraft` first.

#### A round reports what it did, in four fields that used to be one boolean

Each of these replaced a value that was wrong in a way the renderer then repeated out loud, which
is this project's own defect class committed inside it. They are worth keeping apart because each
answers a different person's question.

| field               | says                                          | why it is not inferable                                                                                                                                                        |
| ------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pushed`            | did this round commit anything                | a round that only answers questions is a _successful_ round, and the headline used to call it a push — sending an operator to look for a commit that does not exist            |
| `reviewerRequested` | `asked` / `failed` / `unnecessary`            | the old boolean's `false` meant "add the reviewer by hand", so a round with nothing to show printed a call to action whose only effect is a second review of an unchanged diff |
| `spoken`            | did the round's answer reach the pull request | a review body has no thread, so `answerThreads` cannot reply to one; without this the argument reaches a terminal and nobody else                                              |
| `undrafted`         | `undrafted` / `failed` / `still-drafting`     | undrafting is now a transition, and the reason it did _not_ happen is ordinary rather than a fault                                                                             |

Two rules connect them, and both were learned by running the loop rather than by reading it.

**The re-request is for a commit, not for a round.** `reRequest` is gated on `pushed`. Asking a
reviewer to re-read a byte-identical tree buys a paid review whose only possible content is the
previous review again — and then the instability rule has to spend the _next_ round recognising it.
That rule exists for a reviewer that changes its mind unprompted; the loop was provoking it.

**Draft means _this side is still working_.** A round that pushed stays a draft. A round that
changed nothing has done all it can, so it undrafts and hands over — but only once the answer is
**visible**: a failed comment post or a failed thread reply holds the draft, because undrafting
there shows a human an objection with the rebuttal nowhere. The tempting justification for this is
that it saves a round, and that is false — `ready` is decided before the pass runs, so an empty
inbox costs nothing. The real reason is that the wait is unbounded: on a pull request people are
still commenting on, the draft flag never clears, and a human reviews something whose own flag says
it is unfinished.

And the paragraph most likely to be forgotten, so it is repeated here: **the review loop is a
closed loop carrying untrusted text, and nothing in `pr.ts` breaks it.** The PR body is
model-written, the review bot reads it, the comments and the inline threads come back through
`formatReviewFeedback` and `formatThreads` into one block and reach the model verbatim — delimiters and all, and those delimiters are forgeable by any comment
containing the same string. The containment is structural and lives elsewhere: the denied tool
set, the diff gate, verification from the pristine manifest, and a draft with a human on the other
end. A keyword filter there would be worse than useless, because it would suggest the loop is
contained at that layer when it is not. This is a known and accepted limitation of running the
review loop at all.

### The `agent-solve` skill

`.claude/skills/agent-solve/` is the model-side half of the contract: `SKILL.md` and
`SOLVE_INSTRUCTIONS.md`. Unlike `intake-triage` it is ours rather than Jacob's, and it is written
for a session with no human at the terminal — which inverts `intake-triage`'s safety model, since
that skill is built around a confirm gate and there is no gate here and nobody to ask. Its
frontmatter sets `disable-model-invocation: true`, and the only thing in this repository that
invokes it is `buildSolvePrompt`.

It opens with a table naming who does what — the harness creates the worktree, runs the tests,
bounds the diff, commits and opens the PR; the session edits code and nothing else — and is
explicit that this is not self-restraint, because a skill file cannot restrict itself and text in
one saying "do not edit" would be a description of intent rather than a control. Its three
standing rules are worth knowing: **bailing is a success** (triage made the `agent:solvable` call
without reading any source, so recon is the first and only thing able to discover the call was
wrong), **never state that anything passed** (it cannot run tests, so it cannot know, and the
harness's exit codes are the only evidence anyone acts on), and **add no dependencies** — a task
that cannot be done with what the repository already has is a bail.

**A drift worth recording, because the record of it drifted too.** This paragraph said for some
time that `SKILL.md` described _two_ passes while the instructions and `runner.ts` had four. By
2026-09-08 both halves of that sentence were wrong in different directions: the code has **five**
(`PASSES = ["recon", "fix", "simplify", "review", "merge"]`), `SOLVE_INSTRUCTIONS.md` documents
five (§1, §2, §2a, §2b, §2c), and `SKILL.md` listed five in its body under a heading that still
said "The four passes". So the file recording the drift had itself gone stale by a different
amount than the thing it was recording — a note about rot, rotting.

Fixed in the same commit as this paragraph: the heading now reads "The five passes". It is left
written up rather than silently corrected because the failure is the interesting part. Nothing
reads the count, so no behaviour ever depended on it, and that is exactly why three separate
numbers coexisted in three files for weeks. **A fact nothing mechanically checks is a fact that
will be wrong**, which is the argument for `PASSES` being one exported list the tests iterate
rather than a number anybody writes down.

### What is inert, and why that is the plan

`orchestrator.ts`, `passes.ts` and `exec.ts` are now **wired**: `createSolveRunDeps` builds the
`CommandRunner` and the `PassRunner`, and `pnpm solve:once <KEY> --solve` reaches `solveTicket`.
That was phase C's privilege grant and it is a real one — this process can now write files in
another repository's worktree and run `git`, `gh` and a package manager. **`delivery.ts`, `pr.ts`
and `claim.ts` are wired now too**, in later grants of their own: `createClaimCapabilities` builds
the label writer, `publish` pushes and opens the pull request, and `advance` pushes to one a
reviewer is reading. There is no inert half of this pipeline left.

The heading above therefore describes a state this repository has now left, and it is kept because
the shape of the argument still governs what comes next. **Each capability was built and reviewed
before it was granted, and the grant was a separate commit in each case** — which is only
meaningful if the ungranted state was real. It was: what refused was not a flag anyone could flip
and not a promise in a comment, it was the absence of a caller, and each grant is an edit to a
composition function where a reviewer would see it. The gates were written before the thing they
gate for the same reason — shipping a solver and then its bound would leave a window in which an
unbounded solver exists.

What `unavailable()` in `solve-args.ts` still does is narrower, and its own doc comment says so:
it refuses a rung that is not _configured_, which today means `--pr` without a
`SOLVE_GITHUB_OWNER`. The composition version of that check would now return `null` four times.
The ladder itself is cumulative — `--pr` claims, solves and opens the pull request — while
`--advance` is a separate mode rather than a fifth rung, because it operates on a pull request a
finished run created and implying `--solve` would mean re-solving the ticket before touching the
review.

The last thing to be wired was the daemon, and it went in two pieces rather than one: the review
sweep on 2026-09-06, then the solve queue and the sendback watch. **All of it is wired now.** The
property the daemon adds is _nobody is watching_, which is the last property you want rather than
an early one, and the ordering held right to the end — every stage was checked by a person typing a
command and reading the output before the loop was given it. What the loop added was no capability
at all: by then the bot could already do everything, and the daemon only changed who asks.

So this heading is now doubly historical, and both halves are worth keeping for the same reason.
There is no inert code left, and there is no unwatched stage left either. What remains from the
argument is the standard the next capability will be held to: **built, reviewed, driven by hand
against a named ticket, and granted in a commit a reviewer can see.** The one item that did _not_
clear that bar before the loop was switched on is cost per ticket per day, which §13 now carries as
the file's largest open item — and the reason it is worth naming there rather than here is that it
is the only gate the plan set for the daemon that the daemon did not wait for.
