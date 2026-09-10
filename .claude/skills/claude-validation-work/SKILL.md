---
name: claude-validation-work
description: Runbook for checking whether this repository's Claude Code hooks are actually enforced. Step 0 is two zero-risk probes an agent runs on itself in one turn; steps 1-4 need a human. Use before trusting any claim that a guard fires. The argument is ARCHITECTURE.md §16.
---

# Validating the guardrails

**Point a session here by name when you need to know whether the guards fire.**

**Registration takes effect immediately — no session restart is needed to see it**, watched on
2026-09-09. Whether an _edited_ hook definition is re-read within a session is untested, because the
agent cannot write that file. Both are [`ARCHITECTURE.md` §16](../../../ARCHITECTURE.md), item 3.

**Read [`ARCHITECTURE.md` §16](../../../ARCHITECTURE.md) first.** It holds the reasoning: what each
guard is, what the suite proves, where the residual risk sits, and the numbered list of what the
suite does _not_ prove. This file is the runbook; §16 is the argument. If they disagree, §16 is the
source and this file is stale. The open questions live in `PLAN.md` §17.

## Where the work is

Registration landed in **PR #23** and is on `main`. `.claude/settings.json` wires `branch-guard.sh`
on `Bash|Edit|Write|NotebookEdit`, `branch-stack.sh` on `Bash`, `commit-brief.sh` on `Bash`, and
`session-brief.sh` on `SessionStart` with **no matcher** so that no trigger value can be missed by a
typo.

**Nothing checks that list.** The counted claim is the checked `PreToolUse registrations` sentence
further down, which `docs:check` verifies against the settings file. Believe that one if they
disagree.

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

