#!/usr/bin/env bash
#
# PreToolUse: puts the four questions in front of the model at the moment a
# commit is about to happen. It prints. It never refuses and never prompts.
#
# Why this event and not another. CLAUDE.md has said for some time that the four
# questions are "the part of the contract with no command behind them — nothing
# else will ever notice them being skipped", and that the fix is to "trigger it
# off the commit rather than off a compaction — a commit is a moment you can
# observe, a compaction is not". session-brief.sh covers the compaction, which
# is the wrong moment and was chosen because it was the only event available.
# This is the right one.
#
# Why it prints rather than denies. There is no mechanical test for "did you
# actually ask yourself these", so a refusal would be a guard that cannot tell
# a satisfied condition from an unsatisfied one — it would either block every
# commit or be dismissed by rote. BUILDING.md's "except guards" carve-out is for
# guards that fail open; this one does not even fail, it only speaks.
#
# The transport is `hookSpecificOutput.additionalContext` with exit 0 and **no**
# `permissionDecision` field, which is the documented way to hand text to the
# model while leaving the permission flow untouched. Two honest caveats:
#
#   - Like every other hook here, the suite proves this script *emits* the right
#     thing. It cannot prove the runtime *acts* on it. `deny` on this transport
#     has been watched being honoured; `ask` has never been (PLAN.md §17), and
#     `additionalContext` has not either. The difference is that nothing is at
#     stake if this one is decorative: the failure mode is the status quo.
#   - It has to be registered to fire at all, and the file that registers it is
#     one this agent is refused write access to, in the editor and in the shell.
#     So a wiring snippet is proposed to the operator and the operator applies
#     it. Read ARCHITECTURE.md §16 before assuming either way.
#
# Run it by hand with `pnpm hooks:commit-brief`.

set -uo pipefail

repo="${CLAUDE_PROJECT_DIR:-$PWD}"

# Bounded and conditional for the same reason session-brief.sh's read is: this
# script is also invoked by test-hooks.sh and by hand, and an unconditional
# `cat` on a terminal turns a diagnostic into a hang. `[ ! -t 0 ]` alone was not
# enough there — a pipe that is open but never written is not a tty — so the
# read has a timeout, and expiry is not an error.
payload=""
if [ ! -t 0 ]; then
  IFS= read -r -d '' -t 1 payload || true
fi

# No payload means somebody ran it directly to see what it says. Print rather
# than exit: a hook you cannot inspect is a hook nobody checks.
#
# A payload that does not parse is a third case, and it is kept separate from
# "parsed, but no command in it" on purpose. The second is ordinary — a
# PreToolUse payload for any tool that is not Bash has no command — and the
# right answer there is silence. The first means this hook no longer understands
# what the runtime sends it, and the right answer is to say so on every call
# until somebody fixes it. Collapsing the two, which is what the first version
# did, buys quiet at the price of the exact failure this whole branch was opened
# about: a hook that has stopped working and looks identical to one that had
# nothing to say. Printing cannot break anything here; going quiet can.
#
# `PARSE_ERROR` is a sentinel rather than an empty string because an empty
# string is what the ordinary case produces, and telling them apart is the whole
# point. It cannot collide with a real command: the gate below only ever fires
# on a string containing `git ... commit`.
command_text=""
if [ -n "$payload" ]; then
  command_text="$(
    printf '%s' "$payload" | node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        try {
          const j = JSON.parse(s);
          process.stdout.write(String((j.tool_input && j.tool_input.command) || ""));
        } catch {
          process.stdout.write("PARSE_ERROR");
        }
      });
    ' 2>/dev/null || printf 'PARSE_ERROR'
  )"

  # Anchored to command position, not grepped out of the whole string. That is
  # branch-guard.sh's rule for `gh pr merge` — "the difference between guarding
  # the act and censoring the words" — and the reason to follow it here is
  # sharper than it is there: this hook fires on commits, and a commit message
  # is the one place in this repository where the words "git commit" turn up in
  # prose constantly. An unanchored match would fire on `git log --grep 'git
  # commit'` and on every message that quotes a command, which is the shape that
  # trains a reader to skip the brief.
  #
  # Between `git` and `commit` the pattern allows git's own pre-subcommand
  # options, each optionally taking a separate argument: `git -C path commit`
  # and `git -c user.name=x commit` are commits, and the solver works in
  # isolated worktrees so `-C` is the form it would actually use. Every such
  # group must **begin with a dash**, which is what keeps this anchored rather
  # than merely prefixed — `git log --grep git commit` has a bare `log` first,
  # so it does not match. That case is the whole reason the rule is "starts with
  # a dash" and not "is not whitespace"; the looser version passed every
  # positive case and fired on a search for the word.
  if [ "$command_text" != "PARSE_ERROR" ] && ! printf '%s' "$command_text" | grep -Eq \
    '(^|[;&|(]|&&|\|\|)[[:space:]]*git[[:space:]]+(-[-[:alnum:]]+[[:space:]]+([-[:alnum:]_.,=/@:+]+[[:space:]]+)?){0,3}commit([[:space:]]|$)'; then
    exit 0
  fi
