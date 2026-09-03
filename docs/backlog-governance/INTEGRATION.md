# intake-triage — provenance and how it is invoked headlessly

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

## What the invocation does about it

Four things stood between having the file and getting a verdict out of it headlessly. All four are
now handled — three in the invocation, one in the schema. Every claim below was checked against a
real run: `triage:once SSX-3814 --skill intake-triage`, 2026-09-03, three minutes, exit 0.

### 1. The knowledge vault — handled

`SKILL.md` step 2 resolves `--vault` → `$INSURANCE_VAULT` →
`~/Projects/repositories/insurance-knowledge-vault` → a walk up from cwd for an `index.yaml`, and
then:

> **If none is found, STOP and ask the user for the path, or tell them they must clone
> `insurance-knowledge-vault` to run intake.**

"STOP and ask the user" in a `-p` run means the model narrates a question to nobody and exits 0 —
the same silent-success shape the MCP status guard exists to catch. Dedup and routing are both
vault-backed, so a run without one is not a degraded verdict, it is a fabricated one.

So `VAULT_PATH` is a setting, and `buildTriageOptions` **refuses to start** without it for any
skill that is not one of the two stand-ins. It then reaches the skill two ways:

- as **`$INSURANCE_VAULT`** in the subprocess environment, which is the skill's own second
  resolution step — rather than as its `--vault` flag, because a flag has to survive the model
  parsing it back out of a prompt string and an environment variable does not;
- as **`--add-dir <path>`**, because the vault is a _sibling_ of this repo. The walk-up search
  would never find it, and neither would `Read` without being told the directory is in play.

### 2. The HTML dashboard — handled

> the HTML roll-up dashboard is written automatically after every run — suppress it, or set its
> path

`Write` is deliberately absent from `ALLOWED_TOOLS`, so left on this ends every run with a denied
call. The invocation passes `--no-html`: this service already has a sink, and a second unrelated
report at an unmanaged path is not an output anyone asked for.

The step-3 dossier cache at `.claude/intake/<KEY>-dossier.yaml` has no opt-out flag, so that write
is simply denied. The live run confirms this is survivable and says so itself: "dossier cache: **not
written** (Write tool denied in don't-ask mode; a `--deep` re-run would re-research from scratch)".
The cost is re-research on a repeat run, which this service does not do.

### 3. Verdict vocabularies differ — handled

`REPORT_TEMPLATES.md` banners are `✅ ACCEPT` · `⛔ REJECT` · `↪ ROUTE` · `↩ SEND BACK`, and the
schema now names all five outcomes they cover:

| Skill banner               | Schema verdict |
| -------------------------- | -------------- |
| `✅ ACCEPT`                | `ready-ish`    |
| `⛔ REJECT → duplicate`    | `duplicate`    |
| `⛔ REJECT → out-of-scope` | `out-of-scope` |
| `↪ ROUTE`                  | `not-our-team` |
| `↩ SEND BACK`              | `needs-info`   |

`out-of-scope` was added because the first live run needed it and did not have it. The skill
reached `⛔ REJECT → out-of-scope`, found no such member, and reported the mismatch in its own
caveat line: "verdict enum forced to `needs-info` (closest of duplicate/not-our-team/needs-info/
ready-ish) — the true call is **out-of-scope, already closed**, so do not read it as 'go ask the
reporter'."

That is the failure worth dwelling on. The report was honest; the machine-readable field on top of
it was not. Anything reading the verdict rather than the prose — a canvas checklist, a filter, a
person skimming — would have been told to chase a reporter about a ticket that wanted nothing. The
mapping is now spelled out in the schema's own `description`, so the model is told which banner
becomes which value instead of picking the nearest survivor.

### 4. `--deep` must stay off — satisfied

> **Do not spawn sub-agents in the default run** — they cannot prompt for tool permissions and
> will fail.

`deep: false` is the default and `Task` is absent from `ALLOWED_TOOLS`. Recorded here so nobody
enables `--deep` later without reading why it was off.

## Stand-in skills

`mock-triage` and `live-triage-probe` are exempt from all of the above: neither reads a vault,
neither writes a dashboard. Everything else — including a fork of `intake-triage` under another
name — is treated as the real thing. That is the safer default: a fork handed a vault it does not
need loses nothing, whereas one quietly denied a vault answers with confidence and no dedup behind
it.

## Verified live

`triage:once SSX-3814 --skill intake-triage`, 2026-09-03, exit 0 after three minutes. From the run
itself, not from a self-assessment:

- **Vault reached.** The report cites `reference/teams.md` with its verification date and notes
  that `index.yaml` carries no `last_scanned` — it read the files, it did not assume them.
- **No dashboard.** "HTML dashboard: **suppressed** (`--no-html`)".
- **Nothing written to Jira.** The write payload was rendered as a preview and explicitly "NOT
  OFFERED — `--no-write` is a pure dry-run".
- **No sub-agents**, no `--deep`.

## Still open

1. `SKILL_NAME` still defaults to the mock. Flipping it to `intake-triage` is a deliberate,
   separate decision — it is the switch that starts spending money per ticket.
2. `triage:once` writes `<KEY> (summary not fetched in single-run mode)` as the heading, because it
   skips discovery. The skill knows the real summary; the sink is not told it.
