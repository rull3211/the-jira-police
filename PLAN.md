# the-jira-police — bug-squashing agents

> **Progress, 2026-09-08.** Phases A through F are built. The service discovers a ticket, triages
> it, gates the result, posts a verdict, claims a solvable one, solves it in an isolated worktree,
> opens a pull request, answers the reviewer, keeps the branch current with its base, labels the
> ticket for whatever happened, and watches the ones it sent back for an answer. **2526 tests in 70
> files**, no build step.
>
> **It loops, and it claims.** `src/index.ts:247` is a `Promise.all` over three loops — grooming,
> review and watch — and the review loop advances _and then_ claims in one tick
> (`review-loop.ts:114`), gated only on `SOLVE_ENABLED`. Earlier revisions of this header said the
> solve half was "still a person typing a command" and that "nothing loops". Both were false, and
> they were the two most important facts in the file.
>
> **A human always merges. The bot has no merge path.**
>
> This file holds **what is not built, and nothing else.** The built system is described in
> `ARCHITECTURE.md`; how to run it is in `README.md`; what a run taught goes into the rule it changes
> in `dev-house-rules`, or into `INCIDENTS.md`, or nowhere. Anything finished is deleted from here
> rather than struck through, because a plan that keeps its own history is a plan nobody can read the
> open items out of — and a "what was learned" section that only ever took deposits reached 409 lines
> before a human asked why the file kept growing.

## Context

The service grooms tickets: it discovers new SSX issues over Jira REST, runs `/intake-triage`
headlessly, gates the result, and posts a verdict. On top of that it solves the subset a fitness
assessment marks safe. Two things drove the design and still do:

1. **The solver needs `Write` and `Edit`.** No component in this service had ever had either. That
   is a real privilege escalation and gets isolation and mechanical — not model-asserted —
   verification.
2. **Triage cannot read source code.** The fitness call is made from the ticket plus the knowledge
   vault only. It is a _candidate_ signal, not a guarantee, so the solver re-checks against real
   code and is allowed to bail before writing anything.

Default posture is **manual**: nothing is solved until a human adds a label.

---

## What is not built

**The numbers are identifiers, not an ordering, so they are never reused and the sequence has
holes.** Other documents cite `PLAN.md §N`, and renumbering on every deletion would silently
repoint every one of them — the failure §14 exists about. A missing number almost always means that
entry shipped and was deleted. **One of them did not ship**, and it is named with the holes below
rather than here, because the qualifier is worth nothing without the case: a hole list that flattens
"built" and "abandoned" sends somebody into the git history looking for a feature nobody wrote. The settled half of the two guardrail entries now lives in `ARCHITECTURE.md` §16,
every file that cited them has been repointed there, and what is still open from them is §17.

<!-- refs:off -->

**The holes are §12, §15, §16, §18, §20, §21, §23, §25, §26, §27, §28 and §29, and this line names them rather than
citing them.** A catalogue of deleted sections dangles by construction — the targets are gone and can never be
repointed — so it belongs in a `refs:off` region rather than in `KNOWN_DANGLING`, which holds a debt
still and would be holding entries nobody could ever pay. That its docstring once said the debt
"goes to zero" is no longer part of this argument: the claim is withdrawn in `docs-check.ts`, on
the evidence that the number has not moved once in forty-one commits.

**Only §18 was ever actually counted, and finding out why is §19.** Adding the first four names
raised the dangling count by two, not by four: the resolver pools section ids from every document
into one set, so a dead `PLAN.md §12` resolves against `ARCHITECTURE.md`'s live §12, and the same
for §15 and §16. §18 dangled only because no document here has an eighteenth section. The region is
still right — a hole list should not be checked — but it is buying much less than it looks like it
is buying.

§12 and §15 were the guardrail entries; §16 was the audit branch and shipped whole; §20 was the
scaffolding-audit skill, shipped in `7237af5` and retired here rather than left standing as an open
entry; §18 was opened and shipped inside a single session — the shortest-lived entry here, and still
worth a permanent number, because the session was compacted once while it was open; §25 was the
fitness block owning the region it writes, shipped in PR #37; §26 and §27 were the closed-ticket
clause and the status allowlist that narrowed it, and each is a hole one commit after it was written
— opened and deleted inside the branch that built it, which is what the rule now asks for. **§24 is
absent from that list and is not a hole** — it was skipped rather than spent, for the reason §19
gives. §28 was `TRIAGE_STATUS_PRIORITY` and the cursor decoupling under it, opened and deleted
inside the branch that built it. **§29 is the exception the paragraph above flags** — the handed-off
unsubscribe, deleted without shipping when the operator deferred it, and the decision it recorded
(unsubscribe rather than a quiet state, chosen knowing it is one-way) survives only in `1f8a3f4`'s
parent. Nothing in the tree carries it, which is the cost of deferring by deletion and is why it is
written down here. The triage-selection entries are now all closed, so the next entry is §30.

<!-- refs:on -->

### 1. Which model runs which task, and nothing chooses today

Requested 2026-09-06, and **the first fact is that there is no setting to change.** `--model`
appears nowhere in this tree. Six task kinds spawn a subprocess — the triage analyst and the poster
(`triage/runner.ts`, `triage/poster.ts`), the solve passes (`solve/runner.ts`), and the ticket
commenter (`solve/commenter.ts`) — and every one of them inherits whatever `storecode` happens to
default to. Three argument builders, one flag each: the mechanism is trivial and the policy is the
whole of the work.

**Two changes, and only the second is the feature.** _Recording_ which model a pass ran under costs
nothing and should not wait for the choosing. Every cost figure in this file — triage $1.56, poster
$0.45, recon $1.58, the ticket comment $0.40, a review round $0.94 — is a measurement of an unnamed
model. None of them can be reproduced, compared, or defended, and the cost-per-ticket-per-day
number in §2 would inherit that at a larger scale and with nobody watching.

