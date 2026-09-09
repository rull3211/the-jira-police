---
name: claude-validation-work
description: Entrypoint for validating that this repository's Claude Code hooks are actually enforced. Registration landed in PR #23; deny is honoured, watched refusing on main on 2026-09-09 with exit 0 carrying the decision on stdout. Step 0 is two zero-risk probes an agent runs itself in one turn — this file previously said no agent could check anything here, which was wrong: the settings file is writable by nobody but readable with the file-reading tool. branch-stack.sh is confirmed wired on Bash, so the one open question is narrowed to whether an ask decision is honoured at all. Carries the probe protocol, the precondition that defeated its first run, and what each result did and did not settle. Use when asked whether the guards fire, or before trusting any statement that a guard is installed.
---

# Validating the guardrails

**Point a session here by name when you need to know whether the guards fire.**

**This file used to open by saying the work could not be finished inside one session** — that hook
configuration is read at session start, so a change and its proof are always on opposite sides of a
restart. That is wrong, and it was refuted while running the probe below. On 2026-09-09 the same
`git restore --staged` was **allowed** on a stale `main` and **refused** on that same `main` minutes
later in one session, the only change being a fast-forward that brought `.claude/settings.json` into
the working tree. Registration appearing or disappearing takes effect immediately, and no restart is
needed to see it.

Say what that does not cover, because this file is where the habit is owed: nobody has tested
whether an _edited_ hook definition is re-read within a session. The agent cannot write that file,
so the case stays open.

**Read [`ARCHITECTURE.md` §16](../../../ARCHITECTURE.md) first.** It holds the reasoning: what each
guard is, what the suite proves, where the residual risk sits, and the four things nobody has
measured. This file is the runbook; §16 is the argument. If they disagree, §16 is the source and
this file is stale. The two open questions live in `PLAN.md` §17.

That entry used to be `PLAN.md` §12, which shipped and was deleted. If you find a document still
sending you to `PLAN.md` §12 or §15, it is stale and the number now resolves against the wrong
document — repoint it.

## Where the work is

Registration landed in **PR #23** and is on `main`. `.claude/settings.json` wires `branch-guard.sh`
on `Bash|Edit|Write|NotebookEdit`, `branch-stack.sh` on `Bash`, `commit-brief.sh` on `Bash`, and
`session-brief.sh` on `SessionStart` with **no matcher** so that no trigger value can be missed by a
typo.

**This list is an enumeration and nothing checks it.** The `PreToolUse` count further down is
checked against the settings file; this sentence names four scripts across two events and pairs a
digit with neither, so it can fall behind the wiring exactly the way it did when `commit-brief.sh`
was registered and only `ARCHITECTURE.md` noticed. Read it as the older of the two claims and
believe the checked one if they disagree.

## First, the thing that will waste your time if you do not read it

**You cannot _write_ `.claude/settings.json`, and you cannot reach it _through the shell_. You can
read it with the file-reading tool.** Those are three different rules and this file asserted the
wrong union of them until 2026-09-09. Two of the three are refused by the harness:

```
Write to protected path blocked by storecode (.claude/settings.json)
Blocked: accessing Claude Code hook configuration via shell
  (storecode.sensitive_paths:claude-settings-access)
```

Do not work around either. Do not re-attempt them in another spelling to see whether the block is
consistent — it is, and the attempt is the thing the rule prohibits. If you need it **changed**, write
the JSON in a message and let the operator apply it. The write ban is the whole design and it stands:
the agent a guard constrains does not get to wire it.

**The read is the correction, and it was worth three documents being wrong.** This file, `CLAUDE.md`
and the guardrail entry then in `PLAN.md` all said the file was refused in both directions, and
derived a rule from it —
_no agent can report whether the hooks are installed; any such answer is a refusal or a
fabrication._ That was never tested. The evidence behind it is the two blocks quoted above: a
**write**, and a **shell** read. Nobody tried the file-reading tool, which returns the file on the
first attempt. So the rule inverted: an agent that has read the wiring can say what is registered,
and the sentence telling it not to bother was the expensive part — it retires the cheapest check
available and instructs the next session to disbelieve a true result.

