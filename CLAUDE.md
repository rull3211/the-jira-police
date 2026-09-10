# the-jira-police

A TypeScript service that grooms Jira tickets and fixes the subset an agent can fix safely: triage,
claim, fix in an isolated worktree, draft PR, answer the review. Node ≥24, pnpm, **no build step**.

## Two rules that are not advisory

1. **Never work on `main` or any protected branch.** Branch first — `feat/`, `fix/`, `chore/`,
   `docs/`, `refactor/`. One branch per reviewable unit of privilege. Do not look for a way
   around this; ask instead.
2. **A human merges. Always.** This service has no merge path and neither do you. Opening a pull
   request is the end of your side of the work.

**Assume nothing mechanical is holding either one, because a guard can be registered and still fail
open.** `.claude/hooks/branch-guard.sh` refuses writes and pushes naming a protected branch, and `gh
pr merge` from every branch; `pnpm test:hooks` is its suite — run it if you change a hook, but it
proves only that each script _emits_ the right refusal, never that the runtime _acts_ on it.
[`claude-validation-work`'s step 0](.claude/skills/claude-validation-work/SKILL.md#step-0--is-branch-guardsh-actually-firing-right-now)
settles that in one turn. You may `Read` the `.claude/settings.json` registering them; _writing_ it
is refused, as is any shell command that merely names the path, and that ban is not to be worked
around. [`ARCHITECTURE.md` §16](ARCHITECTURE.md) has each guard, what the suite misses, and why the residual
risk is `.claude/hooks/*.sh` rather than the settings file.

**Do not stack branches deeply** — three stacked here once turned an incremental plan into a
waterfall;
[`STARTING.md`](.claude/skills/dev-house-rules/STARTING.md#phase-a-privilege-and-drive-it-by-hand-first)
has the story.

## The working contract, by phase

**`.claude/skills/dev-house-rules/` is the working contract, not a style guide — its rules generalise
defects that already got through, and those with an incident cite it.** **Load the phase you are in**, or
[SKILL.md](.claude/skills/dev-house-rules/SKILL.md) if you do not know which:

| when you are                                 | load                                                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| resuming work you did not start              | `git status`, `git log --oneline -5`, the [`PLAN.md`](PLAN.md) entry naming your branch, then the row below |
| starting anything that is not a one-line fix | [STARTING.md](.claude/skills/dev-house-rules/STARTING.md)                                                   |
| writing or deleting code                     | [BUILDING.md](.claude/skills/dev-house-rules/BUILDING.md)                                                   |
| adding a guard, a test, or running the thing | [PROVING.md](.claude/skills/dev-house-rules/PROVING.md)                                                     |
| committing, or amending the rules themselves | [FINISHING.md](.claude/skills/dev-house-rules/FINISHING.md)                                                 |
| asking _why_ a rule exists                   | [INCIDENTS.md](.claude/skills/dev-house-rules/INCIDENTS.md) — cited from the rules that have one            |

**The first row is the one that gets skipped, because nothing announces that it applies.** A compacted
context, or a session picking up somebody else's branch, inherits an account of the work, not the
work. Find out where you are before matching a row.

**Every rule in there is provisional**, amended from incidents, not theory; if one is wrong, say so.

## The four questions

**They have no command behind them, and this file is what survives a compaction; `pnpm docs:check`
fails once the copy drifts from
[`FINISHING.md`](.claude/skills/dev-house-rules/FINISHING.md#the-checklist),** which has both in
full. Ask them before every commit.

- [ ] **Any comment _near_ the change that is now true of something else?**
- [ ] **If this fails at 3am, what does it leave behind?**
- [ ] **What did the run refute?**
- [ ] **Did something get through that these rules do not cover?**

**If you cannot remember reading `FINISHING.md` in this session, you have not read it.** `pnpm
hooks:brief` prints these four in full, the two rules above, and your branch and stack depth;
`commit-brief.sh` prints them at a `git commit`, if the operator registered it — watched by hand,
never by the suite ([§16](ARCHITECTURE.md)). Both remind; neither can check. Read the four here.

## Where the truth lives

- [README.md](README.md) — how to run it
- [ARCHITECTURE.md](ARCHITECTURE.md) — how it works, the map
- [PLAN.md](PLAN.md) — what is **not** built; never lessons
- [dev-house-rules](.claude/skills/dev-house-rules/SKILL.md) — how we work

**All four are treated as source.** Prose falsified by a change is rewritten in the same commit, not
the next. Structural facts live in `ARCHITECTURE.md` and are cited, never copied — grep it for
the symbol you need rather than reading it whole; `pnpm docs:check` enforces the mechanical part.

## Before you start

**Write it into `PLAN.md` first** — what is being attempted, why now, and what would make it the
wrong idea, opening with a bold `Branch:` label naming the branch; the entry is deleted **in the
last commit before you push**, not at merge: the reviewer is the one misled. Then pick the branch. Why a diff is not enough:
[STARTING.md](.claude/skills/dev-house-rules/STARTING.md#the-plan-is-written-before-the-work-not-after-it).

## Working style

- **Run it.** A green suite is a statement about the tests; every defect of consequence here was found by
  driving a command at a real target.
- **Say what you want to change, and why, before you change it** — house rules included.
- **Leave nothing orphaned** — a symbol, a setting, a merged branch. Cleanup belongs to the change
  that caused it.