**Where a cheaper model is safe is decided by the gate, not by the price.** The rule: downgrade
where a mechanical gate checks the whole output, and do not downgrade where the gate only bounds a
judgement it cannot check. Four consequences, and three of them cut against the obvious answer:

- **The solve passes take the strongest, and this is measured rather than asserted.** `recon`,
  `fix` and `review` are bounded by the diff gate and by mechanical verification — and neither can
  tell a right fix from a plausible wrong one. SSX-3833 is the worked example: `setMonth(month - 1)`
  is the tempting one-character change, it is wrong, and the fail-first replay put a number on how
  little the machinery would have noticed — **1 of 7 new assertions went red against it, against 7
  of 7 for the original bug.** The gates bound the blast radius; they do not bound the quality of
  the judgement, and the judgement is what is being bought.
- **The analyst is where cheap looks safest and is not.** Its output is schema-checked and
  gate-checked, which by the rule above argues for a downgrade — except the fitness call inside it
  decides whether a paid solve happens at all, and neither the schema nor the gate can tell a right
  call from a wrong one. SSX-3822 cost roughly **$6 to be refused three times for two reasons that
  were both wrong**, which is more than the runs that produced it.
- **The poster is the honest candidate.** Its whole output is a label set and a comment shape, and
  `assertPostable` and `checkLabels` check it mechanically, so a weaker model fails the gate rather
  than posting something wrong. That is the case the rule was written for.
- **The commenter is the cheapest task and the least guarded, which is not the same as safe.** It
  is handed finished prose and asked to post it verbatim; there is no gate, and nothing compares
  what was posted against what was handed over. Its known failure is already recorded — the API
  re-serialised the text server-side — so a weaker model rewording the text would land in the one
  channel this service does not check.

**Shape, and the fail-closed direction is not the obvious one.** One setting per task rather than
one global knob, because a global knob is how everything ends up on the cheap model or everything
on the expensive one, which is the choice this section exists to stop making by accident. The map
copies `SCHEMA_FOR`'s `Record<Pass, …>` so that adding a pass fails to compile instead of
inheriting its neighbour's model — the same bug that map already caught once. **Unset means today's
behaviour**, whatever the CLI defaults to, because defaulting to "the strongest" would change the
cost of every run on the day the setting lands, with nothing in the diff saying so; an
_unrecognised_ name is a startup error, like `SOLVE_MODE`, and not a fallback. A downgrade has to
be typed out against the task it applies to.

This is the largest unbuilt block in the file, and the recording half is a prerequisite for the
next item.

### 2. Cost per ticket per day

A triage run was long quoted at $0.11 and that is wrong by 14×: a single bailed ticket measured
**$3.99**, and a review round $0.94. A _completed_ solve has never been costed at all. Three
changes turned single-shot costs into recurring ones, so a per-run number is no longer enough.
**The most overdue item in this file.**

Three known inputs to it that are already measured or argued and have never been added up: the
chain rebuilds its worktree every round, so twenty rounds is twenty installs; the review tick
re-reads every open bot pull request, so per-tick work scales with _unmerged_ pull requests rather
than active ones; and a formatted approval costs one terminal round per pull request (§8).

### 3. The review round has no `verifyBase`

`verifyBase` is called from `solveTicket` and nowhere else, so `resolveReview`'s `failed` is not
relative to a base anyone proved green. On the solve path a red build before the change is
`unusable-base` and says so; on a review round the same redness is attributed to the round. Now
that the base is merged in every round, a base that is broken upstream lands in the branch and the
round takes the blame for it. Recorded, not fixed.

### 4. Attachment bytes, and the decision that is the operator's rather than mine

The watch check is handed attachments as **names, types and sizes only**: no bytes are fetched, and
the copy in `signals.ts` is field by field so the day that changes it is a visible edit rather than
a widening arriving by inheritance. `MAX_CONTEXT_ATTACHMENTS` is 20 and `MAX_FIELD_CHARS` is 4000 —
generous, because an answer is usually appended to an already-long description — with the
truncation notice **outside** the fence, beside the omitted-comments notice and for the same reason.
All three bounds exist because this is attacker-controlled text going into a prompt.

**The open question is whether fetching the bytes is authorised**, and it is not mine to answer.
The Jira REST credential is **no longer discovery-only**, and that matters for how this question is
framed. It writes `agent:*` labels through `updateLabels` — REST, atomic `update.labels` add/remove,
wired into the claim (`wiring.ts:545`), the retriage counter, `end.ts` and `retriage.ts` — because
MCP's `editJiraIssue` has set semantics and cannot add one label without rewriting all of them. So
the rule is not a wall, it is an amendment process: `updateLabels`, the changelog
read, and adding `summary,description,environment,attachment` to `fetchActivity`'s GET were each
authorised individually. Attachment _content_ is a further widening and a new untrusted-bytes path.
It is also the thing that would close the SSX-3822 class of failure, where a ticket names an asset
the solver cannot fetch and the solver reconstructs a lookalike from the description's adjective
(§9). Not to be widened without being asked.

### 5. The wiring that has no test, now with three callers waiting on it

Measured, not assumed: putting the wrong predicate back at `runWriteRungs`'s call site leaves the
whole suite green, because nothing constructs its dependencies. **`runWatch`, `runReviewSweep` and
the two halves it builds are in the same position**, and the gap now covers a refusal rather than
only a predicate: the `SOLVE_ENABLED` guard that stops `--watch` reporting an empty watched set as
_nothing is under review_ has no test that fails when it is unplugged. Everything decidable was
pushed into pure functions that do — `describeReviewSweep`, `endedState`, `completionLabelFor`, the
parser, `createReviewCycleDeps` — which narrows the untested part to the wiring and does not close
it.

