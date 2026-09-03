# the-jira-police — bug-squashing agents

> **Progress.** Phase A is done and green (325 tests): `agentFitness` in the schema, the
> `solvable ⇒ ready-ish` rule and the `agent:` namespace boundary in the gate, `agent:solvable`
> added to §11. No new privilege was granted — the service still cannot write a file. Phase B
> (the second poller) is next.

## Context

The service today grooms tickets: it discovers new SSX issues over Jira REST, runs
`/intake-triage` headlessly, gates the result, and posts a verdict. It never touches code.
`ARCHITECTURE.md` describes that system; it is built and green (288 tests).

This plan adds the next stage: **for the subset of bugs an agent can fix safely, let an agent
fix them.** Triage grows a fitness assessment and tags the ticket `agent:solvable`. A second
poller watches for tagged tickets and, when authorised, fixes them in an isolated git worktree,
opens a draft PR, asks GitHub Copilot to review, iterates on that review, and only then marks
the PR ready. A human merges. Always.

Two things make this different from everything built so far, and both drive the design:

1. **The solver needs `Write`, `Edit` and `Bash`.** No component in this service has ever had
   any of them. That is a real privilege escalation and gets isolation, allowlists and
   mechanical (not model-asserted) verification.
2. **Triage cannot read source code.** `--deep` is hard-off and `Task` is not in `ALLOWED_TOOLS`,
   so the fitness call is made from the ticket plus the knowledge vault only. It is therefore a
   _candidate_ signal, not a guarantee — the solver re-checks against real code and is allowed
   to bail before writing anything.

Default posture is **manual**: nothing is solved until a human adds a label.

---

## Design

### 1. Two pollers

The existing poller cannot serve the solve queue. `isUnseen` (`src/state/store.ts:92`) checks a
permanent `seenKeys` list, so a ticket triaged on Monday can never re-enter — but a ticket
labelled for solving on Friday must. And the solve queue has no time dimension at all: it cares
about label state, not recency.

So: a second poller, sharing nothing but the JQL helpers.

|            | new-issue poller (exists) | solve-queue poller (new)       |
| ---------- | ------------------------- | ------------------------------ |
| Selects on | `created >= -Nm`          | labels                         |
| Cursor     | yes, `state/poll.json`    | **none**                       |
| Dedupe     | local `seenKeys`          | **ticket label state in Jira** |
| Cadence    | `POLL_INTERVAL_MS`        | its own, slower                |

Dedupe living in Jira rather than on disk is the important half. The claim is a label
transition on the ticket, which means the queue survives a restart, a wiped `state/`, and a
second instance, without a lock file.

Add `buildSolveQueueJql` to `src/jira/jql.ts` beside `buildNewIssuesJql`, reusing `assertSafe`
and `jqlValue` unchanged:

```
project = SSX AND component IN (...) AND statusCategory != Done
  AND labels = "agent:solvable"
  AND labels = "agent:start"            -- manual mode only; omitted in auto
  AND labels NOT IN ("agent:solving", "agent:done", "agent:failed")
ORDER BY updated ASC
```

Note on the classic `labels NOT IN (...)` gotcha — it excludes issues whose `labels` field is
empty. Harmless here: the `labels = "agent:solvable"` clause guarantees every candidate has at
least one label. Verify anyway (see Verification).

### 2. Fitness assessment in triage

Extend `TRIAGE_SCHEMA` (`src/triage/schema.ts`) with an `agentFitness` object beside `mutation`.
`additionalProperties: false` means this is a real schema change, not just a new label value.

**Left out of the top-level `required` list, contrary to the first draft of this plan.** Two
reasons pointing the same way: the schema's own header warns that each required field is another
way for a run to fail after paying for the work, and this one is five subfields deep; and omission
has to mean something safe. `parseAgentFitness` reads absent, malformed, and truthy-but-not-`true`
all as `solvable: false`, so silence is a refusal. Requiring the field would turn a model's silence
into a retry loop instead.

```ts
agentFitness: {
  solvable: boolean,          // the call
  confidence: "low"|"med"|"high",
  repo: string,               // must be on the pilot allowlist
  rationale: string,          // why, in one line
  blockers: string[],         // empty iff solvable
}
```

**Gate `solvable: true` on `verdict === "ready-ish"`.** This is not an extra restriction bolted
on — it falls out of the existing rules and resolves the tension the research surfaced:

- The dev lens (repo · blast radius · exact file · chosen technique · rejected alternative) is
  already ~80% of a fixability call, and it only fires on ACCEPT.
- `assertDorCoherent` already forbids `ready-ish` when `dorPlaceholders` is non-empty.
- A bug whose acceptance criteria are not yet testable is genuinely not safely auto-fixable.

So the three line up: DoR passes ⇒ testable ACs ⇒ dev lens exists ⇒ an agent has something to
verify against. `dor:gaps` tickets are never `agent:solvable`, and that is correct rather than a
limitation. Enforce it in `assertPostable`, alongside the existing coherence rules.

