# the-jira-police — architecture: development guardrails

What stops an agent working in this repository from touching a protected branch or merging its own
pull request, what the hook suite proves about those guards, and what it does not.

Index: [`ARCHITECTURE.md`](../ARCHITECTURE.md)

---

## 16. The development guardrails

These guard the people and agents working **on** this repository. They are not part of the service
and never reach a model it runs: `prepareSkillRoot` (§7) copies only `agent-solve` into a skill root
that must contain nothing else, so a solve pass cannot see them.

They exist because the rules in `CLAUDE.md` that are not advisory had nothing behind them but the
agent's own compliance. Two of the three have a script here — never work on a protected branch, and
a human merges. **The third, work in a worktree, has nothing and is not scheduled to**: what
`branch-guard.sh` does for it is get out of its way, by allowing `worktree add -b` off a protected
branch and by judging a write against the worktree it lands in. Neither of those enforces it. The rules lived
in a **model-invoked** skill, so whether they were read depended on whether the model chose to read
them, and the case where that is least likely — a narrow prompt late in a long session, or one just
after a compaction — is the case where they matter most.

### What is built

| script             | fires on                                                | what it does                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `branch-guard.sh`  | `PreToolUse` on `Bash`, `Edit`, `Write`, `NotebookEdit` | refuses a write on a protected branch (`main`, `master`, `develop`, `release/*`) — judged against the worktree the target file sits in, or for a `Bash` git write the checkout its `cwd` names when nothing in the command can point git elsewhere, and otherwise against the project directory — refuses a push naming one from any branch, and refuses `gh pr merge` from every branch |
| `branch-stack.sh`  | `PreToolUse` on `Bash`                                  | returns `ask` when a new branch would take the stack past `BRANCH_STACK_MAX` (default 3)                                                                                                                                                                                                                                                                                                 |
| `session-brief.sh` | `SessionStart`                                          | prints the contract; on `trigger=compact` it also inlines the three rules and `FINISHING.md`'s four questions                                                                                                                                                                                                                                                                            |
| `commit-brief.sh`  | `PreToolUse` on `Bash`                                  | prints `FINISHING.md`'s four questions when the command is a `git commit`, naming whichever branch the payload's `cwd` resolves to when it names one, and the project directory's otherwise; carries no permission decision at all                                                                                                                                                       |

`lib.sh` holds what they share. `test-hooks.sh` is the suite, behind `pnpm test:hooks`, which you run
if you change a script; `pnpm hooks:brief` and `pnpm hooks:commit-brief` render the two briefs on
demand. Registration lives in the settings file under `.claude/`, written and reviewed by the
operator, and has been in place since 2026-09-09.

**Three of the four guard the tree; `commit-brief.sh` guards nothing.** It is the only script here
that never refuses and never prompts — it emits `hookSpecificOutput.additionalContext` with exit 0
and no `permissionDecision`, which hands text to the model and leaves the permission flow untouched.
That is deliberate and not timidity: there is no mechanical test for "did you ask yourself these
four", so a refusal could not tell a satisfied condition from an unsatisfied one and would either
block every commit or be dismissed by rote. It exists because the four questions are the part of the
contract with no command behind them, and because `session-brief.sh` was firing at the wrong moment
— a compaction is not a commit, and a commit is the moment the questions are for.

**Both briefs extract rather than copy.** Every inlined block is pulled out of `CLAUDE.md` and
`FINISHING.md` at run time with `awk`, so neither can drift from the documents it quotes. Six of the
suite's mutations are stale pasted copies of exactly those extractions. Where they differ is the
degraded case: `session-brief.sh` goes quiet when a heading is renamed and relies on the suite
noticing, while `commit-brief.sh` says out loud that it has stopped working, because it fires at the
one moment where silence reads as approval.

### `git` is an allowlist; everything else fails open

`branch-guard.sh` classifies a `Bash` call by asking whether it would change the repository, and for
`git` the default is **write**: a named set of read verbs plus a named set of conditional ones, and
any other subcommand is a mutation. Commands that are not `git` keep fail-open behaviour, so `pnpm`,
`ls` and `grep` are untouched — the inversion is scoped to the one program whose write surface can be
enumerated.

It replaced a denylist of thirteen verbs that let 150 of git's 163 subcommands through on a protected
branch, `checkout` and `clean` and `update-ref` among them. **The audit and the reasoning are in the
script's own header comment** and are deliberately not repeated here; what belongs at this level is
the shape. A denylist over a program with several spellings per act is behind by construction — a verb
git adds next year is allowed on the day it ships — while under an inversion the failure mode is a
human adding one line to the read list.

