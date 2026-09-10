# the-jira-police — bug-squashing agents

> **Progress, 2026-09-08.** Phases A through F are built. The service discovers a ticket, triages
> it, gates the result, posts a verdict, claims a solvable one, solves it in an isolated worktree,
> opens a pull request, answers the reviewer, keeps the branch current with its base, labels the
> ticket for whatever happened, and watches the ones it sent back for an answer. **2471 tests in 69
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
> This file is now the _residue_: what is not built, what was learned at a cost worth not paying
> twice, and what no other file records. The built system is described in `ARCHITECTURE.md`; how to
> run it is in `README.md`. Anything that is finished has been deleted from here rather than struck
> through, because a plan that keeps its own history is a plan nobody can read the open items out of.

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
repoint every one of them — the failure §14 exists about. A missing number means that entry shipped
and was deleted. The settled half of the two guardrail entries now lives in `ARCHITECTURE.md` §16,
every file that cited them has been repointed there, and what is still open from them is §17.

<!-- refs:off -->

**The holes are §12, §15, §16, §18, §20 and §21, and this line names them rather than citing them.** A
catalogue of deleted sections dangles by construction — the targets are gone and can never be
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
worth a permanent number, because the session was compacted once while it was open.

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

---

### 22. `prepareSkillRoot` stages a path two concurrent runs can share, and one of them loses

**Branch:** `fix/skill-root-collision`, stacked on `refactor/dor-advisory-rows`.

**What is being attempted.** Make the staged skill root private to the run that made it, so two
concurrent `prepareSkillRoot` calls with the same `parentDirectory` and `issueKey` both get a tree
and neither refuses.

**Why now.** CI went red on pull request #33 in a run whose only difference from a green run on the
_same commit_ was the pull request body — `src/solve/orchestrator.test.ts > resolveReview > passes
the reviewer's comments in and withholds the brief`, expecting the review pass's options and getting
`undefined`. The harness records passes in a per-test array, so an empty one means the pass never
ran, and the only early return above it is `prepareSkillRoot` refusing.

The root is ``join(parentDirectory, `${issueKey}-skill`)`` — derived entirely from two inputs, with
nothing making it unique. `orchestrator.test.ts` and `delivery.test.ts` both drive `resolveReview`
with `issueKey: "SSX-3822"` and `parentDirectory: "/tmp/solve"`, so both stage the identical real
directory `/tmp/solve/SSX-3822-review-skill`, from separate vitest workers, with `rm -rf` then
`cp -r` then `chmod a-w`.

**Measured, not reasoned.** Two `prepareSkillRoot` calls raced against one root, 40 rounds: **40
prepared, 40 refused** — exactly one loser per pair, every time, `EEXIST: file already exists,
mkdir`. The suite does not reproduce it on this machine (12 runs of the file alone, 15 of the two
colliding files together, all green), which is the shape of the defect: a fast local filesystem
narrows the window, a contended CI runner widens it.

This is not only a test artifact. Nothing outside the tests stops two runs sharing a root; the
tests are just the first two callers that actually did.

**What would make it the wrong idea.** The deterministic name is load-bearing in one direction: it
is how a leftover from a hard-killed run gets cleared, because the next run for the same issue
reuses the name and removes it first. A unique name per run gives that up, and orphans then
accumulate rather than being overwritten one-per-issue. That is survivable because the default
`parentDirectory` is under `tmpdir()` (`wiring.ts`), but it is only survivable _by default_ — an
operator who configures it elsewhere gets unbounded growth. If the answer is an age-based sweep,
that is a second, testable piece of work and not this one; say so here rather than smuggling a
time-dependent behaviour into a collision fix.

The other wrong turn is fixing the two test fixtures instead. It would go green and leave the
production race exactly where it is, untested in both directions.

---

## What was learned, and is recorded nowhere else

### A gate is calibrated on the population it passes, not the one it fails

The complaint was that DoR rows 8 and 9 were failing too many tickets. Measured over the 29 reports
in `groomed/`, that is **refuted**: only 2 of 12 `dor:gaps` items would have flipped if both rows
were deleted, and both needed an interpretive call to count at all. Had the question stopped there,
the answer would have been "the rows are fine, the complaint is wrong" — and the complaint was
right.