The label reaches Jira through the **existing** poster path — the schema description instructs the
model to include `agent:solvable` in `labels`, and the existing delta-agreement rule carries it
into `labelsAdd`. No new write path, no second paid run, no new skill.

The coherence check reads `labels` and **not** `labelsAdd`, which the first draft got wrong. The
delta holds only labels not already on the issue, so a second run over an already-marked ticket
legitimately omits it; keying on the delta would reproduce the withdrawn prose check exactly —
quiet on first runs, noisy on the re-runs. A separate rule bounds the namespace: triage may add or
remove `agent:solvable` and no other `agent:` label, so it cannot grant itself `agent:start`.

Do **not** add a scorecard row. The six rows are fixed (`SKILL.md:42`,
`REPORT_TEMPLATES.md:32`); fitness belongs in the dev-lens sentence.

### 3. Label state machine

User's names, namespaced per the earlier decision: `solvableByAgent` → **`agent:solvable`**,
`startSolving` → **`agent:start`**.

```
agent:solvable          triage's call; set by the grooming poster
   + agent:start        the human go-ahead (manual mode) — the only human step
   → agent:solving      claimed; agent:start removed in the same edit
   → agent:reviewing    draft PR open, Copilot review requested
   → agent:done         PR marked ready for review
   → agent:failed       bailed or exhausted; comment says why
```

`agent:solving` is written **before** any work starts. That single edit is the claim, and it is
what makes the queue idempotent.

Two coordinated edits, in this order:

1. `.claude/skills/intake-triage/INTAKE_INSTRUCTIONS.md:269` — add `agent:*` to the §11
   removal list, so the bot can clear its own labels on a re-run.
2. `src/triage/gate.ts:71` — add `"agent:"` to `OWNED_LABEL_NAMESPACES`. The doc comment at
   `:69` says "Widen this only by widening §11 first" — that is the ordering above, honoured.

This is the second local divergence from Jacob's skill (`next:*` is the first). Record it in
`ARCHITECTURE.md` §12 and tell Jacob about both.

### 4. Control plane

Two independent settings, both failing closed:

- `SOLVE_ENABLED` (default `false`) — master switch. Off ⇒ the second poller never starts.
- `SOLVE_MODE` (`manual` | `auto`, **default `manual`**) — manual requires `agent:start`.

Plus `SOLVE_REPOS` (allowlist, pilot: `buy-insurance-advisor-web` only),
`MAX_CONCURRENT_SOLVES` (1), `MAX_REVIEW_ITERATIONS` (3).

A ticket whose `agentFitness.repo` is not on `SOLVE_REPOS` is skipped, not failed — widening the
allowlist should pick it up later without a manual reset.

### 5. The solver

**Isolation is mandatory.** Of five SSX repos checked out locally, three are dirty and on
feature branches. The solver never touches a working checkout:

```
git -C <repo> fetch origin
git -C <repo> worktree add <tmp>/SSX-1234 -b fix/ssx-1234-<slug> origin/main
```

Branch name follows the vault convention (`fix/{jira-id}-{slug}`,
`insurance-knowledge-vault/.ai-rules/git-conventions.md`). Worktree removed on completion;
kept on failure for inspection.

Verification is **discovered, not assumed** — the vault records no test or build command. Read
`package.json` scripts in the worktree; require a test script; run install first (fresh
worktrees have no `node_modules`; pnpm's content-addressable store makes this cheap after the
first).

**Recon before code.** First pass is read-only: locate the fault, confirm the dev lens was
right. If it was not, the solver writes `agent:failed` plus a comment explaining what triage
could not have known, and stops. Bailing here is a success, not an error — it is the honest
answer to a fitness call made without source access.

Guards on the write pass:

- Tool allowlist: `Read`, `Grep`, `Glob`, `Edit`, `Write`, plus `Bash` scoped to the discovered
  package-manager commands. No `git push` from inside the model's session — the harness pushes.
- **Verification is mechanical.** The harness runs tests/typecheck/lint itself and reads exit
  codes. The model is never asked whether the tests passed.
- **Diff-bounds gate**, in the same spirit as `assertPostable`: cap files touched and lines
  changed; reject any diff touching lockfiles, CI config, `.github/`, or anything outside the
  repo. Refusal writes an artifact, as rejections already do.
- Commit message must satisfy the vault's Conventional Commits rules — mechanically checkable,
  so check it.

### 6. Delivery: draft PR → Copilot → iterate → ready

`gh` 2.97.0 is installed and authenticated (scopes `repo`, `read:org`), and supports
`--add-reviewer @copilot` natively.

```
gh pr create --draft --title "..." --body-file <body>   # links the Jira issue
gh pr edit <n> --add-reviewer @copilot
→ agent:reviewing
```