**The daemon's own wiring took the same treatment rather than joining the gap**, 2026-09-06: every
decision E adds lives in `createReviewLoop`, which is a module and not `index.ts`, so all six of
them have tests that fail when unplugged. What is still untested is `runReviewSweep`'s new `signal`
parameter — nothing constructs its dependencies, which is this bullet, one level down.

Two more callers sit on the same hole. `watch-once.ts` ends in a top-level `await`, so the loop
that chooses `runRetriage` over `endWatch` has no test; everything either side of it is covered —
`describeRetriage` in `watch-args.test.ts`, the engine in `retriage.test.ts` — and the wiring
between them is not. And `runSolveClaims`'s own body — that the ledger is read before the claim
rather than after the outcome, that a thrown ticket does not abandon the queue, that the exit code
is restored — is covered by argument and by the ledger's unit tests, not by a test of the call
site. D4e measured this hole and called it _"the clearest argument yet for a test harness before
E"_. E is here and it did not grow one.

### 6. The second gate has no consumer

The solve subprocess inherits the operator's `PreToolUse` hooks, and one denied a write pass its
`Write` tool. `runner.ts` reasons about `--allowedTools`/`--disallowedTools` and concludes the
solver has `Write`; a hook this harness never sees can veto that per call. **`sessionDenials` makes
the veto visible, 2026-09-06.** Probed: a denial arrives mid-stream as an ordinary `tool_result`
with `is_error: true`, told apart from a file that did not exist only by
`tool_result_meta[].non_execution_kind`, and the `result` event repeats the set in
`permission_denials` — while still reporting `subtype: "success"` and `is_error: false`, which is
the whole reason nothing here saw it. Every run now warns `session.denied` with the count and the
tools, and the label already names the pass and the ticket.

Three things it does not do, each for a measured reason. It does not attribute a denial to a hook:
hooks, deny rules and don't-ask mode share one tag, only free text names a hook, and some hooks emit
no prefix, so the attempt would undercount in the direction of reassurance. It does not fail the
run: this service's own D4c commenter was denied an Atlassian tool, routed around it, and posted the
right comment. And it cannot see the quieter half at all — a hook that **allows but degrades**,
which is how a `Grep` came back useless on SSX-3832, leaves no structural signal, because both
denial-bearing fields are gated on the call not executing.

**What is still owed is a consumer**, and `sessionDenials` at `triage/session.ts:357` currently has
none. A fix pass that abandons for `judgement` while the harness watched its `Write` be vetoed is
reporting `environment`, whatever it says, and wiring that means widening `PassRunner.run`.

### 7. A transient/deterministic split, and the half of the attempt count that did not ship

`refused` and `failed` still release, so a ticket whose diff the harness would not judge can be
spent on repeatedly. The **ledger shipped** — `AttemptLedger` and `MAX_SOLVE_ATTEMPTS_PER_TICKET`
bound it per ticket, in memory, which is the right trade because losing the poll cursor causes a
double claim and losing this causes one extra attempt. **The split did not.** A solve that fails
deterministically should stop being attempted, not be attempted more slowly, and nothing yet tells
the two apart. This is also the only answer to D4e's stacking problem, where a re-claimed ticket is
re-commented nightly.

### 8. Four findings from the SSX-3834 run, three of them still open

- **`poller.ts:340` logs `"dry run — no label was written"` immediately before writing labels.** True
  while `solve:once` was the only caller; false the moment `runSolveClaims` became the second, which
  is every daemon claim. This file's subject, in this repository's own poller, found by reading the
  log of the run that first made it false.
- **Branch slugs drop `ø` and `å` rather than transliterating.** "Beløp på" became `bel-p-p-`
  (`worktree.ts:150-158`). On a Norwegian board that is every branch the bot will ever cut.
- **The review tick re-reads every open bot pull request.** Four here; three (`#2660`, `#1413`,
  `#2661`) returned `threads: 0` and exist only because nobody has merged them. Per-tick work scales
  with _unmerged_ pull requests, not active ones — an argument for merging promptly, and a second
  input to the cost number.
- **A formatted approval costs one terminal round per pull request.** Copilot's approval is a
  non-empty body with review `state: "COMMENTED"`, never `"APPROVED"`, so the general discriminator
  is unusable for this reviewer. `delivery.ts:858` reads a non-empty comment list as actionable,
  reserves a round, and pays for a pass whose input is "looks good". It is bounded — the round
  changes nothing, so the no-change rule undrafts. The cheap fix is unavailable for the reason the
  `Suppressed comments` block was left unparsed: an approval and a summary-only review carrying real
  feedback (#1413 exactly) are indistinguishable on the wire without reading the prose, and reading
  the prose is what the paid pass is for.

### 9. The fail-first check cannot answer a question about CI

The probe is cut on the machine the harness runs on and inherits its environment. A test whose
vacuity is environment-dependent — one reading `ZoneId.systemDefault()`, say — gets opposite
verdicts on a UTC runner and a developer's laptop. **A probe that inherits the operator's
environment cannot answer a question about CI's.**

### 10. Still unobserved

- **The mixed-batch rule.** No round has yet read a human and a reviewer comment in the same batch.
  Both origins have been driven individually and the `some` → `every` mutation is caught, so this is
  a live-run gap rather than a coverage one.
- **The `MERGED → agent:done` arrow**, which needs a human to merge.
- **The `poll.order` head has never truncated in the wild.** The line itself is observed: the first
  daemon cycle with `TRIAGE_STATUS_PRIORITY` set, 2026-09-10, emitted it for a real seven-ticket
  queue with the three `Mottatt` ahead of the four older `On Hold` ones, and reported each status by
  name rather than falling back to its id — which also confirms `statusName` survives normalisation
  against the live API. What that run could not exercise is the cap: seven against a limit of ten.
  Both the truncation and the id fallback are covered by tests now, so this is a live-run gap rather
  than a coverage one, and a first run or a post-outage backlog is what would close it.
- **The compact brief has never been seen firing.** `pnpm hooks:brief` renders it on demand and its
  suite covers the extraction, but nobody has observed the runtime deliver a `SessionStart` payload
  after a compaction — so neither the field name it branches on nor the fact of registration is
  confirmed from a session's own vantage point (`ARCHITECTURE.md` §16). It accepts both `trigger`
  and `source` for that reason.

### 11. Loose ends recorded in no other file

Five things that exist in neither `ARCHITECTURE.md`, `README.md` nor the source, and were being kept
alive only by being carried forward in conversation.

- **A post-merge vacuous-test sweep.** Two shipped tests guard nothing: #1413's timezone test and
  #2661's run-date block. `checkFailFirst` is a one-shot at solve time and misses both, for two
  different reasons — #2661 is `guarded` and sound (7/7 red against the real bug; only the
  _plausible wrong fix_ separates it, which is prose, not mechanism), and #1413 is
  environment-dependent (§9). What that argues for is a slow sweep re-running the experiment against
  merged bot pull requests in a CI-like environment. It is **not** part of F: F's trigger is a
  reporter editing a ticket, its subject is ticket text before a solve, and its channel is Jira
  re-triage, whereas this is post-merge, about code, on GitHub. Folding it in would make
  `agent:watching` mean two unrelated things. What it shares with F is the _cadence_ — days rather
  than minutes, and money spent with nobody having asked. So it hangs off F's schedule as its own
  sweep, gated on the cost work in §2, since it buys an install and a test run per pull request
  revisited.
