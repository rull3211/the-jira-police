#!/usr/bin/env bash
#
# PreToolUse guard for both of CLAUDE.md's non-advisory rules: the agent never
# writes on a protected branch or pushes to one, and never merges anything.
#
# This exists because the rules it enforces are the ones whose violation cannot
# be undone by the person who notices. Everything else in the house rules is a
# recoverable mistake; a commit on `main` is not, a push to it is not, and a
# merged pull request is not. So this fails closed (BUILDING.md, "fail closed")
# and denies rather than asks.
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

# Rule 2, and it is not a question about which branch you are standing on: this
# repository has no merge path and neither does the agent. Checked before the
# branch logic for exactly that reason.
#
# The refusal can be flat because nothing legitimate here resembles it. `gh pr
# view`, `create`, `checks`, `diff`, `ready`, `comment` and every read are
# untouched; only the merge verb goes.
#
# Anchored to command position rather than matched anywhere in the text, which
# is the difference between guarding the act and censoring the words. Prose
# discusses `gh pr merge` constantly — PLAN.md does, commit messages in this
# repository do — and a guard that refused to let you write about itself would
# be turned off within the day.
#
# `gh api` is matched separately because the same act has a second spelling: a
# request to a pull request's merge endpoint. Matching the `/merge` path segment
# rather than the word keeps `--jq .mergeable` and `mergeStateStatus` readable.
gh_at_command_position='(^|[;&|(]|&&|\|\|)[[:space:]]*gh[[:space:]]+'
if printf '%s' "$command_text" | grep -Eq \
  "${gh_at_command_position}(-[^[:space:]]+[[:space:]]+([^-][^[:space:]]*[[:space:]]+)?)*pr[[:space:]]+merge([[:space:]]|$)"; then
  deny "A human merges in this repository, always — rule 2 of CLAUDE.md. This service has no merge path and neither do you, so 'gh pr merge' is refused from every branch. Your side of the work ends with the pull request open and the review answered; hand it over. If you believe it must land now, say so and ask rather than looking for another route."
fi
if printf '%s' "$command_text" | grep -Eq "${gh_at_command_position}api[^;&|]*/merge([^[:alnum:]]|$)"; then
  deny "This calls a pull request's merge endpoint directly, which is rule 2 of CLAUDE.md by another spelling: a human merges, always. Open or update the pull request and hand it over instead."
