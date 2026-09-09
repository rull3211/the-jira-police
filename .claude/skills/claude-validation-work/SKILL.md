---
name: claude-validation-work
description: Entrypoint for validating that this repository's Claude Code hooks are actually enforced. Registration landed in PR #23 and the probe was run on 2026-09-09 — a refusal was observed on main, and exit 0 carrying the decision on stdout is honoured. Carries the probe protocol, the precondition that defeated its first run, and what the result did and did not settle. Use when asked whether the guards fire, or before trusting any statement that a guard is installed.
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

**Read `PLAN.md` §12 first.** It is the entry, it names the branch, and it holds the reasoning. This
file is the runbook; §12 is the argument. If they disagree, §12 is the source and this file is stale.

## Where the work is

Registration landed in **PR #23** and is on `main`. `.claude/settings.json` wires `branch-guard.sh`
on `Bash|Edit|Write|NotebookEdit`, `branch-stack.sh` on `Bash`, and `session-brief.sh` on
`SessionStart` with **no matcher** so that no trigger value can be missed by a typo.

## First, the thing that will waste your time if you do not read it

**You cannot read or write `.claude/settings.json`. Neither could the agent that wrote this.** Both
are refused by the harness:

```
Write to protected path blocked by storecode (.claude/settings.json)
Blocked: accessing Claude Code hook configuration via shell
  (storecode.sensitive_paths:claude-settings-access)
```

Do not work around either. Do not re-attempt them in another spelling to see whether the block is
consistent — it is, and the attempt is the thing the rule prohibits. **If you need to know what is in
that file, ask the human to paste it.** If you need it changed, write the JSON in a message and let
them apply it.

This is deliberate and it is the whole design: the agent a guard constrains does not get to wire it.
A consequence worth stating flatly, because it is the one an eager session gets wrong — **no agent
can report whether the hooks are installed.** An answer to that question from an agent is either a
refusal or a fabrication.

## The probe

Run by a **human**, in this order. Nothing before step 1 is worth doing.

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

**`branch-stack.sh` has still never been watched firing**, which makes step 3 the only unproven
piece left. It is testable exactly while the stack is deep, so it is worth running _before_ the open
pull requests merge rather than after.

**This paragraph replaces one that got it wrong**, and the error is worth keeping because it is the
fourth instance of the rule this work owes to `PROVING.md`. The old text claimed the stack was deep
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
   cannot check: the agent can now watch a guard refuse without ever confirming what is wired.
2. **Keep "behave as though they are unregistered."** That instruction survives registration. It now
   rests on a better reason than "you cannot check": a guard can be registered and still fail open,
   which is exactly what the exit-code question is about.
3. **The residual risk moved and did not disappear.** `.claude/hooks/*.sh` is **not** protected — the
   agent can edit every script the settings file points at, and `CLAUDE.md` expects it to
   (`pnpm test:hooks`, "which you run if you change one"). Neutering `branch-guard.sh` is a one-line
   diff. Review is what stops it; the harness block covers the wiring, not the wire.
4. **A rule is owed to `PROVING.md`.** See below — this is the only item that is not about hooks.
5. **`git pull` is not in `branch-guard.sh`'s mutate list, and it should be.** Measured on
   `main` after registration merged: `git merge --ff-only origin/main` is refused there and
   `git pull --ff-only origin main` is not, though a bare `git pull` on a protected branch can
   create a merge commit on it. The list already carries `merge`; `pull` is the same act with a
   fetch in front. It is deliberately **not** fixed in the probe-result commit — it changes what the
   guard refuses, so it is its own reviewable unit, and `git pull` on a feature branch must stay
   allowed. Note the shape rather than just the hole: the list was assembled from commands that
   sound mutating, and `pull` sounds like a read.

## The rule this work owes, at seven instances

The work that registered these hooks made the same mistake seven times, and each time a single
command refuted it. All seven are in `INCIDENTS.md` **on this branch** — they reach `main` when this
pull request does, and not before:

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

`INCIDENTS.md` said the candidate rule — **state which case your check does not cover before quoting
it as evidence** — waits for a third instance. It has seven. **Propose it to `PROVING.md` rather
than adding it silently**, per `FINISHING.md`: say what you want to change and why, before changing
it.
