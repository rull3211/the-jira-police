#!/usr/bin/env bash
#
# PreToolUse guard for rules 1 and 2 of CLAUDE.md: the agent never writes on a
# protected branch or pushes to one, and never merges anything. Rule 3 (work in
# a worktree) has no mechanical enforcement; this guard only stays out of its way.
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

# The branch the *target file* is on, which is not always the branch above:
# rule 3 makes a worktree the ordinary place work happens, so the two routinely
# differ. Walks up to the nearest existing directory, since a `Write` creating
# a file names a path that does not.
targetBranch() {
  local path="$1" dir
  # A relative path has no worktree we can name: the tool's cwd is not in the
  # payload, so resolving it against `$repo` would be a guess. Refuse instead.
  case "$path" in
    /*) ;;
    *) return 1 ;;
  esac
  dir="$(dirname "$path")"
  while [ ! -d "$dir" ]; do
    case "$dir" in
      / | .) return 1 ;;
    esac
    dir="$(dirname "$dir")"
  done
  git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null
}

# `node` rather than `jq`: this project already requires Node, and jq is not a
# stated dependency. A parse failure yields an empty string and the guard falls
# through to the branch check, which is the safe direction.
#
# Two fields come back, path then command, because a command may contain
# newlines and a path may not — a newline in the path is flattened to a space,
# so it fails the absolute-path test below and fails closed.
parsed="$(
  printf '%s' "$payload" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const j = JSON.parse(s);
        const ti = j.tool_input || {};
        const p = String(ti.file_path || ti.notebook_path || "").replace(/[\r\n]/gu, " ");
        process.stdout.write(p + "\n" + String(ti.command || ""));
      } catch {
        process.stdout.write("\n");
      }
    });
  ' 2>/dev/null || true
)"
# Split on the *first* newline, and only if there is one: `$(...)` strips
# trailing newlines, so a path with no command arrives as a single line, and
# `${parsed#*$'\n'}` on a string with no newline returns it unchanged — reading
# the path as the command, which fails open on every write.
case "$parsed" in
  *$'\n'*)
    target_path="${parsed%%$'\n'*}"
    command_text="${parsed#*$'\n'}"
    ;;
  *)
    target_path="$parsed"
    command_text=""
    ;;
esac

# Precedence, not a second opinion: a file inside a worktree is judged against
# that worktree; anything less specific (a `Bash` call, an unresolvable path, no
# repository at all) falls back to the project directory.
#
# Ordering is load-bearing: this reads `target_path`, so it must sit below the
# parse — above it, `set -u` kills the script before any refusal prints, and a
# guard that prints nothing is read as "allow".
target_branch=""
if [ -n "$target_path" ]; then
  target_branch="$(targetBranch "$target_path" || true)"
fi
effective_branch="$branch"
if [ -n "$target_branch" ]; then
  effective_branch="$target_branch"
fi

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

# One list: a name refused by one hatch and accepted by another is the hole
# this guard exists to close.
isProtected() {
  case "$1" in
    main | master | develop | release/*) return 0 ;;
  esac
  return 1
}

# Every escape hatch is an allow carved into a deny, so width matters more than
# spelling: `-B`/`-C` *reset* an existing branch, so `checkout -B main` moves
# `main` from a standing start. `-b`/`-c` naming a protected branch are refused
# too, rather than relying on git to reject the name itself.
hatchNamesProtected() {
  local name

  set -f
  # shellcheck disable=SC2086
  set -- $1
  set +f

  while [ $# -gt 0 ]; do
    name=""
    case "$1" in
      -b | -B | -c | -C)
        shift
        [ $# -gt 0 ] || return 1
        name="$1"
        ;;
      -b?* | -B?* | -c?* | -C?*) name="${1#-?}" ;;
    esac
    isProtected "$name" && return 0
    shift
  done

  return 1
}

# `worktree add -b` is rule 3's remedy, so refusing it from a protected branch
# would trap the agent the way refusing `switch -c` does. Everything else the
# subcommand can do fails closed: `-B` resets an existing branch, `add` with no
# `-b` checks out one that may be protected, and an unrecognised option is
# treated as a write so a future flag is refused by default.
worktreeAddIsEscape() {
  local sawB=no name=""

  set -f
  # shellcheck disable=SC2086
  set -- $1
  set +f

  shift # `add`, matched by the caller

  while [ $# -gt 0 ]; do
    case "$1" in
      -b)
        shift
        [ $# -gt 0 ] || return 1
        name="$1"
        sawB=yes
        ;;
      -b?*)
        name="${1#-b}"
        sawB=yes
        ;;
      --reason)
        shift
        [ $# -gt 0 ] || return 1
        ;;
      -f | --force | -q | --quiet | --checkout | --no-checkout | --track | --no-track | \
        --guess-remote | --no-guess-remote | --relative-paths | --no-relative-paths) ;;
      -*) return 1 ;;
      *) ;;
    esac
    shift
  done

  [ "$sawB" = yes ] || return 1

  isProtected "$name" && return 1

  return 0
}

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
    switch) hatchNamesProtected "$rest" || return 1 ;;

    # `checkout` is two commands wearing one name: `-b` is the escape hatch in
    # the spelling most fingers already know, and everything else is the
    # destructive worktree write that `restore` was split out of.
    checkout)
      case " $rest " in
        *" -b "* | *" -B "*) hatchNamesProtected "$rest" || return 1 ;;
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
    worktree)
      case "$rest" in
        list*) return 1 ;;
        add | add\ *) worktreeAddIsEscape "$rest" && return 1 ;;
      esac
      ;;
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
  # into quoting that command-position analysis cannot parse.
  #
  # The terminator is load-bearing and was wrong. It read `([[:space:]]|$)`,
  # which stops `pull` swallowing `git pull-request` — the same class as the
  # bare `main` match that once refused `fix/domain` — but a quote is neither a
  # space nor end-of-string, so `bash -lc "git push"` did not match. The verb
  # sat flush against the closing quote, and that is the *only* shape the floor
  # exists to catch: command-position analysis sees `bash` and stops. The
  # command was allowed on `main`, which is rule 1 unguarded by both halves at
  # once.
  #
  # It had an assertion, and for the hundred minutes it existed — 4d5ef49 to
  # cbb5be0, one afternoon, not the four days cbb5be0's own message claims — it
  # passed on a defect in the test harness rather than on the guard:
  # `bash_payload` interpolated the command into JSON without escaping, so a
  # fixture containing a double quote produced a payload the hook could not
  # parse, and an unreadable command is treated as a write. The guard denied —
  # for the one reason the assertion was not testing. Found while writing
  # commit-brief.sh, the first hook here whose behaviour on an unparseable
  # payload differs from its behaviour on a command it does not care about.
  #
  # Now terminated by `[^[:alnum:]_-]`, so a quote, a full stop or a bracket
  # ends the verb while `pull-request` and `applypatch-msg` still do not match.
  # What that widens: the floor is a substring pass over the whole command text,
  # so prose ending "...then git push." now reads as a write. That is bounded —
  # the result is only ever consulted to refuse work on a protected branch,
  # where nearly everything is refused anyway, and the escape hatch verbs are
  # not on this list — and it is the fail-closed direction for the rule CLAUDE.md
  # says is not advisory.
  if printf '%s' "$command_text" | grep -Eq \
    'git[[:space:]]+(-[^[:space:]]+[[:space:]]+([^-][^[:space:]]*[[:space:]]+)?)*(commit|push|pull|merge|rebase|cherry-pick|revert|am|apply|reset|restore|rm|mv|stash[[:space:]]+(pop|apply|drop))([^[:alnum:]_-]|$)'; then
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

if [ "$mutates" = yes ] && isProtected "$effective_branch"; then
  # Two refusals because they are two different mistakes, and the remedy
  # differs: one is standing in the wrong place, the other is reaching into
  # it from a worktree that is perfectly fine.
  if [ -n "$target_branch" ] && [ "$target_branch" != "$branch" ]; then
    deny "This writes into a checkout that is on protected branch '$target_branch' ($target_path), even though this session's project directory is on '$branch'. The checkout the write lands in is the one that counts, not the one you are standing in. Write inside a worktree that is on an implementation branch instead. See CLAUDE.md."
  fi
  deny "On protected branch '$effective_branch', where this repository never accepts agent work. Cut a worktree and work there, which is rule 3: git worktree add -b fix/<slug> ../<dir> origin/main (or feat/, chore/, docs/, refactor/). To move this checkout instead: git switch -c fix/<slug>. Do not work around this guard — if branching is genuinely wrong here, ask. See CLAUDE.md."
fi

exit 0