**The signal was in the passes.** 11 of the 16 `dor:pass` items carried a written argument for why a
thin or absent row 9 should not block, and three independently invented the same unwritten exemption
to get there — _row 9 exists to stop unmeasured features, so a reproducible defect is exempt_. That
sentence was in no checklist. A gate two thirds of its passing population has to argue past is not
measuring what it believes it is; it has become a discretionary override with no field recording
that it was exercised.

**The general form, and it is not about DoR.** A gate's failures are the population everybody counts,
because a failure is an event with a name and a label. Its passes are unexamined by construction —
the ticket moved on, so nothing asks at what cost. But a miscalibrated gate does not usually
manifest as too many refusals; it manifests as **compliance theatre in the accepts**, which is
invisible to any count keyed on the refusal. So when asking whether a check is set too tight, read
what the passing cases had to say to get through, not just how many were stopped.

The tell is cheap to look for and was sitting in plain text: the same unwritten exemption appearing
in three independent runs. **Any rule the corpus keeps inventing is a rule the corpus needs and the
document does not have** — and until somebody writes it down, every instance of it is an
unauditable judgement call wearing the costume of a passing check.

### A rewrite can invent a number, and every gate here stays green

The cut of 2026-09-09 compressed `CLAUDE.md` and, in the process, changed "the brief's transport has
never been watched working" into "watched working by hand three times". Nobody decided to write
three. A compression pass needed a short clause where a long one had been, and produced a figure.
`git show HEAD:CLAUDE.md` is the only reason it was caught, and it was caught by a reviewer, not by
a run.

**Nothing mechanical could have caught it, and the reason generalises.** `count-phrases` watches 12
counted nouns; "times" is not one of them, and neither is any noun for an observation. A FACT only
sees the phrasing somebody thought to write down — so a check that reads as "the numbers in the prose
are correct" actually reads "the twelve nouns we listed are correct". Three documents ended up
carrying three different counts for the same fact, and the tree was green throughout.

The fix that holds is not another counted noun. It is **not stating the number**: `ARCHITECTURE.md`
§16 item 5 is now a dated list of sightings, the list _is_ the count, and every other site cites it
carrying no figure. A sentence with no number in it cannot drift, which is cheaper than a checker for
every noun anyone might reach for.

### A budget read off a landing that missed its target ratifies the miss

The same cut committed in advance to a mandatory-reading path under 4,907 words, landed at 4,913, and
then set the length-budget bands around 4,913. Every band was honestly derived — measurement plus 2%
— and the result was a check that enforced the outcome instead of the promise, six words adrift and
green forever. The order is the whole thing: **hit the target, then read the numbers off it.** Doing
it the other way is the same act as raising a ceiling to fit the corpus, which is the failure the
budget was built to stop, committed by the commit that built it.

### A check can depend on the runner's configuration, and be green everywhere except there

The length budget's ratchet resolves its baseline with `git merge-base HEAD origin/main`, and an
unresolvable baseline is a _problem_, so `docs:check` exits 1. `actions/checkout@v4` defaults to
`fetch-depth: 1`: detached HEAD, no `origin/main`. So the Docs step would have failed on **every**
pull request, and the first would have been the one adding the ratchet. Nothing local could see it —
seven gates green, twice, including a mutation probe on the ratchet itself, because every one of
them ran in a tree that had `origin/main` sitting right there.

