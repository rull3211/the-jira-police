# the-jira-police

A TypeScript service that grooms Jira tickets and, for the subset of bugs an agent can fix safely,
solves them: triage, claim, fix in an isolated worktree, draft PR, answer the review. Node ≥24 with
type-stripping, pnpm, **no build step**.

## Two rules that are not advisory

Everything else is recoverable if you get it wrong. These two are not, so they are stated here
rather than routed to.

1. **Never work on `main` or any protected branch.** Branch first — `feat/`, `fix/`, `chore/`,
   `docs/`, `refactor/`. One implementation branch per reviewable unit of privilege. Do not look for
   a way around this; ask instead.
2. **A human merges. Always.** This service has no merge path and neither do you. Opening a pull
   request is the end of your side of the work.

**Assume nothing mechanical is holding either of these, because you cannot check.** Both now have
guards written and tested in `.claude/hooks/` — `branch-guard.sh` refuses writes and pushes on a
protected branch, and refuses `gh pr merge` from every branch — with their own suite,
`pnpm test:hooks`, which you run if you change one. Since 2026-09-09 they are also registered, by a
`.claude/settings.json` the operator writes and reviews here. That moves the file inside this tree
and buys you no self-inspection: the permission is scoped to the human, not to the file's location,
so you are refused it in both directions and cannot confirm that it exists, parses, or names the
right paths. Do not ask another agent to check either — the honest reply is a refusal. And
`pnpm test:hooks` proves only that each script _emits_ the right refusal, never that the runtime
_acts_ on it; the agent a guard constrains is the last one who should be certifying it. Both rules
bind exactly as hard as if they were enforced; the only difference is that breaking one may not be
caught. `PLAN.md` §12 records what is built, what it does not cover, and the probe a human runs to
prove enforcement.

**Do not stack branches deeply** — three stacked here once turned an incremental plan into a
waterfall. The rule and the story are in
[`dev-house-rules/STARTING.md`](.claude/skills/dev-house-rules/STARTING.md#phase-a-privilege-and-drive-it-by-hand-first).

## The working contract, by phase

**`.claude/skills/dev-house-rules/` is the working contract for this repository.** It is not
optional reading and it is not a style guide; every rule in it is the generalisation of a defect
that already got through here. It is split the way a change is — **load the phase you are in**:

| when you are                                 | load                                                                                                                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| resuming work you did not start              | `git status`, `git log --oneline -5`, then the [`PLAN.md`](PLAN.md) entry naming your branch — in-flight entries open with one — then the row below that matches what you are about to do |
| starting anything that is not a one-line fix | [STARTING.md](.claude/skills/dev-house-rules/STARTING.md)                                                                                                                                 |
| writing or deleting code                     | [BUILDING.md](.claude/skills/dev-house-rules/BUILDING.md)                                                                                                                                 |
| adding a guard, a test, or running the thing | [PROVING.md](.claude/skills/dev-house-rules/PROVING.md)                                                                                                                                   |
| committing, or amending the rules themselves | [FINISHING.md](.claude/skills/dev-house-rules/FINISHING.md)                                                                                                                               |
| asking _why_ a rule exists                   | [INCIDENTS.md](.claude/skills/dev-house-rules/INCIDENTS.md) — cited from each rule                                                                                                        |

**The first row is the one that gets skipped, because nothing announces that it applies.** A
compacted context, or a session picking up a branch somebody else left, inherits an account of the
work rather than the work — so it knows the rules and not its own position, and the phase rows all
read as though you are starting. You are not: find out where you are before matching a row.

[SKILL.md](.claude/skills/dev-house-rules/SKILL.md) is the index and the shortest possible summary.
Start there if you do not know which phase you are in.

**Every rule in there is provisional.** They are amended from incidents rather than from theory, so
read each as a hypothesis that has survived so far. If one is wrong, say so and propose the change
before making it.

## The four questions, copied here on purpose

**This is copied prose, and the exemption is that `pnpm docs:check` fails the run once the copy
drifts from the original.** It is duplicated here because this file is re-injected into a compacted
context and `FINISHING.md` is not, and because these four are the part of the contract with no
command behind them — nothing else will ever notice them being skipped. Ask them before every
commit; the full text and the reasoning are in
[`FINISHING.md`](.claude/skills/dev-house-rules/FINISHING.md#the-checklist).

- [ ] **Any comment _near_ the change that is now true of something else?**
- [ ] **If this fails at 3am, what does it leave behind?**
- [ ] **What did the run refute?**
- [ ] **Did something get through that these rules do not cover?**

**If you cannot remember reading `FINISHING.md` in this session, you have not read it.** Run
`pnpm hooks:brief` before committing: it prints these four in full, the two rules above, and the
current branch and stack depth. Trigger it off the commit rather than off a compaction — a commit is
a moment you can observe, a compaction is not. The `SessionStart` hook does now print unasked, but
at startup it prints only a pointer to the contract; it inlines these four on `trigger=compact`, and
a commit is not a `SessionStart` trigger at all. So the moment they are for is still the one nothing
fires on: this stays a habit and not a guard, and nothing checks that you ran it.

## Where the truth lives

| file                                                       | answers                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------- |
| [README.md](README.md)                                     | how to run it, what each command does                   |
| [ARCHITECTURE.md](ARCHITECTURE.md)                         | how it works, why it is shaped this way, the module map |
| [PLAN.md](PLAN.md)                                         | what is **not** built yet, and what was learned         |
| [dev-house-rules](.claude/skills/dev-house-rules/SKILL.md) | how we work, and what went wrong last time              |

`ARCHITECTURE.md` is three times the size of the next largest document here — grep it for the symbol
you need and read that section. Nothing asks you to read it whole, and a context that has just been
compacted has the least room to find that out the expensive way.

**All four are treated as source.** Prose falsified by a change is rewritten in the same commit, not
the next one. Structural facts — modules, entry points, the composition — live in `ARCHITECTURE.md`
and are cited from elsewhere, never copied. `pnpm docs:check` enforces the part of that which is
mechanical — the counts cited in prose, and every cross-document link.

## Before you start

**Write it into `PLAN.md` first** — what is being attempted, why now, and what would make it the
wrong idea, opening with a bold `Branch:` label naming the branch so the entry can be found from it.
Then do the work; the entry is deleted when it ships. This is not bookkeeping. Work here
is done in sessions that end and compact, and a session that holds the intent only in its own
context leaves the next one a diff and a branch name. A diff never says what was being attempted or
what was already ruled out.

Then pick the branch: one per reviewable unit of privilege, and delete local branches that have
already merged — auto-delete-on-merge cleans the remote only.

## Working style

- **Run it.** A green test suite is a statement about the tests. Every defect of consequence in this
  project was found by driving a command against a real target, not by the suite.
- **Make it runnable.** Every capability gets a one-line command in the same commit.
- **Say what you want to change, and why, before you change it.** That applies to the house rules
  themselves.
- **Leave nothing orphaned** — a symbol, a setting, a merged branch. Cleanup belongs to the change
  that caused it, not to a later sweep.
