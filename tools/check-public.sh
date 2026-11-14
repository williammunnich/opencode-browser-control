#!/bin/bash
# @file check-public.sh
# Run before pushing to a public place: fails if anything git would publish looks private.
#   1. key and token shapes, and files that should never be committed (keys, .env files)
#   2. your own strings, one regular expression per line in .private-patterns at the top of
#      the repository (ignored by git, so the list itself stays private). Lines starting with
#      # and empty lines are skipped. Without that file this part is skipped.
#   3. every commit's author and committer address, and the commit messages, since those are
#      public too. --files-only leaves this part out (for a repository whose history is about
#      to be replaced by a fresh one).
# It reads only; nothing is changed.
#
# @project opencode-browser-control
# @usage bash tools/check-public.sh [--files-only]
# @exit 0 when nothing private was found; 1 otherwise, after printing what was found;
#       64 unknown option
# @author Claude (Anthropic), written for and prompted by William Munnich
# @date Last edited 2026-11-14
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
history=1
for arg in "$@"; do
  case "$arg" in
    --files-only) history=0 ;;
    *) echo "unknown option: $arg (usage: bash tools/check-public.sh [--files-only])"; exit 64 ;;
  esac
done
fail=0
# Everything git tracks or would add (ignored files are left out). This script is left out
# because it has to spell the shapes it looks for.
files=$( { git ls-files; git ls-files --others --exclude-standard; } | sort -u | grep -v '^tools/check-public.sh$')

# 1. Shapes of keys: private key blocks, AWS, Stripe, GitHub, Slack, Google OAuth, AWS resource names with an account id.
shapes='-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|sk_(live|test)_[0-9a-zA-Z]{16,}|gh[pousr]_[A-Za-z0-9]{30,}|xox[baprs]-[0-9A-Za-z-]{10,}|GOCSPX-[A-Za-z0-9_-]{20,}|[0-9]+-[a-z0-9]{32}\.apps\.googleusercontent\.com|arn:aws:[a-z0-9-]+:[a-z0-9-]*:[0-9]{12}:'
hits=$(echo "$files" | tr '\n' '\0' | xargs -0 grep -InE -e "$shapes" 2>/dev/null)
if [ -n "$hits" ]; then echo "Looks like a secret:"; echo "$hits" | cut -c1-120; fail=1; fi

bad=$(echo "$files" | grep -E '(^|/)(\.env(\..*)?|\.private-patterns)$|\.(p8|pem|crx)$')
if [ -n "$bad" ]; then echo "These files must not be public:"; echo "$bad"; fail=1; fi

# 2. Your own private strings, in the files and (unless --files-only) in the commits.
if [ -f .private-patterns ]; then
  while IFS= read -r p; do
    [ -z "$p" ] && continue; case "$p" in \#*) continue ;; esac
    hits=$(echo "$files" | tr '\n' '\0' | xargs -0 grep -InEi -e "$p" 2>/dev/null)
    if [ -n "$hits" ]; then echo "Private string ($p):"; echo "$hits" | cut -c1-120; fail=1; fi
    if [ $history = 1 ] && git rev-parse -q --verify HEAD >/dev/null && git log --all --format='%an %ae %cn %ce %B' | grep -qEi -e "$p"; then
      case "$p" in *noreply*) ;; *) echo "Private string in commit metadata: $p"; fail=1 ;; esac
    fi
  done < .private-patterns
fi

# 3. Commit addresses: only "noreply" addresses should be published.
if [ $history = 1 ] && git rev-parse -q --verify HEAD >/dev/null; then
  mails=$(git log --all --format='%ae%n%ce' | sort -u | grep -v 'noreply' || true)
  if [ -n "$mails" ]; then echo "Commit addresses that aren't noreply:"; echo "$mails"; fail=1; fi
fi

[ $fail = 0 ] && echo "public check passed ($(echo "$files" | wc -l | tr -d ' ') files$([ $history = 0 ] && echo ", files only: commits not checked"))"
exit $fail