Found by asking question one about a file the diff did not edit: `ci.yml`'s `- uses:
actions/checkout@v4` was three lines above the step being added, and unchanged. Measured before
shipping by running `docs:check` in a copy of the tree with no reachable baseline: `no baseline to
compare ceilings against`, `exit=1`. The fix is `fetch-depth: 0` with a comment saying what depends
on it.

**The rule this owes.** A check that reads anything outside the working tree — a remote ref, an
environment variable, a clock — has a second environment it must be proven in, and the local one is
never it. `PROVING.md` says to unplug a check and watch something go red; it does not say to run it
where CI will. The two are different probes and this branch only did the first, twice.

### A check can demand a property the corpus wants rather than one it has

`rule-citations` was written to assert that every rule cites an incident. Measured: 42 of 71 rule
paragraphs cite none, and of the 69 citations that do exist, **not one opens a bold paragraph** —
they sit in table rows, on indented continuations, and in `**The rule**` backlinks pointing the other
way. The check was looking for a convention nobody here writes to. Worse, roughly 18 of the 42 are
not rules at all but file openers and list lead-ins, including the sentence
`**Why every rule here exists is in INCIDENTS.md.**`, flagged for not citing an incident.

Such a check has only three exits, and two are worse than deleting it: fabricate 42 citations, or
pin the population as a grandfather list — which is `KNOWN_DANGLING` again, still 39, still "it goes
to zero". So it now **guards the half that is true** (every citation resolves; every entry has a rule
or a dated declaration) and **reports the other half as a number that fails nothing**. The test of
whether to guard a property is not whether you want it. It is whether the tree already has it.

### `git checkout <file>` to undo a mutation deletes the work the mutation was testing

**2026-09-09.** Mutation-proving two changes in one turn. The first backed the file up with `cp`
before mutating and restored from the backup. The second skipped that and reverted with
`git checkout src/cli/docs-check.ts` — which restores from `HEAD`, and the file held forty
uncommitted lines that were the entire point of the exercise. They went. Both mutations had already
produced their verdicts, so nothing was learned twice, but the change had to be retyped from
context that happened still to hold it.

**Why the safe habit did not generalise from the file next to it.** `cp` and `git checkout` look
like the same operation and are not: one restores what was there a second ago, the other restores
what was committed. They agree exactly when the file is clean, which is the case every mutation
tutorial shows and never the case in the middle of a change. The tell was available and unread —
`git checkout` is the command that prints nothing on success whether it restored one line or forty.

**The rule this suggests, and the reason it is a suggestion.** Mutation-test through a copy, never
through source control, unless the file is committed. It is one line in `PROVING.md` next to the
unplugging rule, and it is not written yet because a rule earns its place by generalising more than
one incident and this is one. The disposal condition: if the next unplugging in this repository is
done on a dirty file and survives, the habit is adequate and this entry can go.

### A count-noun check needs the noun to name one population, which is not obvious until it does not

**2026-09-09.** `registrations` was going into `COUNTED_NOUNS` to catch two stale wiring claims. The
disposal condition written into the plan entry beforehand was about volume — the noun earns its
place if few existing uses have to be blessed as history — and that condition passed cleanly: the
tree had zero historical uses and one live claim.

**It passed and the noun was still wrong, for a reason the condition could not see.** The two stale
sentences do not count the same thing. One says `PreToolUse` carries N registrations; the other
enumerates every hook across both events. A single FACT cannot be right about both, and the check
would have been _confidently_ wrong on whichever sentence it was not written for — worse than the
silence it replaced. The noun shipped as `PreToolUse registrations`, and the enumeration is now
labelled in place as uncheckable rather than left looking checked.

**What this says about the disposal conditions themselves.** They are written before the work, which
is the point of them, and that is also the limit: this one tested the cost of the noun and not
whether the noun referred to anything. A condition that only measures the price of being right
cannot notice that the question is ambiguous. Worth asking of the next one — before "is this worth
it", ask "does this name one thing".

### A fixture that cannot reach the code path is a green test, and it looks like every other one

**This is a proposed rule for `PROVING.md`, written here rather than there because the house rules
are amended by proposal and not unilaterally.** The incident is
`.claude/hooks/branch-guard.sh`'s floor pass and the assertion that was supposed to cover it, and
the argument for promoting it is that it survived the two mechanisms this repository already trusts.

`bash -lc "git push"` was allowed on `main` — rule 1 unguarded, by both halves of the guard at once,
for the exact shape the floor exists to catch. The assertion for that exact string was green for the
hundred minutes it existed — `4d5ef49` to `cbb5be0`, one afternoon of 2026-09-09, not the four days
`cbb5be0`'s own message claims. It passed because `test-hooks.sh`'s `bash_payload` helper built its
JSON by interpolation, so any fixture containing a double quote produced a payload the hook could
not parse, and an unreadable command is treated as a write. The guard denied — for the one reason
the assertion was not testing.

**What makes it worth a rule is which safeguards it walked through.** `PROVING.md`'s central rule —
a guard is not shipped until a test fails when it is unplugged — was followed in form. The floor was
removed, the assertion went red, and the comment recording that is still in the file. It went red
for the wrong reason: with the payload unparseable, removing the floor changed nothing, and what
actually failed was some other fixture in the same loop. Unplugging proves a test can fail; it does
not prove the test can fail _for its own reason_. And the sibling fixture one line away,
`sh -c 'git commit -m x'`, passed honestly — its verb is followed by a space either way — so the
loop as a whole looked exercised.

**The proposed rule, in two halves.** (1) A test fixture that is a serialised format — JSON, YAML, a
URL, a shell command line — is built with an encoder, never by interpolating a value into a template;
hand-built input is a test of your escaping before it is a test of anything else, and this is the
third appearance of that defect here after `lib.sh`'s `jsonEscape` and the branch-name quoting bug.
(2) When an unplugging goes red, check _which_ assertion went red and that the input reached the
line you removed. The second half is the expensive one and probably the one worth writing down.

**What would make it the wrong rule.** Half (2) is a per-mutation cost on a practice whose value is
that it is cheap, and a rule that makes unplugging laborious will stop it happening. It may be
better stated as a rule about fixtures alone, with the reasoning attached, than as a step.

**How it was found**, which is the part that does not generalise: sideways, by writing
`commit-brief.sh` — the first hook here whose behaviour on an unparseable payload differs from its
behaviour on a command it ignores. Nothing was looking for this.

### A citation can be exact and still be read wrongly, and that one shipped

The audit that produced this is an
[incident](.claude/skills/dev-house-rules/INCIDENTS.md#the-audit-that-found-eight-things-and-got-three-of-them-wrong-on-the-way);
its other three method failures went there with it. This one is here because it is the only one of
the four that reached `main`, and a correction to something shipped must outlive both the audit that
found it and the plan entry that happened to carry it.

The claim was that `test-hooks.sh:93` **asserted** the bare-push hole, by listing a push among the
commands that must stay silent. It does not. Twelve lines above it the fixture switches to
`feat/ordinary`, where allowing a push is correct and the assertion says so. The hole was never
asserted or denied — it was simply that no case exercised a protected branch.

Shipped to `main` in `e9483c1`, corrected the next day in `a94c005`, and found by **running the
guard rather than re-reading the file**.

**What it sharpens.** `STARTING.md` says _cite `file:line`, never a recollection_, and the failure
here is that rule's other direction: the citation was exact, and the reading of it was wrong. A
precise line number is evidence about **one line** and carries no information about the twelve above
it that set up the state it runs in — while looking, in a report, exactly like a verified claim. The
rule as written defends against vagueness; it says nothing about a precise reference read without
its context, which is the more convincing of the two failures.

One instance, so it stays here rather than becoming a rule. The second instance would earn an
amendment to that bullet in `STARTING.md`.

### The war stories are the asset, and length pressure comes for them first

From the 2026-09-02 survey that produced the phased house rules. Two numbers, and they point in
opposite directions:

- Vendor guidance is **`CLAUDE.md` under 200 lines and a skill body under 500**. `SKILL.md` was
  **884**, with the finishing checklist — the most-used thing in it — behind eight hundred lines of
  argument.
- Of **257 rule files sampled across the popular collections, four contain the word "because"**.

So the obvious response to the first number is to cut the reasoning, and the second number says the
reasoning is the only genuinely differentiated thing here. They move; they do not shrink. That is
why `INCIDENTS.md` exists and why it is append-only and off the reading path — and why
`pnpm docs:check` verifies the links into it, since a rule that loses its link to an incident has
quietly become an opinion.

The layout decision is worth keeping too: the phase files are **flat siblings** of `SKILL.md`, not a
`references/` subdirectory, because `intake-triage/` and `agent-solve/` are already flat and a
layout used by one skill in three is a layout somebody has to learn.

### The operational skills are the control group, and they are the strongest thing the corpus audit measured

**2026-09-09.** The four skills this service actually ships to its own subagents — `intake-triage`,
`agent-solve` and the two triage doubles — received **zero bytes** in the era that carried
`dev-house-rules/` from 16,613 words at the split to 28,286. Read on its own, that is a story about
neglect.

**It is the opposite, and one command settles it: `src/solve/` received zero commits over the same
window.** The instructions did not move because the code they describe did not move. Every
backticked symbol in `SOLVE_INSTRUCTIONS.md` but one resolves against `src/` — 45 of 46 as the audit
counted them, and the same single miss under a coarser extraction — and the miss is `AGENTS.md`, a
conditional instruction about the repository being fixed rather than a claim about this one.
`agent-solve` sits at 7,530 words and static, and static is what fitness looks like for prose whose
subject held still.

**Why it is an entry and not a footnote: it is the only control group this corpus has.** Both layers
are prose, both are read by an agent, both are checked by the same commands, and only one of them
grew. So the growth cannot be explained by "documentation accretes" or by "agents need more context
than we thought" — those would have moved both. What separates them is where the amendment comes
from: the operational skills are amended when something outside them changes, and the meta-layer is
amended from its own incidents. A loop fed only by itself has no source of stopping. That is the
argument for a length budget, and it is the only version of that argument resting on a measurement
rather than on taste.

### Two redundant guards, each making the other untestable, with the suite reporting green

**Two of the eleven mutations survived, and the reason is worth more than the fix.** The
self-trigger guard — the one Verification names as _"invisible in review and obvious on the
invoice"_ — could be deleted with the suite staying green, and so could the strictness of the
comparison beside it. Each was masking the other: `spokeAt` is the maximum over our _own_
comments, so under a strict `at > spokeAt` nothing of ours can match whether or not it was
skipped, and with the skip in place nothing can sit exactly on the boundary either. **Two
redundant guards, each making the other untestable, and the house rule reporting green.** The fix
was not to delete one but to make the pair asymmetric: a tie now counts as somebody else in both
loops, which makes the skip the only thing holding the self-trigger and improves the answer — a
reporter commenting in the same millisecond is now seen rather than missed. The general rule both
loops follow came out of it and is written at the call site: **our own activity is excluded by
kind, never by clock** — comments by the sentinel, field writes by the allowlist. Neither loop
needs the timestamp for that job, so neither should give a tie away.

This is the closest thing yet to a counter-example to the house rule as usually stated. _A guard
is not shipped until a test fails when it is unplugged_ assumes guards are unplugged one at a
time; two guards covering the same case pass that test individually and defend nothing that the
other does not. It cost nothing to find here because the mutations were run. It would have cost a
recurring charge to find in production.

### A fixture that models another module's output is a test that cannot see that module change

Every fixture in `src/watch/` builds its own comments, so the poster's idempotency was a fact about
a different module that this module's tests quietly assumed away. After `client.test.ts`'s
hand-copied label list and `solve-args.test.ts`'s hand-copied rung list, that is the third instance
and now a rule.

### SSX-3830, the first live watch run — and the calibration question was masked by the population it was asked about

Driven by hand in three steps, each one `pnpm watch:once SSX-3830` against the real board, and the
ordering was the point: the ticket was read **before** anything was done to it, then after a
comment, then after a description edit.

| state of the ticket     | comments | changes | decision                                           |
| ----------------------- | -------- | ------- | -------------------------------------------------- |
| untouched since triage  | 1        | 3       | `quiet`                                            |
| a human commented       | 2        | 3       | `RETRIAGE` — a comment from somebody else at 02:59 |
| description also edited | 2        | 4       | `RETRIAGE` — **the comment again**                 |

**The first row is the one that had never been proved.** One comment, ours, sitting on the ticket,
and the watcher declined to spend. That is the self-trigger guard — the mutation this file calls
_invisible in review and obvious on the invoice_ — firing against a comment the poster really wrote
and Jira really round-tripped, rather than against the hand-built `em` fixture that found the
sentinel bug. The two halves of that seam are now closed from both ends.

**The third row is a defect in the command, not in the decision.** `decideWatch` reads comments
before the changelog and returns on the first trigger, so the field that moved is never named on
any ticket somebody also commented on — which is precisely the ticket a reporter answering a
sendback produces. The one question `watch:once` exists to answer is therefore invisible on the
whole population it was pointed at, and it looked like a pass. The debug line now dumps every
distinct field name in the changelog, unfiltered and regardless of age, because **a list filtered
by `BLOCKER_CLEARING_FIELDS` can only ever confirm the guess it was filtered by.**

With that, SSX-3830 answers it: `description`, `labels`, `resolution`, `status`. So `description`
is spelled exactly that on this board and the allowlist is right — a guess, now an observation.

**`labels` is the finding, and it is load-bearing in a way only the live names revealed.** This
service writes labels constantly — `triaged`, `dor:*`, the whole `agent:*` machine, and F's own
unsubscribe. Every one is a changelog entry on a watched ticket, and the comment-kind exclusion
**cannot see them**, because they are not comments. What stops them re-triggering the watch is only
that `labels` is not allowlisted. So the allowlist is doing two jobs at once: relevance filter, and
the changelog's entire self-trigger defence. The general rule was already written down — _our own
activity is excluded by kind, never by clock_ — and this is its concrete instance, which turns it
into a constraint on anyone widening the set later: **a field this service writes must never be
allowlisted**, which rules out `labels` permanently rather than by luck.

### The whole chain, unattended, on SSX-3834 — and the ticket was written to fail first

The first ticket to travel the entire system: created, triaged, **sent back**, answered, re-triaged,
`agent:solvable`, claimed, solved, published, reviewed twice, undrafted, `agent:review-done`. A
person typed two things — the reply answering the send-back, and `agent:start`. Claim to draft pull
request was 5m36s; the whole run cost two review rounds on top of the solve.

It was built as a controlled experiment, the same way SSX-3833 was. The defect
(`formatIntegerWithThousandSeparatorAndKr(0) → " kr"`) was found and verified by hand first, so the
right answer was known before anything ran, and the ticket was written **deliberately short of DoR**
so the send-back path had something real to carry.

**Triage's three blockers were not the three that were designed in, and the difference is the
finding.** The ticket was written expecting failures on acceptance criteria, evidence, and value. It
asked instead for acceptance criteria, **the scope of the fix**, and value — blocker 2 being _may the
`if (!value)` guard change, given it flips other call sites, or must the fix stay in the wrapper?_
That is the actual trap in the defect, found from the ticket text alone with no source access, and
it was found by hand only because someone went looking for it. **The send-back produced a better
question than the person who wrote the ticket had.**

**And it paid off three steps downstream.** Copilot's round-1 review claimed the `NaN` regression was
_"a likely user-visible regression"_, which is false — no caller can reach it. The round did not
repeat that claim and did not need to; it argued from the scope boundary the answer to blocker 2 had
established: _"Only the two zero rows in the ticket's acceptance table change behaviour now, which is
what the ticket scoped."_ A written scope let a true claim with an inflated conclusion be acted on
for the right reason. That is the clearest evidence so far that the watch loop produces better
tickets rather than merely slower ones.

**The AC was still wrong, and in this project's own defect class.** `if (!value)` was a catch-all: it
absorbed `null`, `undefined`, `''`, `0` **and `NaN`**. The acceptance table enumerated the first
three and forgot the fourth, so the solver — implementing the list exactly and faithfully — made
`NaN` render as the string `"NaN"`. **An enumerated acceptance criterion that replaces a catch-all
guard is only as complete as the enumeration**, and this is the same prose-versus-behaviour
divergence the project exists to catch, arriving in a third position: not a comment drifting from
code, but a _specification_ drifting from the code it supersedes. Recorded against the ticket's
author, not the solver.

Copilot caught it inside four minutes, from the diff alone, reasoning about the deleted code —
_"previously it returned an empty string via the truthiness guard"_. **This is the first known-answer
probe run against the reviewer**: the defect was found, its reachability established, and the catch
predicted as difficult, all before the review landed. Every prior assessment of Copilot was
after-the-fact reading of whatever it happened to say.

**The regression test is not decorative, and that is the first time.** #1413 and #2661 both shipped
tests whose names described something they did not check, which was called a pattern with a stated
cause. The third sample breaks it:

```js
it("should return empty string for NaN without swallowing non-numeric strings", () => {
  expect(formatIntegerWithThousandSeparator(NaN)).toBe("");
  expect(formatIntegerWithThousandSeparator("abc")).toBe("abc");
});
```

Both halves of the name are asserted. Round 2 then verified, unprompted and in public, that the
suite _"fails against the naive 'just delete the falsy guard' fix (which would render `\"null\"`)"_ —
the house rule applied by the solver to its own test, which is exactly what `SOLVE_INSTRUCTIONS.md`
§2 asks for and had never been observed doing. It could do it because the acceptance criteria named
the plausible wrong fix in writing. **Naming the wrong fix in the ticket is cheaper than any
mechanism that could detect it.**

### The daemon's review loop, verified live at zero cost

`SOLVE_ENABLED=false … --for 6s` logged `review.loop.disabled` and stopped with
`reviewCycles: "off"`. Then `SOLVE_ENABLED=true MAX_REVIEW_ROUNDS_PER_TICK=0 … --for 60s` logged
`review.loop.start {intervalMs: 120000, maxRoundsPerTick: 0, worstCasePerTickUsd: 0}`, ran the
review JQL, and returned
`review.cycle {watched: 3, acted: [], settled: 2, ended: [], unlooked: 0, deferred: 1}` in 6.2
seconds. Both runs used a throwaway `STATE_PATH` and `--skill mock-triage`, so the real cursor was
untouched and nothing was posted. **`deferred: 1` is the interesting number:** with the per-tick
bound at zero, it means there is real actionable review work on the board that a daemon with the
bound at its default would have paid for on its first tick.

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
