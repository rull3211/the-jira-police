---
name: claude-validation-work
description: Entrypoint for validating that this repository's Claude Code hooks are actually enforced, after .claude/settings.json was registered on 2026-09-09. Carries the probe protocol, the two outcomes decided in advance, and the exit-code question the hook suite cannot answer. Use when resuming the chore/register-hooks work, when asked whether the guards fire, or before trusting any statement that a guard is installed.
---

# Validating the guardrails

**Point a fresh session here by name.** This exists because the work it describes cannot be finished
inside one session: hook configuration is read at session start, so the change and the proof of the
change are always on opposite sides of a restart.

**Read `PLAN.md` §12 first.** It is the entry, it names the branch, and it holds the reasoning. This
file is the runbook; §12 is the argument. If they disagree, §12 is the source and this file is stale.

## Where the work is

**Branch:** `chore/register-hooks`, off `origin/main` at `673f6c6`.

Registered on 2026-09-09 in `.claude/settings.json`: `branch-guard.sh` on
`Bash|Edit|Write|NotebookEdit`, `branch-stack.sh` on `Bash`, `session-brief.sh` on `SessionStart`
with **no matcher** so that no trigger value can be missed by a typo.

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

Run in a **fresh session**, by a **human**, in this order. Nothing before step 1 is worth doing.

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

**This paragraph replaces one that got it wrong**, and the error is worth keeping because it is the
fourth instance of the rule this work owes to `PROVING.md`. The old text claimed the stack was deep
enough and listed `fix/section-resolver`, `fix/slept-assertion` "and this one" — counting HEAD, which
`lib.sh` drops. A branch count was quoted as evidence without stating which case it excludes, by the
same session that wrote the exclusion.

**Clean up:** `git switch chore/register-hooks && git branch -D test/wiring-probe`.

## Step 4 is the one to bet against, and both outcomes are already decided

Every hook here does `printf` the decision JSON and `exit 0`. The published hook reference documents
**exit 2** as the blocking status and is unclear on whether a `deny` carried on stdout with exit 0 is
honoured. Our own suite cannot settle it: all 93 assertions in `test-hooks.sh` pipe stdout through a
`decision` filter and **not one checks an exit code**. So `pnpm test:hooks` proves the scripts emit
the right refusal and says nothing about whether the runtime acts on it.

Written down before the probe runs, so the result cannot be rationalised after the fact:

- **Step 4 refuses.** Exit 0 with the JSON is honoured. Add an exit-code assertion to
  `test-hooks.sh` anyway, so nobody has to rediscover this, and record the observed behaviour in
  §12.
- **Step 4 lets the edit through.** `deny()` in `branch-guard.sh` gets `exit 2`, and the suite gets
  the assertion that would have caught it. **Do not make the same change to `branch-stack.sh`** — its
  decision is `ask`, and exit 2 would convert a prompt into a hard refusal, which is the failure
  BUILDING.md warns about, where a guard acquires an enemy among the people who maintain it.

## What is still owed after the probe

1. **`CLAUDE.md` was corrected on 2026-09-09, ahead of the probe, and two sibling sites were not.**
   This item used to say the file was deliberately untouched and to correct it only in the commit
   recording the probe result. What overtook that: a `SessionStart` hook was observed firing, with
   this repository's live branch and counts in it, so **registration is now first-hand rather than
   assumed** — which was the whole of the reason to wait. The rewrite claims registration and
   explicitly denies enforcement, so it still asserts nothing unseen. **Two sites were left, and are
   owed to the probe commit:** `PLAN.md` §13 ("Registration is the operator's and outside this tree
   ... every guard in it is built inert" — wrong twice over) and
   [`dev-house-rules/SKILL.md`](../dev-house-rules/SKILL.md) under "The two that are not advisory"
   ("decided outside this tree and cannot be read from inside it" — _decided_ outside is now false,
   _cannot be read_ is still true). Fix both with the observed result, and prefer amending the
   sentence over deleting it: each one is load-bearing about what you still cannot check.
2. **Keep "behave as though they are unregistered."** That instruction survives registration. It now
   rests on a better reason than "you cannot check": a guard can be registered and still fail open,
   which is exactly what the exit-code question is about.
3. **The residual risk moved and did not disappear.** `.claude/hooks/*.sh` is **not** protected — the
   agent can edit every script the settings file points at, and `CLAUDE.md` expects it to
   (`pnpm test:hooks`, "which you run if you change one"). Neutering `branch-guard.sh` is a one-line
   diff. Review is what stops it; the harness block covers the wiring, not the wire.
4. **A rule is owed to `PROVING.md`.** See below — this is the only item that is not about hooks.

## The rule this work owes, at four instances

The work that registered these hooks made the same mistake four times, and each time a single
command refuted it. **The third and fourth are written up on this branch** — the first two are in
`INCIDENTS.md` on `fix/slept-assertion` and arrive with PR #22, so do not go looking for them here:

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

The fourth is the sharpest of the four, and the reason to keep it: the exclusion it failed to account
for is **documented at length in `lib.sh` by the same session that then quoted the count**. Knowing
the mechanism is not the same as checking the case, which is precisely what the rule is for.

`INCIDENTS.md` says the candidate rule — **state which case your check does not cover before quoting
it as evidence** — waits for a third instance. It now has two more. **Propose it to `PROVING.md`
rather than adding it silently**, per `FINISHING.md`: say what you want to change and why, before
changing it.
