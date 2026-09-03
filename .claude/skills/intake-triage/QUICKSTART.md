# intake-triage — quickstart (install & run)

Canonical install/run doc. The Confluence "How to run intake-triage" page mirrors this — if the
two diverge, update both.

## Prerequisites (all three)

1. **Claude Code** — installed and signed in.
2. **Atlassian MCP** — connected and authenticated once: in a session run `/mcp` → **atlassian**
   → **Authenticate** (browser sign-in). Lets the skill read Jira and post comments. If
   `atlassian` is not listed, add the server (`claude mcp add --scope user --transport http
atlassian <url>`) — get the URL from the team.
3. **insurance-knowledge-vault** — cloned to `~/Projects/repositories/insurance-knowledge-vault`.
   The skill hard-stops without it. Override the location with `--vault <path>` or
   `$INSURANCE_VAULT`.

## Install (once, per machine)

```bash
# Copy the skill folder into your personal skills dir…
cp -r <path>/intake-triage ~/.claude/skills/
# …or symlink it, to track updates from source:
ln -s <path>/intake-triage ~/.claude/skills/intake-triage
```

- The folder name **must stay `intake-triage`** — it becomes the `/intake-triage` command.
- No restart needed; personal skills are picked up live. Verify: type `/` and look for
  `/intake-triage`, or run `/skills`.

## Run

| Command                                            | Does                                                                                                                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/intake-triage SSX-1234`                          | Full triage of one ticket — prints the PM report, RENDERS the Jira payload, then ASKS before posting: `[y] post · [n] skip · [e] edit the comment first` |
| `/intake-triage "<idea text>"`                     | Triage a raw idea before a ticket exists (never writes — no ticket)                                                                                      |
| `/intake-triage SSX-1234 --no-write`               | Pure preview — print the report + payload, never offer to write                                                                                          |
| `/intake-triage SSX-1234 --deep`                   | Append the techlead technical appendix                                                                                                                   |
| `/intake-triage --sweep "<JQL>"`                   | Batch mode — numbered manifest; pick `all` / `none` / `1,2,5`; paged, no hard cap (warns on large sets, optional `--limit N`)                            |
| `/intake-triage SSX-1234 --yes`                    | Automation only (cron/non-interactive) — skips the gate, still never transitions, still honours `--limit`                                                |
| `--vault <path>` · `--project <KEY>` · `--limit N` | Override vault location · scope the dedup search · bound a run                                                                                           |

## What you get back

A **scorecard** built to decide in seconds — verdict on line 1, then six fixed checks where
only the flagged rows carry text. Green = nothing to read; 🟡/🔴 = look here.

```markdown
# ✅ ACCEPT → queue · SSX-3533

**Evidence file upload: progress tracking + timeout fix** · Task · Received
route:ours · SSX · jira:SSX · (EDH) · related SSX-3791 (not dup) · DoR PASS · value H × effort S = quick win

| Check     |     | Answer (why only if flagged)                  |
| --------- | :-: | --------------------------------------------- |
| Ours?     | 🟢  | route:ours · SSX · jira:SSX · HIGH            |
| Raised?   | 🟡  | SSX-3791 in code review — same uploader files |
| Solved?   | 🟢  | No — client-side gap (endpoints exist)        |
| DoR?      | 🟢  | PASS · value/why-now? assignee?               |
| Build     | 🟡  | edh2-customer-web · blast LOW · shared util   |
| Component | 🟢  | EDH (from ssx_component) · set, validated     |

**→ Next:** Accept to queue · link SSX-3791 (relates-to) · optional `--deep`.
```

Banner tells you the call at a glance: `✅ ACCEPT` · `⛔ REJECT` · `↪ ROUTE` · `↩ SEND BACK`.

## When NOT to trust this → don't say `y`, take it to the Trio

The gate defaults to `n`. Say `n` and escalate when any of these show:

- **CONF L** on any gate — the signal is weak.
- **route:unknown** — the service could not be placed; do not hand off.
- **any REJECT / close-as-duplicate** — verify with `--deep`, then the Trio closes; the skill never closes a ticket.
- **a DoR-FAIL send-back** — the ticket is not ready; return it, don't post-and-forget.

When unsure, `n` costs nothing — the report still prints.

## Troubleshooting

| Symptom                                    | Fix                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| "I can't find insurance-knowledge-vault"   | Clone it to the default path, or pass `--vault <path>`                                           |
| Jira errors / permission prompts           | `/mcp` → **atlassian** → **Authenticate** (token may have expired)                               |
| `/intake-triage` missing from the `/` menu | Folder not in `~/.claude/skills/` or renamed — must be `~/.claude/skills/intake-triage/SKILL.md` |

## Distribution (current → planned)

- **Now:** copy or symlink the folder per machine (above).
- **Planned:** host the skill inside `insurance-knowledge-vault` (alongside `scan-repo` /
  `sync-openapi`) so a vault clone ships the skill to every developer and AI agent that specs
  Jiras. See the note in the project `README.md`.