fi

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
# For `git`, this is an allowlist of reads and everything else is a write. For
# every other program it is still fail-open: an unrecognised command is treated
# as a read and allowed, because Edit/Write/NotebookEdit is the path that
# actually matters and is covered unconditionally, while the cost of closing the
# whole surface is the trap above.
#
# The inversion is scoped to git deliberately, and it replaced a denylist. That
# denylist named thirteen verbs. Every subcommand git knows about — 163 of them,
# from `git --list-cmds=main,others,nohelpers` — was fed to this script with
# HEAD on a protected branch, and 150 came back allowed, among them:
#
#   checkout      the older spelling of `restore`, which the list refused
#   stash         bare, while `stash pop`/`apply`/`drop` were refused
#   clean         deletes untracked files
#   branch -f     moves a ref, the protected one included
#   update-ref    the same, with no porcelain involved
#   send-pack     `push` under another name; so is http-push
#   fetch a b:c   the refspec form writes a *local* branch
#   subtree pull  a pull the list did not recognise; likewise subtree merge
#
# So `pull` going missing was a symptom. A denylist over a program with 163
# subcommands and several spellings per act is behind by construction, and a
# verb git adds next year would be allowed on the day it ships. Inverted, an
# unrecognised verb is refused and the failure is a human adding one line.
#
# Two earlier fixes are kept because the inversion does not subsume them:
#
#   `git -C . commit`, `git --no-pager commit` and `git -c user.name=x commit`
#   were all allowed, because the subcommand had to sit immediately after `git`.
#   The run of global options is consumed first, and the four that take a
#   separate value consume it. The cost is a false positive on
#   `git -C /some/other/repo commit`, refused while HEAD here is protected; that
#   is the fail-closed direction and the remedy — branch — is cheap.
#
#   `push` names nothing when bare and still goes to `main` via its upstream, so
#   it cannot be caught by the protected-name check above. It is simply not a
#   read, so the inversion covers it; off a protected branch it is untouched.
#
# The substring pass is kept as a floor rather than replaced, and that is the
# one non-obvious decision here. Command-position analysis cannot see inside
# `sh -c '...'`, so dropping it would have opened a hole while closing thirty.
# The two are a union: either one is enough to call the command a write.
gitSegmentWrites() {
  local verb rest

  # Word-split the segment. Globbing is off around it so that a `*` in a
  # pathspec is not expanded against the working directory mid-guard.
  set -f
  # shellcheck disable=SC2086
  set -- $1
  set +f

  # Leading VAR=value assignments, then an `env` or `command` wrapper.
  while [ $# -gt 0 ]; do
    case "$1" in
      [A-Za-z_]*=* | env | command) shift ;;
      *) break ;;
    esac
  done
  [ $# -gt 0 ] || return 1

  # An absolute path to git counts; anything else is not our business.
  case "${1##*/}" in
    git) shift ;;
    *) return 1 ;;
  esac

  while [ $# -gt 0 ]; do
    case "$1" in
      -C | -c | --git-dir | --work-tree | --namespace | --exec-path)
        shift
        [ $# -gt 0 ] && shift
        ;;
      -*) shift ;;
      *) break ;;
    esac
  done

  # A bare `git`, or git with only options, prints usage and writes nothing.
  [ $# -gt 0 ] || return 1
  verb="$1"
  shift
  rest="$*"

  case "$verb" in
    # Reads, unconditionally. Anything not here is a write by default, which is
    # the whole point of the inversion.
    status | log | diff | show | grep | blame | annotate | describe | shortlog | whatchanged | \
      rev-parse | rev-list | merge-base | merge-tree | patch-id | name-rev | cherry | \
      for-each-ref | for-each-repo | show-ref | show-branch | show-index | \
      ls-files | ls-tree | ls-remote | cat-file | \
      diff-tree | diff-index | diff-files | diff-pairs | \
      format-patch | range-diff | request-pull | difftool | \
      check-ignore | check-attr | check-ref-format | check-mailmap | \
      count-objects | fsck | fsck-objects | verify-commit | verify-tag | verify-pack | \
      var | version | help | bugreport | diagnose | archive | bundle | get-tar-commit-id | \
      interpret-trailers | stripspace | column)
      return 1
      ;;

    # The escape hatch, and it is why this guard can be inverted at all. The
    # denial text tells the agent to run `git switch -c`, and a guard that
    # refuses the remedy it names traps the agent on the protected branch with
    # no way off it but working around the guard or asking a human to type.
    switch) return 1 ;;

    # `checkout` is two commands wearing one name: `-b` is the escape hatch in
    # the spelling most fingers already know, and everything else is the
    # destructive worktree write that `restore` was split out of.
    checkout)
      case " $rest " in
        *" -b "* | *" -B "*) return 1 ;;
      esac
      ;;

    # Listing branches is the common read; `-d`, `-f` and `-m` are not, and one
    # of them can move the protected ref. Creating a branch stays allowed: it is
    # the escape hatch again, by its third spelling.
    branch)
      printf '%s' "$rest" | grep -Eq \
        '(^|[[:space:]])(-[dDfmMcCu]|--delete|--force|--move|--copy|--set-upstream-to|--unset-upstream|--edit-description)([[:space:]]|=|$)' ||
        return 1
      ;;

    stash) case "$rest" in list* | show*) return 1 ;; esac ;;
    reflog) case "$rest" in "" | show*) return 1 ;; esac ;;
    tag) case "$rest" in "" | -l* | --list* | -n*) return 1 ;; esac ;;
    worktree) case "$rest" in list*) return 1 ;; esac ;;
    notes) case "$rest" in list* | show*) return 1 ;; esac ;;
    submodule) case "$rest" in status* | summary* | foreach*) return 1 ;; esac ;;
    bisect) case "$rest" in log* | view* | visualize*) return 1 ;; esac ;;
    sparse-checkout) case "$rest" in list*) return 1 ;; esac ;;
    remote) case "$rest" in "" | -v* | --verbose* | show* | get-url*) return 1 ;; esac ;;

    config)
      printf '%s' "$rest" | grep -Eq \
        '(^|[[:space:]])(-l|--list|--get|--get-all|--get-regexp|--get-urlmatch|get|list)([[:space:]]|=|$)' &&
        return 1
      ;;

    # Fetching updates remote-tracking refs, which is not rule 1. A refspec with
    # a colon updates a *local* branch, which is. The known over-refusal is a
    # URL carrying a port, which is rare enough to accept and cheap to work
    # around by branching.
    fetch) case "$rest" in *:*) ;; *) return 1 ;; esac ;;
  esac

  return 0
}

mutates=yes
if [ -n "$command_text" ]; then
  mutates=no

  # The floor: the original substring list, which sees into `sh -c '...'` and
  # into quoting that command-position analysis cannot parse. Each entry is
  # terminated by `([[:space:]]|$)`, which is load-bearing rather than tidiness:
  # without it `pull` matches `git pull-request`, the same way a bare substring
  # match on `main` once refused `fix/domain`.
  if printf '%s' "$command_text" | grep -Eq \
    'git[[:space:]]+(-[^[:space:]]+[[:space:]]+([^-][^[:space:]]*[[:space:]]+)?)*(commit|push|pull|merge|rebase|cherry-pick|revert|am|apply|reset|restore|rm|mv|stash[[:space:]]+(pop|apply|drop))([[:space:]]|$)'; then
    mutates=yes
  fi

  # The inversion, over each simple command separately, so that the second half
  # of `pnpm test && git commit` is examined on its own terms.
  if [ "$mutates" = no ]; then
    while IFS= read -r segment; do
      if gitSegmentWrites "$segment"; then
        mutates=yes
        break
      fi
    done <<EOF
$(printf '%s' "$command_text" | tr ';&|()' '\n\n\n\n\n')
EOF
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