- **The triage poster has the commenter's read-tool defect, and has had it longer.** Its header says
  it is not given the vault, Confluence, `Grep`, `Glob` or `search`, and that it has "no filesystem".
  `POSTER_DENIED_TOOLS` is `DENIED_BUILTIN_TOOLS` plus two Atlassian mutators — **no `Read`, no
  `Grep`, no `Glob`, no `Task`**. Both sentences describe `POSTER_TOOLS`, which the 2026-09-04 probe
  established denies nothing. The fix is the one applied to the commenter, and it is _more_ urgent by
  exposure: the poster runs on every triage, the commenter only on a terminal outcome. **The analyst
  cannot take the same fix** — reading the vault is its job — so its own header should be checked
  against the same question rather than assumed clean.
- **`dev-lens.md` holds a calibration row scoring the SSX-3801 fix as failed.** That fix passed 4562
  tests; the build never compiled it, for the `git-commit-id` reason since fixed. The row is bad
  evidence feeding the fitness assessment and should be corrected, not deleted.
- **Stale Jira comments that no MCP tool can delete.** One stale triage comment on SSX-3822, plus the
  two Automation for Jira comments that caused the wrong fitness call in §9's story. `addCommentToJiraIssue`
  takes a `commentId` and updates in place, so _our own_ comment can be rewritten — but deletion is
  unavailable, and the automation comments are not ours. A board this service can be blocked by and
  cannot unblock is a fact about the tool surface that the daemon should be known to have.