Two properties of that inversion are worth naming because they are not obvious from the diff:

- **A guard's denial must not block the remedy it names.** Refusing every command on a protected
  branch traps the agent there, so `switch` and `checkout -b`/`-B` stay allowed — the spellings most
  fingers already know — while plain `checkout`, the destructive one, does not. **The hatch is
  allowed for the name it creates, not for the flag**: `-B`/`-C` reset an existing branch, so
  `checkout -B main` from a protected branch is the very act rule 1 names, and `hatchNamesProtected`
  refuses any of the four flags pointed at a protected name.
- **Mis-parsing can only over-refuse**, which is why the loop consuming git's global options has no
  write fixture that can see it break: with the options unconsumed, `-C` lands where the verb goes and
  is refused as an unrecognised write. Its only observable job is _not_ refusing a read that carries a
  global option, and that is what its assertions test.

The substring pass that predates the inversion is kept as a floor rather than replaced, because
command-position analysis cannot see inside `sh -c '...'`. The two are a union.

**And the floor had never actually been exercised.** Its verb terminator matched a space or
end-of-string, so `bash -lc "git push"` — the verb flush against the closing quote — fell through
both halves and was allowed on `main`. There was an assertion for that exact string, and for the
hundred minutes it existed — `4d5ef49` to `cbb5be0`, one afternoon of 2026-09-09, not the four days
that commit's own message claims — it passed on a defect in the harness rather than on the guard:
`bash_payload` interpolated commands into JSON without escaping, so a fixture containing a double
quote produced a payload the hook could not parse, and an unreadable command is treated as a write.
The guard denied for the one reason the assertion was not testing. **A test whose fixture cannot
reach the code path is indistinguishable from a passing test.** The terminator is now
`[^[:alnum:]_-]`, so a quote or a bracket ends the verb; `test-hooks.sh:97` carries how it was
found, as the third instance of `lib.sh`'s `jsonEscape` defect.

**Anchoring is the difference between guarding the act and censoring the words.** The `gh pr merge`
check matches only at command position, so prose and commit messages may discuss it freely. The push
check does not, and that is a known defect rather than a design choice — `PLAN.md` carries it.

### Rule 3 has no guard, so what is written here is the mechanism

`STARTING.md` says the branch gets its own worktree and cites this section for how. Nothing below
is enforced; it is the procedure the rule names, kept in one place so neither budgeted document has
to carry it.

```
git worktree add -b fix/<slug> ../the-jira-police-<slug> origin/main
```

- **Cut from `origin/main`, not from `HEAD`.** Omitting the last argument stacks the new worktree on
  whatever branch you were standing on, silently, which is the stacking `branch-stack.sh` counts.
- **It is not a working checkout yet.** `.env` and `node_modules/` are gitignored, so copy the first
  and `pnpm install` the second, or the suite fails for a reason unrelated to the change.
- **A copied `.env`'s relative paths now point into the worktree.** A run from it writes
  `OUTPUT_DIR` and `STATE_PATH` there, so its reports and calibration rows are deleted with it
  unless copied back; SSX-3980's `dev-lens.md` row, 2026-09-25, landed in a worktree this way.
- **Remove it in the same breath as the branch.** `git worktree remove` never deletes a branch and
  `git branch -d` never removes a worktree, so each one left behind orphans the other.
- **A human can waive the rule.** Nothing mechanical can, and nothing mechanical will notice.

**`branch-guard.sh` allows exactly the first line above from a protected branch, and nothing
adjacent to it** — the remedy-must-not-be-blocked property, applied to a rule the same script does
not enforce. The hatch requires a `-b`, refuses a `-b` naming a protected branch, and refuses every
other spelling: `add` without `-b` checks out a branch that already exists, and `-B` _resets_ one,
so `git worktree add -Bmain ../d` would be rule 1 spelled as its own remedy. That last form is the
reason the suite asserts the attached spellings (`-bmain`, `-Bmain`) and not just the separated
ones: widening the hatch from `-b?*` to `-[bB]?*` is a one-character edit, and until those
assertions existed it broke nothing the suite could see. **The same audit was owed to the hatches
already there and was paid late** — `checkout -B main` and `switch -C main` were allowed from a
protected branch until `hatchNamesProtected` closed them.

**A `Bash` git write is judged in the checkout its payload's `cwd` names, so the worktree has to be
where the session is.** Claude Code keeps `CLAUDE_PROJECT_DIR` on the primary checkout when a session
enters a worktree, and the registration reaches the script through it, so the guard that runs is the
primary checkout's copy and the project directory it reads stays on `main`. The `cwd` field is what
follows the session into the worktree and through each `cd`. Both are what Claude Code's worktree
documentation says, and the first was measured on 2026-09-25: with the worktree's copy reworded, the
live refusal kept the old wording. Enter the worktree with `EnterWorktree`, which asks first for a
path outside `.claude/worktrees/`, because a `cd` that leaves the project directory is reset rather
than kept.