fi

# EXTRACTED from FINISHING.md, never copied into this file. Copying would make
# a fact with two homes and one maintainer, which is the rule STARTING.md states
# — and the questions are already copied once, into CLAUDE.md, under an
# exemption that exists only because `pnpm docs:check` fails when that copy
# drifts. Nothing would check a third copy sitting in a shell script.
#
# The awk is session-brief.sh's, because it is the same extraction from the same
# headings and two implementations of one extraction is the drift lib.sh's
# header warns about. It is not shared code yet: lib.sh holds measurement, not
# text extraction, and one more caller is the point at which that would be worth
# moving rather than the point at which it already was.
checklist="$(awk '/^## The checklist/{f=1;next} f&&/^\*\*And the rules/{exit}
                  f&&/^- \[ \]/{p=1} f&&p&&/^$/{p=0} f&&p{print}' \
  "$repo/.claude/skills/dev-house-rules/FINISHING.md" 2>/dev/null || true)"

branch="$(git -C "$repo" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"

# When the extraction finds nothing the hook says so, loudly, instead of going
# quiet. session-brief.sh's equivalent prints nothing and relies on test-hooks.sh
# noticing, which makes a renamed heading invisible until somebody runs the
# suite. Here the degraded case is a message a human reads at the moment they
# would have read the questions, which is the only moment it helps.
if [ -z "$checklist" ]; then
  brief="A commit is about to happen, and this hook could not read the four questions out of
.claude/skills/dev-house-rules/FINISHING.md — the '## The checklist' heading has moved
or been renamed. Go and read them there. Then fix commit-brief.sh's extraction, because
right now it is a reminder that has stopped reminding."
else
  brief="A commit is about to happen on '$branch'. These four have no command behind them, so
nothing except this text will notice them being skipped. From FINISHING.md, 'The
checklist' — read them there rather than working from this copy:

$checklist

The fourth one is the one that goes in silence, so its answer belongs in the pull
request body as a 'Rules owed:' line either way — including 'Rules owed: none', which
is a claim somebody can disagree with, where saying nothing is not."
fi

# Prepended rather than substituted, so the questions still arrive while the
# hook is complaining. This line appearing on calls that are not commits is the
# symptom, and it is meant to be annoying enough to get fixed.
if [ "$command_text" = "PARSE_ERROR" ]; then
  brief="commit-brief.sh could not parse the hook payload, so it cannot tell whether this
call is a commit and is printing regardless. If you are seeing this on ordinary
commands, the payload shape has changed and this hook needs updating — it is not
supposed to speak except at a commit.

$brief"
fi

# JSON is built by node rather than by hand-escaping, unlike branch-guard.sh.
# That is a deliberate difference and not drift: branch-guard.sh escapes a short
# single-line reason inline because its output is a *refusal*, and a refusal
# that fails to serialise fails open — a guard that looks installed and is not,
# which is the defect lib.sh's jsonEscape was written for. This text is multi
# line, quotes things, and carries em dashes and bracketed links, so hand
# escaping it is the same bug waiting to happen; and if serialisation fails here
# the only casualty is a reminder. Fail-soft output gets the convenient encoder,
# fail-open output does not.
printf '%s' "$brief" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: s,
        },
      }) + "\n",
    );
  });
' 2>/dev/null || true

exit 0
