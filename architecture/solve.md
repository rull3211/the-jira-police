# the-jira-police — architecture: solve

The solve pipeline: worktree, recon, fix, simplify, review, gate, verify, delivery and the review
round-trip — what it cost the first time it ran end to end, and the two toolchains it has to bridge.

Index: [`ARCHITECTURE.md`](../ARCHITECTURE.md)

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

**That first refusal would not happen today, and the record is kept because of it.** Rows 8 and 9
are advisory now, so "DoR row 9 unmet" no longer forces a verdict off `ready-ish` and the cheapest
guard in that ladder no longer fires. The two that would have caught SSX-3801 independently are
untouched — external partner consumption, and a repo absent from `SOLVE_REPOS` — so the ticket is
still refused, one rung later and for the reason that actually matters. Read the entry as a
measurement of the ladder's ordering, not as a live description of the first rung.

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

**A filter on a prefix is only as good as the write that stamps it, and for the threads that write
was missing.** The paragraph above described the rule from the day `replyToThread` landed
(`b4372de`) while `answerThreads` handed it the pass's body unmarked, so every reply came back on the next round looking like
a reviewer's and got answered again — PR #548 on `insurance-ssx-mono-repo`, in public. The prefix
is now applied inside `replyToThread` rather than at its caller, which is the difference between
an untagged reply being absent from today's call site and being unreachable from any. It is not
retroactive: replies posted before that keep reading as a reviewer's, because nothing can tell them
apart.

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

