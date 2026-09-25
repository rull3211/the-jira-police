# the-jira-police — architecture: overview

The governing constraint, the three loops, the state and correctness rules, the subprocess
contract shared by triage and solve, refusals as artifacts, and the failure and testing rules that
apply to the whole service rather than to one module.

Index: [`ARCHITECTURE.md`](../ARCHITECTURE.md)

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

The daemon — `pnpm start:daemon`, or the daemon half of `pnpm start` — awaits three `runLoop`s in
one `Promise.all`:

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

## 5. State and the correctness rules

`state/poll.json` — a cursor and a bounded set of seen keys, written via temp-file + rename so a
crash mid-write cannot leave truncated state. Both halves are needed: the cursor bounds the
window, the key set is what actually prevents duplicate paid runs.

Three rules drive the shape of `runPollCycle`:

1. **An issue is recorded as seen only after its report is safely written.** Marking it earlier
   means a transient sink failure drops the ticket for good.
2. **The cursor advances only across an unbroken run of successes from the oldest issue forward.**
   If #3 fails but #4 succeeds, advancing to #4 strands #3 outside the next window. Stopping at
   the gap costs a little rework and loses nothing. **This is a fact about `created` order, not
   about the order the loop ran in** — `settledCursor` (`triage/order.ts`) derives it from the
   created-ascending list and the set of successes, which is what lets `TRIAGE_STATUS_PRIORITY`
   below reorder the spending without touching the guarantee. A failure, a shutdown and an issue
   not yet reached all stop the run identically: none of them proves the issue was handled.
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
| A round reserves and never lands                | The marker's `Last landed:` stays behind its count, so the next survey reports `unlanded` and leaves the draft alone rather than reading a cursor the round moved and threads it answered as nothing left to do       |
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

## 11. Test doubles and the testing rule

`.claude/skills/` holds seven directories and only four are the service's. `intake-triage` (§12) and
`agent-solve` (§24) are the real ones; the two below are their stand-ins. **`dev-house-rules`,
`claude-validation-work` and `scaffolding-audit` are not runtime skills at all** — they are
development and audit discipline for this repository, read by whoever is working on it and by
nothing the service runs. That is structural rather than a convention:
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
not. `poller.test.ts`'s DST fixtures use the site's real local-offset format (`+0200`/`+0100`)
instead — the note recording that the format was checked against a live response was cut in the
September 2026 comment-length pass, so that provenance now lives in git history rather than the
test.