**What the guard cannot place, it leaves to the project directory**: a `cd`, `pushd`, `source`, `-C`,
`--git-dir`, `--work-tree` or `GIT_DIR` anywhere in the command, a verb that can write a branch other
than the checked-out one (`branch -f`, `update-ref`, a refspec or a glob, a push naming no refspec),
or a floor verb inside another command. From a worktree with the primary checkout on `main`, each of
those is refused as it was before, and the refusal says which it was. The converse holds as well: a
write that starts in a protected checkout is refused whatever the project directory is.

**`commit-brief.sh` had the same defect, for display rather than for a decision.** It named
`CLAUDE_PROJECT_DIR`'s branch unconditionally, so a commit that landed cleanly inside a worktree was
still narrated as landing on `main`. It now prefers the branch its payload's `cwd` names, the project
directory's otherwise — no escape-hatch analysis, because nothing here refuses; a wrong name here
misleads and a wrong refusal in `branch-guard.sh` blocks.

**One consequence is left unfixed because it over-asks rather than under-refuses.**
`unmergedBranches` (`lib.sh:62`) drops the project directory's own HEAD from the stack count, which
assumed the agent stands on the branch it is working on. With the primary checkout parked on `main`
that exclusion matches nothing, so the branch you are working on is counted in its own depth and
`branch-stack.sh` asks one branch earlier than `BRANCH_STACK_MAX` says. Fixing it means unioning
every worktree's HEAD, and an `ask` that arrives early is not worth widening this branch for.

### The hook configuration: three routes, and they do not agree

The settings file that registers these hooks is a tracked file in this tree, and what an agent may do
with it depends on how it reaches for it:

| route                                   | result                                                          |
| --------------------------------------- | --------------------------------------------------------------- |
| `Write` / `Edit`                        | **refused** by the harness as a protected path                  |
| any shell command whose _text_ names it | **refused** — the rule matches the command text, not the target |
| the `Read` tool                         | **allowed**                                                     |

The permission to _change_ it is scoped to the human, not to the file's location; moving it inside the
repository bought no write access, and the agent a guard constrains does not get to wire it. Three
documents here claimed the read was refused too, and said so until 2026-09-09. It is not, and the
correction matters more than the fact, because a false claim about a capability removes the
operation that would have refuted it.

The shell rule's shape has a false-positive edge worth knowing: a `git commit -m` whose _message_
names the path is refused, and so is any other command that merely mentions it. The honest response is
to reword the message and say so out loud — never to re-spell the command.

The runbook for checking any of this is
[`claude-validation-work`](../.claude/skills/claude-validation-work/SKILL.md); its step 0 is two
zero-risk probes an agent can run on itself.

### Where the residual risk sits

**`.claude/hooks/*.sh` is not protected.** The agent can edit every script the settings file points
at, and `CLAUDE.md` positively expects it to. Neutering `branch-guard.sh` is a one-line diff, live
only once it reaches the primary checkout: the registration names the script through
`CLAUDE_PROJECT_DIR`, which entering a worktree does not move. What stops it is what stops any bad
change: it must be made on a branch, it lands in a pull request a human
reads, and CI runs the hook suite against it. **Review is the protection.** The write ban protects the
wiring, not the wire.

So the standing instruction is to behave as though none of this is registered. The three rules bind
on their own authority, never on a guard's — and rule 3 has no guard to mistake for one.

### What the suite proves, and five things it does not

`pnpm test:hooks` proves the **scripts** — that each emits the right decision and, since the exit-code
assertions were added, that it exits 0 while doing so. It says nothing about whether anything runs
them. Stated explicitly, because this is the section that owes it — and the five are not all the
same kind: the first three have never been measured at all, the fourth is a measured past failure of
the suite itself, and the fifth has been watched working, on the dates its own log records.

1. **`ask` has never been observed working.** `deny` carried on stdout with exit 0 was watched being
   honoured on 2026-09-09; `branch-stack.sh` is registered on `Bash` and was once watched _not_
   prompting when it should have. Whether `ask` is honoured at all is open, and `PLAN.md` carries it.
   It is not a small question: every guard written in the fail-open "make the human decide" style
   rests on it.
2. **The `gh pr merge` refusal is proven by inference only** — same code path, same `deny`, never run
   for real, and it must stay that way.