- **`sectionReferences()` may be an orphan, and this is rehomed from an entry that shipped.** It
  counts `§N` tokens across `src/`, and the section resolver that landed in PR #21 resolves the same
  tokens rather than counting them. Leaving it costs a `docs:check` fact that moves whenever test
  fixtures do — it already jumped 106 → 141 on fixtures alone, which is a number in prose that
  churns for reasons unrelated to the thing it claims to measure. **Propose before deleting**: an
  unreferenced-looking function here has twice turned out to be load-bearing, so trace the guarantee
  to a caller rather than trusting the name (`PROVING.md`, "an unreferenced declaration is evidence
  about a name").

### 13. What the house rules claim that nothing checks

Found by a spot-check audit of the rules against the tree on 2026-09-08, and narrowed by the guard
work that followed. The audit's own story — what it confirmed, and the three ways its method failed
while it ran — is an
[incident](.claude/skills/dev-house-rules/INCIDENTS.md#the-audit-that-found-eight-things-and-got-three-of-them-wrong-on-the-way),
not a plan item. What is left below is only what is still missing.

- **The count class is checked, but only for nouns somebody listed.** `count-phrases.ts` now closes
  the class: every count-noun phrase in tracked markdown must be a declared `FACT` site or an
  explicitly listed historical figure, so the current-versus-war-story call is written down instead
  of made by silence. The cost is stated in the module and repeated here because it is the next
  gap — **a count about a noun that is not in `COUNTED_NOUNS` is invisible to it.** Scoping to nouns
  is what took the population from 539 shape-matches to something small enough that every entry
  carries a reason, and the alternative found nothing better; but the check cannot report the phrase
  it was never taught to see, so growing that list stays a human act. Adding a noun is one line.
- **`docs-check.ts`'s own logic is still mostly untested.** Two of its checks were extracted so they
  could be — `pinned-prose.ts` and `count-phrases.ts`, because importing `docs-check.ts` from a test
  runs `vitest list`, which spawns vitest inside vitest. What is left in the file itself is the part
  with no test: the `FACT` table's derivation of each count from the tree, the `expectSites` logic,
  and the link walker. The extraction is the pattern for closing the rest — take the pure decision
  out, leave the I/O behind — and nothing forces it, so it will happen the next time one of those
  three is edited or not at all.
- **`docs:check` is narrower than three documents claim.** Only `.md`-suffixed links, so a reference
  to a directory rather than a file is still invisible to it — which is why the "where the truth
  lives" row for `dev-house-rules` had to be pointed at `SKILL.md` to be checked at all. The
  repository's real cross-reference system — **109 section references** from `src/` alone, mostly
  into the two instruction skills — is no longer unresolved: `§N` tokens are now checked against the
  headings that define them, and **exactly 39 point at sections that have never existed** (below,
  "The citations that were never written down"). What is still unresolved is which _document_ a
  citation meant, since almost none of them says.
  `CLAUDE.md`'s own routing table was the third gap here and is now closed: its filenames are links,
  so deleting a phase file fails the check by name instead of keeping it green. The size of the
  system is now derived by `docs:check`; whether any of it resolves is still not.
- **An incident unreachable from a rule now fails `docs:check`; the reverse direction does not.**
  Closed by `rule-citations.ts`: every `###` entry in `INCIDENTS.md` must be cited from one of the
  six documents in `CITING_FILES`, or carry a `**No rule yet**` line that parses. 44 entries, 39
  cited, 5 declared. What is still missing is the direction this bullet used to claim was the one
  that mattered — **42 of the 71 rule paragraphs cite no incident**, and that number is printed in
  the summary and failed on by nobody. It is not a debt to pay down blind: 18 of the 42 are file
  openers, reading pointers and section labels rather than rules, so the honest fix is a citation
  convention for rule paragraphs, which does not exist yet.
- **`docs:check` bounds one property of the prose — how long it is — and verifies no count stated
  _inside_ it.** `length-budget.ts` measures four documents and holds their bands in TypeScript;
  every other fact the run holds is a property of the tree — tests, settings, files. A sentence
  counting its own
  document is still invisible to it, and `INCIDENTS.md`'s preamble carried two such claims for two
  commits: that every entry _ends_ with `**Found by**`, and that "the seven that already answer the
  question are quoted above" when five were. Both were caught by a reader, twice, in the paragraph
  arguing that this class of claim cannot be taken on trust. Not obviously worth a mechanism —
  "seven quotes appear above this line" is a check with one site and a bespoke parser — but the
  gap is real and the alternative is to stop writing such sentences, which is the cheaper fix and
  is not currently a rule.
- **Cost figures are facts with many homes.** `$0.94`, `$0.11`, `$3.99` and `$4.50` occupy 17
  file-homes between them, outside the `docs:check` exemption rule 3 grants. The figures themselves
  are history and stay unchecked; the total is derived, so the class spreading further goes red —
  this bullet said "three" of `$4.50` while it was already in four, which is the drift it describes,
  happening to it.
- **A citation to a document outside the tree cannot be checked, and does not look different.**
  `docs:check` can only resolve what it can open, so an out-of-tree quotation is exempt by nature
  while reading exactly like a verifiable one — which is how two of them were misattributed to
  `PLAN.md` for as long as they existed. The convention now is to name the source and say it is
  outside the tree ([`INCIDENTS.md`](.claude/skills/dev-house-rules/INCIDENTS.md) header); the
  convention is prose, and nothing enforces it. The mechanical version would be a marker the check
  recognises, so an unmarked unresolvable citation fails rather than passing silently.
- **One guard hole is left, and it is the one enumeration cannot close.** On a protected branch
  every non-git write still passes: `sed -i`, `>`, `>>`, `tee`, `cp`, `mv`, `rm`, and any
  interpreter handed a script. `Edit`/`Write` are refused unconditionally, so this is the Bash-shaped
  way around them. It needs a decision nobody has made yet — how many false positives a floor may
  cost — and shipping half of it would be worse than leaving it named. The rule-1 flag bypasses and
  rule 2 itself were closed on 2026-09-09; this was deliberately not.
- **Rule 2 has a guard here now, and the layer above it still cannot be surveyed.** The operator's
  outer tooling refuses mutating GitHub API calls — observed, when a probe was blocked that was only
  ever going to be fed to a local script as a string. Whether it also covers `gh pr merge` cannot be
  established without running `gh pr merge`, so it is unknown and will stay unknown. Separately,
  ruleset 22571207 requires **0 approvals and no status checks**, so nothing on the GitHub side would
  refuse the merge if the command ever ran.
- **This one is closed, and is kept because it was wrong in a specific way.** It said registration
  was the operator's and outside this tree, so every guard was built inert and the whole of the
  evidence was `pnpm test:hooks` and hand-fed payloads, never an observed refusal. Registration moved
  into the tree as PR #23 and a refusal **was** observed on 2026-09-09 (`ARCHITECTURE.md` §16). The
  narrower claim it was replaced with — "the agent still cannot read the settings file, so it can
  watch a guard refuse without ever confirming what is wired" — was wrong in turn, and that is the
  second correction this item has taken. The read is allowed; what stays true is only that reading a
  registration is not watching it work.

**A checklist item that cannot be satisfied by the check a reader would reach for.** _"Any merged
branch deleted, including the local ref"_ — the mechanical way to find one is `git branch --merged`,
which is **blind to every squash- and rebase-merged branch**. `chore/agent-guardrails` has an
identical patch-id and tree to `6a8cba7` and `--merged` cannot see it, so it needs `-D`. That is how
these accumulate, and it is one instance of a possible rule rather than a rule.

**What would make this the wrong idea.** Every item above is a check on documents, and this
repository's own evidence is that checks on documents catch less than driving a command does. The
guard work that was worth more than the whole `docs:check` list has now shipped, so what is left
here is genuinely the cheaper half — and the thing still worth more than any of it is the wiring,
which is not ours (`ARCHITECTURE.md` §16). If the next session has budget for exactly one, take the
class check with
its test: it is the only item whose absence has already produced two shipped contradictions.

### 14. The citations that were never written down

<!-- refs:off -->

**Every `§N` in this section is quoted, not cited**, which is why the whole section sits in a
`refs:off` region rather than just its table. The resolver reads this document; a section that names
ten tokens in order to say they resolve to nothing would otherwise report itself as forty-odd
defects. That is the write-up perturbing the count it reports — a failure this file has now paid for
twice, and the reason the exemption is a marked region rather than a file-level opt-out.

**The resolver is built. The 39 fixes are not, and they were always the expensive half.** `docs:check`
now parses the headings of the four section-numbered documents and resolves every `§N` in markdown
_and_ in `.ts` against them, so "roughly 39" is **exactly 39**, held by `KNOWN_DANGLING` and compared
with `!==` — fixing some fails the check as loudly as adding one, because a ceiling would let the
debt be paid down silently and then quietly regrow. The list below still cost a full-tree audit plus
a `git log --all` check, and it is kept because regenerating it is the expensive part. **Branch:**
`fix/section-resolver` shipped the check; the fixes need one of their own, off `main`.

**39 dangling `§N` citations** in shipped source. The first diagnosis — that a renumbering
stranded them — is wrong: `§3a`, `§5b`, `§7b` and `§6.1c` appear in **no revision of `PLAN.md` that
`git log --all` can reach**, in any form. They were never written down. `ARCHITECTURE.md:619` says
"See PLAN.md §5b", the one citation naming its target, and it resolves to nothing;
`ARCHITECTURE.md:1095` cites `§24` in a document whose sections stop at 16.

**The quieter half is worse.** Some references are in range and silently repointed: six files say
"§1 refuses on-disk state", but that rule moved to `ARCHITECTURE.md §5`. A dangling number fails
when checked; a repointed one reads correctly forever.

**The root cause is structural.** `PLAN.md` numbers its sections and rule 2 deletes entries when
they ship, so every `§N` there named a slot guaranteed to be reused. **Half of that is now fixed by
convention rather than by mechanism:** numbers here are retired instead of reused, stated at the top
of "What is not built", so a deleted entry leaves a hole rather than handing its number to the next
one. That closes the reuse case and not the deletion case, which is worse and is the one this entry
had not named.

**The deletion case, found while retiring §12 and §15 on `fix/unverified-claims`.** Five files cited
"`PLAN.md` §12". Deleting §12 does not dangle any of them, because `§12` is still a heading in
`ARCHITECTURE.md` — so `docs:check` stayed green while every one of those citations came to point at
"Local divergence from upstream" instead of the guardrail argument. The resolver's rule is _this
token is a heading in **some** document_, and that rule is blind by construction to a citation
becoming wrong by deletion elsewhere. They were repointed by hand, at `ARCHITECTURE.md` §16, and
nothing would have failed if they had not been. **A check that cannot see the failure mode its own
document describes is the sharpest version of item 3's argument**, which is why item 3 is now
partly instanced rather than only recommended.

Three fixes were named; the first is done, the third matters most and has its first real instance:

1. ~~A resolver in `docs:check`.~~ Shipped. It needed the predicted exemption for references that
   are _quoted_ rather than made — this very entry names ten dangling tokens in order to be useful —
   and that arrived as `refs:off` / `refs:on` markers rather than a file-level opt-out, so exempting
   a paragraph never quietly exempts the document around it. A guard that fires on its own
   documentation gets switched off.
2. Fix the 39. Most need a human: the intended target is often unrecoverable, and deleting a comment
   that cites nothing sometimes destroys the only record of a decision.
3. **Stop citing `PLAN.md` by number from code.** Cite `ARCHITECTURE.md`, whose sections are stable,
   or quote the reasoning where it is used. **First instance done:** the guardrail argument moved out
   of `PLAN.md` §12 into `ARCHITECTURE.md` §16 precisely because five files were citing a plan entry
   as though it were a permanent home. The general form of the rule is that an argument other
   documents cite does not belong in the document whose entries are deleted on purpose.

**What the resolver cannot catch, which is why item 2 is still a human's.** Almost no citation names
its target document — `§7b` in `src/watch/decide.ts` says nothing about where `§7b` would live — so
the strongest available rule is _this token is a heading in **some** document_. That catches all 39.
It cannot catch a reference that still resolves and now means something else, and the tree has those
too; they are listed below. The check shrinks the set that needs a human read. It does not claim the
set is empty.

**What would make this the wrong idea.** Item 2 is a large mechanical diff across `src/` with real
judgement in it, and a batch pass by an agent is how 39 confident references to nothing got here. If
the answer to a dangling `§7b` turns out to be "delete the citation", then 39 comments get shorter
and nothing gets more correct. Read three of them before fixing any.

#### The sites, so nobody pays for the audit twice

**Provenance, because it decides how far to trust each row.** The list came from a subagent sweep;
the totals and line numbers are its work and are **unverified in bulk**. Verified by hand: that
`ARCHITECTURE.md:619` and `:1095` say what they are quoted as saying, that three sampled `src/`
lines match verbatim, and — against every revision of `PLAN.md` that `git log --all` reaches — that
`§3a`, `§5b`, `§7b` and `§6.1c` have never existed there in any form. Re-check a row before editing
it.

Dangling, grouped by the token they cite. None of these tokens has ever been a heading anywhere:

| token   | sites                                                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `§7b`   | `watch-loop.ts:71`, `cli/watch-once.ts:25`, `watch/counter.ts:5`, `watch/decide.ts:232,314,329`, `watch/decide.test.ts:219`, `watch/memo.ts:13`, `watch/relevance.ts:35` |
| `§6.1c` | `solve/pr.ts:438,1706`, `solve/commenter.ts:10`, `solve/delivery.ts:302,317`, `cli/solve-outcome.ts:324,485`, `cli/solve-outcome.test.ts:598`                            |
| `§6.1`  | `ARCHITECTURE.md:426`, `cli/solve-outcome.ts:314`, `cli/solve-run.ts:569,1013`, `jira/jql.ts:208`                                                                        |
| `§3a`   | `ARCHITECTURE.md:880`, `solve/attempts.ts:38`, `solve/commenter.ts:29`, `solve/commenter.test.ts:63`                                                                     |
| `§6.3`  | `solve/delivery.ts:1417`, `watch/counter.ts:14`, `watch/retriage.ts:23`, `watch/retriage.test.ts:141`                                                                    |
| `§7c`   | `jira/jql.ts:266`, `watch/retriage.ts:32`, `triage/gate.test.ts:532`                                                                                                     |
| `§3c`   | `cli/solve-outcome.ts:522,533`, `jira/jql.ts:221`                                                                                                                        |
| `§6.2`  | `solve/delivery.ts:1045`                                                                                                                                                 |
| `§5b`   | `ARCHITECTURE.md:619` — **start here.** The only citation in the tree that names its target document, and the name is wrong                                              |
| `§24`   | `ARCHITECTURE.md:1095` — self-reference in a file whose sections stop at 16; intended target is almost certainly §15, "The solve pipeline"                               |

**In range and silently repointed — the harder half, because nothing will ever flag these:**

- "§1 refuses on-disk state" — `solve/attempts.ts:31`, `watch/relevance.ts:40`, `watch/memo.ts:21,26`,
  `solve/review-cycle.ts:24,26`. That rule is now `ARCHITECTURE.md §5`; `PLAN.md §1` is the model
  question.
- "§6's rule is _advance, then claim_" — `index.ts:44`, `review-loop.ts:97`, `review-loop.test.ts:150`.
  Now `ARCHITECTURE.md §2` (L143); `PLAN.md §6` is the second gate.

**Clean, and worth knowing so the resolver is not written to re-check them:** all 7 `invariant N`
references (`README.md:447`, `ARCHITECTURE.md:1511,1635,1726,1735,1750`, `solve/claim.ts:26`) cite
invariants 5, 11 and 13 and are correct; every `§14.N` sub-reference resolves; the ~57 `§11`
citations from `src/triage/*` into `INTAKE_INSTRUCTIONS.md` are all in range, as are the
`SOLVE_INSTRUCTIONS.md` ones.

**The legal vocabulary, which the resolver now parses rather than being told:** `ARCHITECTURE.md`
§1–16 plus its §14 invariants 1–17; `PLAN.md` §1–21 less the numbers it has retired;
`INTAKE_INSTRUCTIONS.md` §0–12 with `1b`/`6b`;
`SOLVE_INSTRUCTIONS.md` §0–8 with `0a`/`2a`/`2b`/`2c`. Ten cited tokens are in none of them.

<!-- refs:on -->

### 17. Two guardrail questions that outlived the entries they were written in

**Branch:** none yet. These came out of §12 and §15, which shipped and were deleted; the settled
half of both is now `ARCHITECTURE.md` §16 and this is the half that is still open. They are here
rather than there because §16 describes what the guardrails **are**, and a document describing a
built thing is the wrong place to keep a defect nobody has fixed.

**1. Nobody has ever seen `ask` honoured.** `branch-stack.sh` returns
`permissionDecision: "ask"` on stdout with exit 0, and it is registered on `Bash` — that much can be
read. What has never been observed is the runtime acting on it. It was watched _not_ prompting once,
on `git switch -c fix/write-verb-audit` from `main` with three unmerged branches, while the same
payload fed to the script by hand emitted the correct `ask` and exited 0. `deny` on the same
transport was watched being honoured the day before, so the transport works for at least one
decision.

**Why it is worth more than it looks.** If `ask` is decorative, then every guard written in the
fail-open "make the human decide" style is decorative, and that is the style this repository reaches
for whenever a refusal would be too blunt. It is one measurement standing behind a whole class of
future guards.

**How to settle it, and why it has not been.** The probe needs three throwaway branches _carrying
commits_ — `git branch --no-merged origin/main` ignores a branch with nothing on it, and
`unmergedBranches` excludes HEAD besides — then a `git switch -c` from `main` with `BRANCH_STACK_MAX`
at its default. Confirm the count the hook will actually see first,
`. .claude/hooks/lib.sh && countLines "$(unmergedBranches "$PWD" "$(stackBase "$PWD")")"`, rather
than inferring it from open pull requests; an earlier revision of the old probe got exactly that
wrong and read a correct silence as a dead hook. What has stopped it is that it is real churn —
three branches and three commits created only to be deleted — against a single bit of information.
That is a defensible trade for one session and not for five, so the count of times this has been
deferred matters more than the argument.

**What would make measuring it the wrong idea:** nothing, except the cost. There is no
lower-churn version — a hook that only prompts under a condition needs the condition.

**2. The push check greps the whole command text.** `branch-guard.sh` anchors its `gh pr merge`
check to command position, with a comment explaining that this is "the difference between guarding
the act and censoring the words". The push check three lines below has no such anchor: it matches
`git push` anywhere in the text and then a protected branch name anywhere in the text, so a commit
message that merely _discusses_ pushing to `main` is refused as though it were one. Measured twice
in one week, once on this repository's own commits.

**Why it is a defect and not a rough edge.** `BUILDING.md` has the rule: a false positive is how a
guard earns the contempt that gets it turned off, and this one fires precisely when somebody is
writing about the guard. The fix is the anchor that already exists eleven lines up, plus assertions
for both directions — a real push refused, a commit message naming it allowed.

**What would make it the wrong change:** anchoring narrows the guard, and rule 2 is the one rule
where narrowing is the expensive direction. `git push` inside `sh -c '...'` is the case to hold
onto; the substring floor is what covers it today and the fix must not remove that.

### 19. `§N` resolves against every document at once, so cross-document references are barely checked

**Branch:** none yet.

**What is wrong.** `docs-check.ts` builds one `defined` set by unioning the section ids of
`ARCHITECTURE.md`, `PLAN.md` and the two instruction skills, then asks whether each `§N` reference
appears in it. The document a reference belongs to is discarded. So `PLAN.md §12` — an entry that
shipped and was deleted — resolves happily against `ARCHITECTURE.md`'s §12, and a reader following
it lands somewhere unrelated. Three of this file's own dead numbers were passing that way.

**How it was found.** By accident, and only because the accident was the right shape: the entry
numbered 18 was deleted, two mentions of it were left in prose, `docs:check` correctly flagged both,
and wrapping the whole hole list in `refs:off` should then have dropped the dangling count by four.
It dropped by two. The gap between the predicted number and the measured one is the entire finding —
a check that had gone green a second earlier was hiding it.

**Measured 2026-09-09 by the corpus audit, and this entry's own prediction is refuted.** It said to
expect `KNOWN_DANGLING` to "rise sharply" under strict per-document resolution. It rises by eleven,
39 to 50. What is large is the ambiguity, not the error: the four documents define 77 numbered
headings that collapse to 43 distinct tokens once pooled, and **181 of the 243 resolving citations —
74.5% — would resolve in more than one document.** So the check is nearly right about the population
it reports while answering a far weaker question than it looks like it is asking, which is the house
speciality. Two figures make that concrete: renumbering `INTAKE_INSTRUCTIONS.md` wholesale turns
only 2 of the 243 red, and 15 citations resolve **only** by pooling — among them the `§12` and `§15`
in §17's own opening line, this file citing its retired numbers and being told they are fine.

**The shape of the fix.** References already carry the file they were found in — `referencesIn`
takes a path — so the work is to key `defined` by document and resolve `§N` against the document
that owns it, with an explicit rule for the cross-document form (`ARCHITECTURE.md §16` names its
target and should resolve there, a bare `§16` should resolve locally). The 15 pooling-only citations
are the whole migration; the eleven are the debt it exposes.

**What would make it the wrong idea.** Eleven is small enough that raising `KNOWN_DANGLING` to 50 is
tempting, and that is the failure the constant's own comment warns about. Fix the eleven in the same
week, or say in the code that the resolver is aspirational — do not widen the number and leave it.

<!-- refs:off -->

**The other direction, found 2026-09-10 while opening what became §25, since shipped.** Everything
above is about a _dead_ reference resolving against a live section elsewhere. The reverse is worse
and had not been noticed: numbering a new `PLAN.md` entry §24 — the next free number, chosen without
a thought — **repaired** `ARCHITECTURE.md:1104`'s dangling `§24`, and `docs:check` reported the count falling to
38 and asked for `KNOWN_DANGLING` to be lowered to match. Nothing about that citation had improved.
It is still a self-reference in a file whose sections stop at 16, still pointing at nothing, and
§14's table still names §15 as its intended target. Two things follow. **The count is sensitive to
edits in files that have nothing to do with it**, so a routine plan entry can turn a check green
about a defect it did not touch — and had the invitation been accepted, deleting the entry on ship
would have failed `docs:check` on a later, unrelated commit, with a message pointing at neither
cause. The entry was renumbered to §25 instead and §24 left unused, which is the smallest thing that
does not launder a broken citation. **A number skipped on purpose is not a hole**: the list above
holds sections that shipped and were deleted, and this one never existed. Every `§N` in this
paragraph is a number being discussed rather than a reference being made, which is why the region is
`refs:off` — the same reason §14's table is.

<!-- refs:on -->

---

### 22. A staged skill root is never swept, so a hard kill leaks one per kill

**Branch:** none yet. What is left of `fix/skill-root-collision`, which shipped.

**What is not built.** An age-based sweep of abandoned skill roots under `parentDirectory`.

**Why it is owed.** `prepareSkillRoot` now names each root uniquely (`mkdtemp`), which is what stops
two concurrent runs fighting over one. The old fixed name was self-cleaning as a side effect — the
next run for the same issue landed on it and cleared it — and unique names give that up. A hard kill
between staging and the caller's `finally` now leaks one directory per kill instead of overwriting
one per issue.

**Why it was not done in the same change.** Survivable by default: `parentDirectory` is under
`tmpdir()`. Only an operator who points it elsewhere gets unbounded growth. A sweep is
time-dependent behaviour needing its own tests, and folding it into a collision fix would have left
both half-proven.

**What would make it the wrong idea.** A sweep that deletes by age can delete a root belonging to a
long-running pass. Any threshold has to be well clear of the slowest pass, and "well clear" is a
number nobody has measured yet.

---

## Verification

Unit and integration, following existing patterns, plus the house rule: **a guard is not shipped
until a test fails when it is unplugged.** Guards worth naming, because each protects against a
recurring charge rather than a wrong answer:

- **cursor** — unplug the high-water mark and the same comment is resolved twice.
- **marker parsing** — three mutations, failing in three directions: an unparseable marker reading
  as zero; the reservation written after the pass; "our own comments" keyed on the author again.
- **the operator's comment is not ours** — a human comment from the same GitHub account the bot
  posts through must be treated as feedback and must never be the comment we edit. This is the one
  whose failure destroys somebody's words rather than costing money.
- **terminal** — a `MERGED` or `CLOSED` pull request must not produce another round.
- **label pairing** — moving `agent:done` without making `agent:reviewing` replace `agent:solving`
  must fail a test, and so must the reverse. Two mutations, because the half-changes fail in
  opposite directions and one test will only catch one.
- **sendback self-trigger** — the bot's own comment must not qualify as "the ticket changed".
  Invisible in review and obvious on the invoice.

## Out of scope

Auto-merge. Multi-repo. Cross-repo _changes_ — reads landed 2026-09-07 and the two are not the same
grant: a pass may read every checkout on the machine and may write to one worktree, which is now
watched rather than merely asserted. Reopening `agent:done` tickets. Bot-noise tickets
(CVE/GHSA/SNYK/dependency bumps) — currently discarded at intake, and the most agent-fixable class
there is, so worth revisiting once the pilot has a track record.

## Open, deliberately

`bugFastPath` (default OFF) is the existing hook for bug-specific behaviour and is in direct
tension with this feature: it short-circuits a `Feil` to a one-line note with no scorecard — and
therefore no dev lens and no fitness call. If it is ever switched on, these two need reconciling.
Flagged, not solved.