The review loop does **not** need a third poller. Each solve-poller tick does two things:
first advance any ticket in `agent:reviewing`, then start at most one new solve. Advancing means
`gh pr view --json reviews,comments`, and:

- no Copilot review yet → nothing to do, next tick
- review with actionable comments → run a solve iteration against them, push, re-request
  review, increment the counter
- review clean, or `MAX_REVIEW_ITERATIONS` hit → `gh pr ready <n>` → `agent:done`, comment the
  PR link on the ticket

Hitting the iteration cap still undrafts, but says so in the ticket comment. A human always
merges; the bot has no merge path.

### 7. Phasing

Ship and calibrate the assessment before granting any code-writing privilege.

| Phase | Scope                                                                                                    | New privilege         |
| ----- | -------------------------------------------------------------------------------------------------------- | --------------------- |
| **A** | `agentFitness` schema + gate rule + `agent:solvable` label                                               | **none**              |
| **B** | Second poller, JQL, label state machine, dry-run solver that claims/comments/releases but writes no code | Jira label writes     |
| **C** | Real solver: worktree, recon, edit, mechanical verification, diff gate                                   | `Write`/`Edit`/`Bash` |
| **D** | Push, draft PR, Copilot loop, undraft                                                                    | `git push`, `gh`      |

Phase A is worth living with for a while on its own: it costs nothing extra per run, and it
tells you how often the fitness call is right before anything acts on it.

---

## Files

- `src/triage/schema.ts` — `agentFitness` in `TRIAGE_SCHEMA` + `required`
- `src/triage/gate.ts` — `agent:` namespace; `solvable ⇒ ready-ish` coherence rule
- `src/jira/jql.ts` — `buildSolveQueueJql`, reusing `assertSafe` / `jqlValue`
- `src/settings.ts` — `SOLVE_ENABLED`, `SOLVE_MODE`, `SOLVE_REPOS`, `MAX_*`
- `src/solve/` (new) — `poller.ts`, `worktree.ts`, `verify.ts`, `diff-gate.ts`, `pr.ts`,
  `runner.ts`, `labels.ts`
- `src/wiring.ts` — compose the second poller the way `createPollDeps` composes the first, so
  `solve:once` is a genuine rehearsal of the daemon
- `src/cli/solve-once.ts` (new), `package.json` script `solve:once`
- `.claude/skills/intake-triage/INTAKE_INSTRUCTIONS.md:269` — `agent:*` in §11
- `ARCHITECTURE.md` — §12 divergence, new invariants

## Verification

Unit/integration, following existing patterns:

- `jql.test.ts` — solve-queue JQL for both modes; injection attempts still rejected
- `gate.test.ts` — `solvable: true` with `verdict !== "ready-ish"` is rejected; with non-empty
  `dorPlaceholders` is rejected
- `diff-gate.test.ts` — lockfile, `.github/`, path-escape and over-cap diffs all refused
- Solve poller against a fake Jira: claim is idempotent, a second instance picks nothing up
- **Mutation tests for every new guard** — the house rule: _a guard is not shipped until a test
  fails when it is unplugged._

Must be probed against reality, not assumed:

1. **Bash tool scoping syntax** — whether `Bash(pnpm test:*)` is honoured by the local arg
   parser. `storecode --help` documents only wrapper flags, so probe it. Phase C does not ship
   until this is confirmed; if it is not honoured, the harness runs the commands and the model
   gets no `Bash` at all.
2. **`labels NOT IN (...)`** against the live board with a control group — one labelled ticket,
   one unlabelled — the same way sub-task exclusion was verified.
3. **`gh pr edit --add-reviewer @copilot`** on a throwaway PR in the pilot repo: confirm Copilot
   review is available to this org and that `repo` scope suffices.
4. **Cost.** A triage run measured $0.11. A solve is a different order of magnitude — measure
   one before enabling the loop, and consider a per-ticket budget cap.

End to end, in order: run `triage:once` on a known bug and read `agentFitness` in the artifact
(no writes) → enable Phase B with `SOLVE_ENABLED=true`, hand-label a ticket, watch it claim and
release → Phase C on one ticket in the pilot repo, inspect the worktree diff by hand before
enabling Phase D.

## Out of scope

Auto-merge. Multi-repo. Cross-repo changes. Reopening `agent:done` tickets. Bot-noise tickets
(CVE/GHSA/SNYK/dependency bumps) — currently discarded at intake, and the most agent-fixable
class there is, so worth revisiting once the pilot has a track record.

## Open, deliberately

`bugFastPath` (`INTAKE_INSTRUCTIONS.md:39-50`, default OFF) is the existing hook for
bug-specific behaviour and is in direct tension with this feature: it short-circuits a `Feil` to
a one-line note with no scorecard — and therefore no dev lens and no fitness call. If it is ever
switched on, these two need reconciling. Flagged now, not solved.