**Reading the file tells you what is _wired_, and nothing more.** Whether the runtime _honours_ what
is wired is step 0 and step 4 below, and the two are independent claims. Three documents here once
said the read was refused too and derived a rule from it — _no agent can report whether the hooks
are installed_ — which retired the cheapest check available and told the next session to disbelieve
a true result. Nobody had tried the file-reading tool. The route table is in §16; the story is
[in `INCIDENTS.md`](../dev-house-rules/INCIDENTS.md#a-permission-granted-to-a-human-read-as-a-permission-granted-to-the-agent).

**The shell ban matches the path as a string in the command text**, so a `git commit` whose
_message_ names the file is refused even though nothing touches it. Do not re-spell the command to
slip past it. Say what happened, and either have the operator run it or agree on different wording.

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

**Say what it does not cover, because that is this file's own habit.** It proves `deny` — which,
like `additionalContext`, has been watched honoured here. `ARCHITECTURE.md` §16 item 5 keeps the
dated log of those sightings; a new one is appended there, and no figure is restated here. It
says nothing about `ask` — see step 3, which is still open — and nothing about `gh pr merge`, which
shares `branch-guard.sh` with the cases above and is therefore covered by inference rather than by
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

**Run that command; do not read a number out of this file.** A previous revision said the count was
1 and that step 3 was therefore dead, on the strength of a list of merged pull requests — one of
which had not merged.

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

**And "Where the work is" said so already, eighty lines up**, while this section went on calling the
same fact unreachable — two wiring claims in one document, disagreeing, with nothing to make them
disagree loudly, because a claim about what _cannot_ be known is not checked against the document
making it. That is why the count is checked now.

**One hypothesis surviving is not one hypothesis confirmed.** The count was measured _before_ the
command rather than at the instant the hook saw it, so a third cause nobody has listed is still
live.

**So the open question is now single and directly testable**, which it was not before:

> Does a `PreToolUse` hook emitting `permissionDecision: "ask"` on stdout with exit 0 actually
> prompt, the way `deny` was shown to refuse?

The test is step 3 run deliberately rather than incidentally: create three throwaway branches
**carrying a commit each** — `git branch --no-merged` ignores branches sitting on the base, which is
why merely creating them is not enough — confirm with the `countLines` command above that the hook
will see 3, then `git switch -c test/wiring-probe` and watch for a prompt. If it is silent with the
count confirmed at the moment of the call, `ask` is decorative, and that is the largest finding
available here: every fail-open guard in this repository rests on it.

`branch-stack.sh` was deliberately written as `ask` rather than `deny` so that stacking stays
possible when it is right — which means a guard that cannot prompt is not a soft guard but an absent
one. `PLAN.md` §17 carries this as an open item.

**Note what this does not settle**, since this file is where the habit is owed: a stack of exactly 3
was tested, from `main`, on one machine, with one command shape. Nobody has tried `git worktree add`
or `git branch <name>`, which the same hook matches.

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
eight assertions cover the exit codes and the branch list, and both were mutation-tested: switching
`deny()` to `exit 2` fails two of them, and **none of the original 93 noticed it**.

**The part worth carrying is how nearly the pre-registered plan went wrong.** It said that if step 4
let the edit through, `deny()` earns `exit 2` — and step 4 did let it through on the first run,
because the registration was absent from that branch, not because of the exit code. A decision
recorded in advance stops you rationalising the result; it does not stop you misreading which case
you are in.

## What is still owed after the probe

1. **Keep "behave as though they are unregistered."** That instruction survives registration, and
   now rests on a better reason than "you cannot check": a guard can be registered and still fail
   open, which is exactly what the `ask` question above is about.
2. **The residual risk moved and did not disappear.** `.claude/hooks/*.sh` is **not** protected —
   the agent can edit every script the settings file points at, and `CLAUDE.md` expects it to
   (`pnpm test:hooks`, "which you run if you change one"). Neutering `branch-guard.sh` is a
   one-line diff, and review is what stops it. Argued at
   [`ARCHITECTURE.md` §16](../../../ARCHITECTURE.md).
3. **The mutate list is an allowlist of reads, not a denylist of write verbs**
   ([the story](../dev-house-rules/INCIDENTS.md#the-denylist-that-named-thirteen-of-gits-write-verbs)).
   What the runbook owes is the consequence: an unlisted **read** is a refusal a human fixes in a
   minute, so if step 0 or an ordinary command refuses, that is the expected direction and not a
   bug report.

## The rule this work bought, at seven instances

The work that registered these hooks made the same mistake seven times, and each time a single
command refuted it. All seven are in `INCIDENTS.md` on `main`:

- A probe measured the wrong case and its output was quoted as proof; CI produced the
  counter-example on its first run.
- A mutation silently restricted itself to line 1, changed nothing, and reported a clean pass.
- A report that "developers may add settings" was read as "the constraint is not real", twice in
  succession — the write ban and then the read ban, each refuted about a minute after being denied.
- **This file's own probe**: a branch count quoted as evidence that step 3 would fire, without
  stating that `lib.sh` excludes HEAD from it. Refuted by one
  `countLines "$(unmergedBranches ...)"` printing `2` — and the same claim had already been copied
  into PR #23's body before anyone ran it.
- **This file's own pre-decided outcome**: step 4's result written up in advance as evidence about
  exit-code semantics, without stating that a silent hook has two causes and "never ran" is one.
  The first run hit exactly that case.
- **CI's `Rules owed` step**: four local gates quoted as "green" without stating that none of them
  reads a pull request body. Refuted by the first push.
- **This file's own step-3 paragraph**: "the count from `main` is 1, so step 3 is dead", written
  from a list of merged pull requests rather than from the command three lines above it. #21 had
  not merged. Refuted by running that command.

The rule they paid for is in
[`PROVING.md`](../dev-house-rules/PROVING.md#measure-do-not-assume-and-the-assumption-is-usually-about-your-own-code)
— _state which case your check does not cover, before you quote it as evidence._ Keep the list
above: it is the evidence behind the rule, and this file is where the next instance will be made.
