# intake-triage — provenance and what still blocks a headless run

## Provenance

Vendored from `backlog-governance` (Jacob Biørn), snapshot taken **2026-09-03**. Not a git
submodule and not a symlink, because the service resolves skills from its own working directory
(`runTriage` passes `workingDirectory: process.cwd()`), and a checkout that depends on a file
living somewhere in the operator's home directory is a checkout that works on exactly one machine.

| In this repo                                    | Upstream                       |
| ----------------------------------------------- | ------------------------------ |
| `.claude/skills/intake-triage/`                 | `skills/intake-triage/`        |
| `docs/backlog-governance/upstream-README.md`    | `README.md`                    |
| `docs/backlog-governance/strategy.md`           | `strategy.md`                  |
| `docs/backlog-governance/intake-triage.spec.md` | `skills/intake-triage.spec.md` |

`strategy.html` was not copied — it is a rendering of `strategy.md`, and a generated artefact in
version control just goes stale silently.

The skill files are **verbatim**. Anything this service needs changed belongs in the invocation or
in an upstream patch, not in a local edit: a local edit is invisible the next time someone
re-syncs, and this is the one file in the repo we do not own.

`SKILL.md` carries `disable-model-invocation: true`, so vendoring it here does not make an agent
working in this repo start running intake on its own. It only runs when something types
`/intake-triage`.

## Status: installed, not yet wired

`SKILL_NAME` still defaults to the probe skill. Four things stand between this file being present
and `SKILL_NAME=intake-triage` producing a real verdict.

### 1. The knowledge vault is not on this machine — fatal

`SKILL.md` step 2 resolves `--vault` → `$INSURANCE_VAULT` →
`~/Projects/repositories/insurance-knowledge-vault` → a walk up from cwd for an `index.yaml`, and
then:

> **If none is found, STOP and ask the user for the path, or tell them they must clone
> `insurance-knowledge-vault` to run intake.**

None of those paths resolves here, and "STOP and ask the user" in a `-p` run means the model
narrates the question to nobody and exits 0. That is the same silent-success failure mode the MCP
status guard exists to catch, so whatever we do about the vault, the runner should also refuse a
verdict produced without one.

Dedup and routing are both vault-backed, so this is not a degradation we can accept and move on
from — it is most of what the skill does.

### 2. The HTML dashboard is written on every run

> the HTML roll-up dashboard is written automatically after every run — suppress it, or set its
> path

`Write` is deliberately absent from `ALLOWED_TOOLS`, so today the skill would reach the end of its
work and then hit a denied tool call. `--no-html` opts out and is the right answer: this service
already has a sink, and a second, unrelated report written to an unmanaged path is not one of the
outputs anyone asked for. `runTriage` has no flag for it yet.

Same applies to the step-3 dossier cache at `.claude/intake/<KEY>-dossier.yaml`. There is no flag
to disable it. It only buys re-run speed, so a denied write there should be harmless — but
"should be" is doing real work in that sentence and it needs to be watched on the first live run.

### 3. Verdict vocabularies differ

`REPORT_TEMPLATES.md` banners are `✅ ACCEPT` · `⛔ REJECT` · `↪ ROUTE` · `↩ SEND BACK`.
`TRIAGE_SCHEMA` constrains `verdict` to `duplicate | not-our-team | needs-info | ready-ish`.

The good news is that they line up almost exactly:

| Skill banner            | Schema verdict |
| ----------------------- | -------------- |
| `✅ ACCEPT`             | `ready-ish`    |
| `⛔ REJECT → duplicate` | `duplicate`    |
| `↪ ROUTE`               | `not-our-team` |
| `↩ SEND BACK`           | `needs-info`   |

The one that does not map is `⛔ REJECT → out-of-scope`, which is neither a duplicate nor another
team's problem. Squeezing it into `not-our-team` would be a lie in the one place a reader trusts.
Either the schema grows an `out-of-scope` member or the report has to carry the distinction.

### 4. `--deep` must stay off

> **Do not spawn sub-agents in the default run** — they cannot prompt for tool permissions and
> will fail.

`deep: false` is already the default and `Task` is already absent from `ALLOWED_TOOLS`, so this
one is satisfied — recorded here so nobody enables `--deep` later without reading why it was off.

## What a first live run needs

1. Clone `insurance-knowledge-vault`, or get its path, and decide whether to point the runner at
   it with `--vault` or with `$INSURANCE_VAULT`.
2. Teach `runTriage` to pass `--no-html`.
3. Settle the `out-of-scope` verdict.
4. Run one ticket by hand through `triage:once` before letting the daemon near it.
