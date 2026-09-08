#!/usr/bin/env bash
#
# PreToolUse guard: the agent never writes on a protected branch, and never
# pushes to one.
#
# This exists because the rule it enforces is the one whose violation cannot be
# undone by the person who notices. Everything else in the house rules is a
# recoverable mistake; a commit on `main` is not, and neither is a push to it.
# So this fails closed (BUILDING.md, "fail closed") and denies rather than asks.
#
# Denial text is fed back to the model, so it is written to tell the agent what
# to do next rather than only what it may not do.

set -uo pipefail

repo="${CLAUDE_PROJECT_DIR:-$PWD}"
payload="$(cat 2>/dev/null || true)"

# The reason is interpolated into JSON, so it is escaped rather than trusted.
# This is not hypothetical tidiness: git permits `"` in a ref name, so a branch
# called `release/a"b` produced unparseable output and the runtime dropped the
# denial entirely. A guard that fails open on the name of the thing it is
# guarding against is worse than no guard, because it looks installed.
deny() {
  local reason="$1"
  reason="${reason//\\/\\\\}"
  reason="${reason//\"/\\\"}"
  reason="${reason//$'\n'/ }"
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$reason"
  exit 0
}

branch="$(git -C "$repo" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"

# `node` rather than `jq`: this project already requires Node, and jq is not a
# stated dependency. A parse failure yields an empty string and the guard falls
# through to the branch check, which is the safe direction.
command_text="$(
  printf '%s' "$payload" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const j = JSON.parse(s);
        process.stdout.write(String((j.tool_input && j.tool_input.command) || ""));
      } catch {
        process.stdout.write("");
      }
    });
  ' 2>/dev/null || true
)"

# A push naming a protected branch, from any branch. Word-boundaried on purpose:
# a bare substring match refuses `fix/domain`, which contains "main".
if printf '%s' "$command_text" | grep -q 'git[[:space:]]\{1,\}push'; then
  if printf '%s' "$command_text" | grep -Eq '(^|[[:space:]:/])(main|master|develop)([[:space:]]|$)'; then
    deny "This git push names a protected branch. A human merges in this repository and the bot has no merge path. Open a pull request instead."
  fi
fi

# Whether this call would change the repository. An Edit/Write/NotebookEdit
# carries no command and always would; a Bash call has to be read.
#
# The distinction is not fussiness. Refusing every Bash call on a protected
# branch refuses `git switch -c feat/x` as well — the one command that gets you
# out — so the guard would trap the agent on `main` and the only ways out would
# be working around it or asking a human to type it. A guard whose remedy its
# own denial text names must not itself block that remedy.
#
# The list is of commands that write, and it is deliberately not the complement
# of a read list: an unrecognised command is treated as a read and allowed. That
# is the fail-open direction, chosen here because Edit/Write/NotebookEdit is the
# path that actually matters and it is covered unconditionally, while the cost
# of the closed direction is the trap above.
mutates=yes
if [ -n "$command_text" ]; then
  mutates=no
  if printf '%s' "$command_text" | grep -Eq \
    'git[[:space:]]+(commit|merge|rebase|cherry-pick|revert|am|apply|reset|restore|rm|mv|stash[[:space:]]+(pop|apply|drop))'; then
    mutates=yes
  fi
fi

if [ "$mutates" = yes ]; then
  case "$branch" in
    main | master | develop | release/*)
      deny "On protected branch '$branch', where this repository never accepts agent work. Create an implementation branch and retry: git switch -c feat/<slug> (or fix/, chore/, docs/, refactor/). Do not work around this guard — if branching is genuinely wrong here, ask. See CLAUDE.md."
      ;;
  esac
fi

exit 0