**What it still does not buy.** Reading the file tells you what is _wired_. It says nothing about
whether the runtime _honours_ what is wired — that is step 0 and step 4 below, and the two are
independent. A registration that parses and a guard that fires are different claims, and this file
has already been wrong by conflating a narrower thing with a wider one once.

**The shell ban has a false-positive shape worth knowing before it costs you a turn.** The rule
matches the path as a string in the command text, so a `git commit` whose _message_ discusses the
file is refused even though nothing touches it. That is the guard censoring the word rather than the
act — the failure `branch-guard.sh` anchors its own `gh pr merge` check to avoid. Do not re-spell the
command to slip past it. Say what happened, and either have the operator run it or get explicit
agreement to word the message differently; performing a different operation that the block caught by
accident is legitimate, and saying so out loud is what keeps it legitimate.
[→](../dev-house-rules/INCIDENTS.md#a-permission-granted-to-a-human-read-as-a-permission-granted-to-the-agent)

## The probe

**Step 0 is run by the agent, in one turn, every session it matters. Steps 1–4 need a human** —
they turn on session starts and on watching a prompt appear, neither of which an agent can observe
about itself.

### Step 0 — is `branch-guard.sh` actually firing, right now?

**Two commands the guard classifies as writes and that do nothing if they run.** That is the whole
trick, and it is why this is safe to make routine: if the hook is live you get its refusal, and if it
is not you get a no-op and a clean tree. Run them from a protected branch, which is the only place
the guard has an opinion.

```
git rm                       # no pathspec: prints usage, changes nothing
```

and a `Write` aimed at a directory that already exists — `src` — which no filesystem will let you
overwrite with a file. Expect `branch-guard.sh`'s refusal naming the branch, twice. Confirm with
`git status --porcelain` that the tree is unchanged either way.

**Between them they cover both matchers**, which is the point of running two: the `Bash` entry and
the `Edit|Write|NotebookEdit` entry are separate registrations and either can be absent alone. A
`deny` from both is strong evidence that `PreToolUse` is wired and that exit 0 carrying the decision
on stdout is honoured.

**Say what it does not cover, because that is this file's own habit.** It proves `deny`. It says
nothing about `ask` — see step 3, which is still open — and nothing about `gh pr merge`, which shares
`branch-guard.sh` with the cases above and is therefore covered by inference rather than by
observation. Do not run a real merge to close that gap.

### Steps 1–4 — the human's half

In this order. Nothing before step 1 is worth doing.

**Check this before anything else: does the branch you are testing carry the registration?**
`.claude/settings.json` is a tracked file, so on any branch whose history predates PR #23 it is
simply absent and **nothing is wired at all**. This is not a footnote — it is what defeated the
first run of this probe. The steps below sent the reader to `main` while registration was still an
open pull request, which made `main` the one branch where the probe could not pass. Steps 3 and 4
both came back silent, and that silence was nearly written up as the exit-code failure. If
`git merge-base --is-ancestor <registration-commit> HEAD` fails, stop; you are testing a branch with
no hooks on it.

| #   | do this                                                | expect                                                                 |
| --- | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| 1   | start a session and type nothing                       | the brief: contract pointer, branch, uncommitted count, unmerged count |
| 2   | `git switch main`                                      | nothing yet — this is setup for 3 and 4, not a check                   |
| 3   | `git switch -c test/wiring-probe`                      | a **prompt** — not a refusal — from `branch-stack.sh`                  |
| 4   | `git switch main`, then ask the agent to edit any file | a **hard refusal** naming `main`, from `branch-guard.sh`               |

**If step 1 is silent, stop.** The configuration is not being read at all and the rest proves
nothing. Check that the file exists and parses before looking at anything else.

**Step 3 must be run from `main`, and the ordering above is the whole point.** `unmergedBranches` in
`lib.sh` **excludes the branch you are standing on**, deliberately and for a good reason documented
there — a threshold that counts your own branch can never be satisfied. The consequence for this
probe is easy to miss: run step 3 from a feature branch and that branch is not in its own count, so
three open pull requests measure as two, the threshold of 3 is not met, and **the prompt is correctly
silent**. From `main` the same three measure as three and it fires.

**So a silent step 3 is only evidence if you ran it from `main`.** Confirm the number the hook will
see before believing anything about the result:

```
. .claude/hooks/lib.sh && countLines "$(unmergedBranches "$PWD" "$(stackBase "$PWD")")"
```

Three or more and step 3 should fire. Fewer, and the stack is genuinely shallow: create throwaway
branches until that command prints 3, or skip to step 4.

**Run that command; do not read a number out of this file.** A previous revision of this paragraph
said the count was 1 and that step 3 was therefore dead, on the strength of #21 and #23 having
merged. #21 had not merged. With #21, #24 and #25 open the count from `main` is 3 or more and step 3
is live — which is the seventh time in this work that a number was written down instead of measured,
and the first where the stale number would have caused a working guard to be recorded as untestable
rather than the reverse.

**Step 3 has now produced a result, and the result is that it did not fire.** On 2026-09-09, from
`main`, with the count measured at 3 by the command above, `git switch -c fix/write-verb-audit`
produced no prompt. Run by hand with the identical payload, `branch-stack.sh` emits the correct
`ask` — naming all three branches — and exits 0. So the script is not the problem.

**Two causes were named, and one is now eliminated — by reading the settings file, which this file
had said no agent could do.** What was already excluded: `session-brief.sh` printed at session start
with the live branch and counts, so the file is read and parses; and `branch-guard.sh`'s `deny` on
`Bash` was watched refusing in step 4, so `Bash` `PreToolUse` hooks do run and a decision on stdout
with exit 0 is honoured **for `deny`**. The two candidates left were that `branch-stack.sh` is not
wired on `Bash` at all, or that `ask` is not honoured the way `deny` is.

**It is wired,** by 3 PreToolUse registrations: `branch-guard.sh` on
`Bash|Edit|Write|NotebookEdit`, `branch-stack.sh` on `Bash`, and `commit-brief.sh` on `Bash`. Read on
2026-09-09, on `main`. **This sentence is now checked** — `docs:check` counts the `PreToolUse` array
in `.claude/settings.json` and fails when the number here disagrees, which is the least this
paragraph could have, given what the rest of it is about.

**And "Where the work is" said so already, eighty lines above this paragraph.** That is the part
worth keeping. The wiring was written down correctly at the top of this file — from the operator, who
can read it — while this section went on calling the same fact unreachable and assigned it to the
human. Two statements about one thing in one document, disagreeing, with nothing to make them
disagree loudly. The agent's supposed blindness was doing the work: a claim about what _cannot_ be
known is not checked against the document making it, because there is nothing to check it against.
[→ cite, don't copy, and the map you did not check](../dev-house-rules/STARTING.md#architecturemd-is-the-map-and-this-section-is-only-how-to-read-one)

**Do not read that as settling the question, which is the trap this file has fallen into twice.**
One hypothesis surviving is not the same as one hypothesis confirmed. A third cause nobody listed is
exactly what happened last time a probe here was pre-registered with two branches — and the
conditions of the step-3 run are a live candidate: `unmergedBranches` excludes HEAD, the threshold is
`>= 3`, and the count was measured **before** the command rather than at the instant the hook saw it.

**So the open question is now single and directly testable**, which it was not before:

> Does a `PreToolUse` hook emitting `permissionDecision: "ask"` on stdout with exit 0 actually
> prompt, the way `deny` was shown to refuse?

The test is step 3 run deliberately rather than incidentally: create three throwaway branches
**carrying a commit each** — `git branch --no-merged` ignores branches sitting on the base, which is
why merely creating them is not enough — confirm with the `countLines` command above that the hook
will see 3, then `git switch -c test/wiring-probe` and watch for a prompt. If it is silent with the
count confirmed at the moment of the call, `ask` is decorative, and that is the largest finding
available here: every fail-open guard in this repository rests on it.

**That sentence used to open "if it is wired", and the conditional is spent** — it is wired, read
directly, eight paragraphs up. What the conditional was protecting is still worth stating plainly:
`branch-stack.sh` was deliberately written as `ask` rather than `deny` so that stacking stays
possible when it is right, and a guard that cannot prompt is not a soft guard but an absent one.

**This question is carried as an open item in `PLAN.md` §17**, with the churn that has deferred it
written down beside it, so that deferring it a sixth time is a visible choice rather than a silence.

**Note what this does not settle**, since this file is where the habit is owed: a stack of exactly 3
was tested, from `main`, on one machine, with one command shape. Nobody has tried `git worktree add`
or `git branch <name>`, which the same hook matches.

**This paragraph replaces one that got it wrong**, and the error is worth keeping because it is the
fourth instance of the rule this work drove into `PROVING.md`. The old text claimed the stack was deep
enough and listed `fix/section-resolver`, `fix/slept-assertion` "and this one" — counting HEAD, which
`lib.sh` drops. A branch count was quoted as evidence without stating which case it excludes, by the
same session that wrote the exclusion.

**Clean up:** `git switch <your branch> && git branch -d test/wiring-probe`. The lowercase `-d` is
deliberate — the probe branch carries no commits, and `-D` is refused by an outer guard anyway.

## Step 4 was the one to bet against, and it refused

**Result, 2026-09-09: exit 0 carrying the decision on stdout is honoured.** From `main`, with
registration merged, a `Write` and a `git restore --staged` were both refused in
`branch-guard.sh`'s own words. `deny()` keeps `exit 0`; `branch-stack.sh` was not touched.

The question this settled: every hook here does `printf` the decision JSON and `exit 0`, the
published reference documents **exit 2** as the blocking status and is unclear on whether a `deny`
on stdout with exit 0 is honoured, and the suite could not settle it because all 93 assertions piped
stdout through a `decision` filter and **not one checked an exit code**. That gap is now closed —
six assertions cover the exit codes and the branch list, and both were mutation-tested: switching
`deny()` to `exit 2` fails two of them, and **none of the original 93 noticed it**.

**The part worth carrying is how nearly the pre-registered plan went wrong.** It said that if step 4
let the edit through, `deny()` earns `exit 2`. Step 4 did let the edit through on the first run — and
the cause was the missing registration described above, not the exit code. Applying the pre-decided
fix then would have rewritten a working guard, passed every existing assertion, read like hardening
in review, and left `main` unprotected. A decision recorded in advance stops you rationalising the
result; it does not stop you misreading which case you are in.

## What is still owed after the probe

1. **Done.** `CLAUDE.md` was corrected ahead of the probe; `PLAN.md` §13 and
   [`dev-house-rules/SKILL.md`](../dev-house-rules/SKILL.md) were corrected in the probe-result
   commit. Each was amended rather than deleted, because each is load-bearing about what you still
   cannot check — which is not "what is wired", since that reads fine, but whether the runtime acts
   on it.
2. **Keep "behave as though they are unregistered."** That instruction survives registration. It now
   rests on a better reason than "you cannot check": a guard can be registered and still fail open,
   which is exactly what the exit-code question is about.
3. **The residual risk moved and did not disappear.** `.claude/hooks/*.sh` is **not** protected — the
   agent can edit every script the settings file points at, and `CLAUDE.md` expects it to
   (`pnpm test:hooks`, "which you run if you change one"). Neutering `branch-guard.sh` is a one-line
   diff. Review is what stops it; the harness block covers the wiring, not the wire.
4. **A rule is owed to `PROVING.md`.** See below — this is the only item that is not about hooks.
5. **The mutate list was a denylist naming 13 of git's write verbs, and is now an allowlist of
   reads.** **Done**, on `fix/write-verb-audit`. The sweep, the verbs it let through and the reason
   the shape rather than the list was the defect are in `branch-guard.sh`'s header comment, argued
   at [`ARCHITECTURE.md` §16](../../../ARCHITECTURE.md) and storied
   [in `INCIDENTS.md`](../dev-house-rules/INCIDENTS.md#the-denylist-that-named-thirteen-of-gits-write-verbs);
   they are not restated here, because a runbook that carries its own copy of a measurement is the
   thing that goes stale first. What the runbook owes is the consequence: an unlisted **read** is now
   a refusal a human fixes in a minute, and if step 0 or a real command ever refuses something
   ordinary, that is the expected direction and not a bug report.

## The rule this work bought, at seven instances

The work that registered these hooks made the same mistake seven times, and each time a single
command refuted it. All seven are in `INCIDENTS.md` on `main`, and so is the rule they paid for —
#27 merged on 2026-09-09:

- A probe measured the wrong case and its output was quoted as proof; CI produced the counter-example
  on its first run.
- A mutation silently restricted itself to line 1, changed nothing, and reported a clean pass.
- A report that "developers may add settings" was read as "the constraint is not real", twice in
  succession — the write ban and then the read ban, each refuted about a minute after being denied.
- **This file's own probe**, above: a branch count was quoted as evidence that step 3 would fire,
  without stating that `lib.sh` excludes HEAD from it. Three open pull requests measure as two from a
  feature branch, so the step could not have fired and its silence would have been read as a broken
  hook. Refuted by one command — `countLines "$(unmergedBranches ...)"` — printing `2`. The same
  claim had already been copied into PR #23's body before anyone ran it.

- **This file's own pre-decided outcome**, above: step 4's result was written up in advance as
  evidence about exit-code semantics, without stating the case it does not cover — that a silent
  hook has two causes, and "never ran" is one of them. The probe's first run hit exactly that case.
  Refuted by instrumenting the hook to log when it fired, which took one line.

- **CI's `Rules owed` step**, which reads `github.event.pull_request.body` from the event payload.
  Four local gates were quoted as "green" without stating that none of them reads a pull request
  body — which `ci.yml`'s own header comment says in as many words. Refuted by the first push.

- **This file's own step-3 paragraph**, above: "the count from `main` is 1, so step 3 is dead" was
  written from a list of merged pull requests rather than from the command sitting two paragraphs
  above it. #21 had not merged. Refuted by running that command, which printed `3`.

The pattern in the last four is worth more than any of them alone. The fourth failed to account for
an exclusion **documented at length in `lib.sh` by the same session that then quoted the count**. The
fifth was written by the session that had deliberately registered `session-brief.sh` with no matcher
_so that no trigger could be missed_ — the exact knowledge that would have surfaced the other cause
of a silent hook. The seventh ignored a command this file supplies, three lines away, for the sole
purpose of not guessing that number. Knowing the mechanism is not the same as checking the case, and
neither is owning the check.

**This is now a rule and no longer a candidate.** `INCIDENTS.md` held it awaiting a third instance;
it reached seven, was proposed in #24's body, and is written into
[`PROVING.md`](../dev-house-rules/PROVING.md#measure-do-not-assume-and-the-assumption-is-usually-about-your-own-code)
— _state which case your check does not cover, before you quote it as evidence._

Keep this list anyway. It is the evidence behind the rule, and this file is where the next instance
will be made: every claim below about what the guards do is a claim about the case that was run.