3. **A re-read of an _edited_ hook definition is untested**, because the agent cannot write the file to
   find out. Registration _appearing_ takes effect immediately rather than at the next session start:
   the same command was allowed and then refused minutes apart in one session, the only difference
   being a fast-forward that brought the settings file into the tree.
4. **The suite could not run anywhere but one laptop** until `8ad1a31`, because its assertions borrowed
   the developer's git identity. CI caught it the first time it ran them.
5. **`additionalContext` is honoured — watched by hand, never by the suite.** `PreToolUse` with
   exit 0, no `permissionDecision` and text under `hookSpecificOutput.additionalContext` reaches
   the model. `deny` is the other shape watched honoured on this transport; `ask` remains the one
   nobody has seen.

   **The log below is the record, and it is the only record.** No sentence here or anywhere else
   states how many sightings there are, because a figure in prose is the part that rots: three
   documents once carried three different ones. **Adding a sighting is appending a dated bullet**,
   never editing a sentence. Each line carries the date, the commit where there is one, and what was
   distinctive about it — "watched once, by hand" was unfalsifiable a month later.

   - **2026-09-09, commit `12b1220`** — "plan: the commit brief is documented everywhere except
     the working contract". The `git commit` that produced it arrived with `commit-brief.sh`'s four
     questions in front of it, verbatim, on a real commit rather than a hand-fed payload.
   - **2026-09-09, two `git commit` commands aimed at a throwaway clone under `/tmp`.** Both
     injected. Two things came out of it that the first sighting could not show. **One of the two
     commands was then refused by a different safety hook, and the context was injected anyway** —
     injection does not wait on the command being permitted, so the brief arriving is no evidence
     the commit ran. And **the brief named this repository's branch rather than the one being
     committed to**, because `commit-brief.sh` reads the branch from `CLAUDE_PROJECT_DIR` while
     matching on the command text; the two disagree whenever a commit targets a tree outside the
     project directory.

   **It stays on this list because the suite still cannot tell you any of that.** `pnpm test:hooks`
   asserts the script emits the right JSON, and it asserted exactly that on the days the hook was
   not yet registered. Every line above is one machine on one day, and "watched" is not
   "reliable" — the log is enough to stop calling the transport unproven and not enough to call it
   guaranteed. So when you need to know whether it still works, re-run it the way
   `claude-validation-work`'s step 0 re-runs the others, and **add a dated line above** rather than
   citing this paragraph forever.

### The fourth guardrail guards a habit, not the tree

CI's `Rules owed` step fails a pull request whose body does not answer `FINISHING.md`'s fourth
question. It is one of two checks in that workflow with no hand-run equivalent — the other is
`No budget override`, which is about the environment the run happens in — because what it reads is
the pull request body rather than the tree, and it is worth being exact about how little it proves:
**it cannot tell a true `Rules owed: none` from a false one.** It guarantees the question was
answered. Everything above it guards the repository; this one guards a habit that had failed four
times in two sessions before anyone noticed.

**Its disposal condition, written while it is still new.** If the fresh-context audit that produces
that line ever returns `none` on a diff that plainly owes something, the step is worse than nothing —
it will have made an unexamined omission _look_ examined — and it should be deleted rather than tuned.
A rule with a stated way to die is one somebody can actually retire.

### Deliberately not built

Recorded so that "we considered it" survives the session that considered it.

- **A `Stop` hook gating a turn on verification.** Offered and declined.
- **A `PreToolUse` guard refusing `git commit` when the branch has no `PLAN.md` entry.** It is the only
  version of the compaction fix with an exit code behind it, and also the version most likely to refuse
  a correct one-line fix — the failure where a guard acquires an enemy among the people who maintain
  it. It waits for a second instance.
- **A drift reporter judging whether prose is _true_.** Declined: that is a model call on every
  document. The narrow half shipped anyway, on 2026-09-08, as `pnpm docs:check` — which checks the
  prose facts that are _countable_, a regex and an exit code. The rest is still declined.
- **A rule making a blocked command an incident to write up.** Rejected because "record what it taught
  you before you re-attempt" reads as blessing the re-attempt, and a rule that can be read as
  permission will be.
- **A `docs:check` rule failing a bare SHA cited without an incident anchor**, and **a CI check
  requiring the old "What was learned" section to grow whenever a numbered entry is deleted.** Both
  would have caught a real defect, and both are mechanism ahead of evidence at one instance each. The
  second is the more tempting and the more dangerous — it would fire on every ordinary deletion, and
  on 2026-09-10 that section was deleted as an unbounded sink, so the check would now enforce the
  defect.
