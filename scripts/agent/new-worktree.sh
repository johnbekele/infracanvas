#!/usr/bin/env bash
#
# Create an isolated worktree for one agent working one issue.
#
# Parallel agents need filesystem isolation, and a worktree gives it: its own
# working directory, its own index, its own node_modules, sharing one .git object
# store. What a worktree does not give is runtime isolation, so this script also
# allocates a distinct API port per tree. Two agents running `pnpm dev` on the
# same port do not fail loudly; the second one silently talks to the first one's
# database, which is a far worse afternoon than a port collision.
#
# Trees live in a sibling directory rather than under the repository root. A tree
# nested inside the repo shows up as hundreds of untracked files, nested .git and
# all, and one `git add -A` commits a whole second checkout into the first.
#
# Usage:
#   scripts/agent/new-worktree.sh <slug> [branch]
#
#   slug    short directory name, e.g. tenancy
#   branch  full branch name, e.g. feat/190-organizations-and-workspaces
#           defaults to agent/<slug>
#
set -euo pipefail

EXPECTED_EMAIL='164889902+johnbekele@users.noreply.github.com'

die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

[ $# -ge 1 ] || die "usage: scripts/agent/new-worktree.sh <slug> [branch]"

SLUG="$1"
BRANCH="${2:-agent/$SLUG}"

case "$SLUG" in
  */* | '' | .*) die "slug must be a plain directory name, got '$SLUG'" ;;
esac

ROOT="$(git rev-parse --show-toplevel)" || die 'not inside a git repository'
# --show-toplevel inside a linked worktree returns that worktree, not the main
# checkout, so nesting a tree inside a tree would otherwise be possible.
COMMON="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
TREES="$(dirname "$COMMON")/$(basename "$COMMON")-wt"
DEST="$TREES/$SLUG"

[ -e "$DEST" ] && die "$DEST already exists"

if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  die "branch $BRANCH already exists; pick another name or reuse its worktree"
fi

echo "==> Fetching origin"
git -C "$COMMON" fetch origin --quiet

mkdir -p "$TREES"

echo "==> Creating worktree $DEST on $BRANCH (from origin/main)"
git -C "$COMMON" worktree add -b "$BRANCH" "$DEST" origin/main

# Worktrees share the repository's local config, so this should already be
# right. It is checked anyway because a commit authored with the work address
# attributes personal work to an employer, and that is not fixable after a merge.
ACTUAL_EMAIL="$(git -C "$DEST" config --get user.email || true)"
if [ "$ACTUAL_EMAIL" != "$EXPECTED_EMAIL" ]; then
  echo "==> Correcting commit identity (was '${ACTUAL_EMAIL:-unset}')"
  git -C "$DEST" config user.name 'John Bekele'
  git -C "$DEST" config user.email "$EXPECTED_EMAIL"
fi

# One port block per tree, so concurrent dev servers cannot reach each other's
# database.
#
# The port is claimed by reading what the other trees already wrote, not by
# counting trees. A count shrinks when a tree is removed, so the next tree would
# be handed a port a live tree is already using — and a duplicate here is the
# silent failure this whole scheme exists to prevent.
claimed_ports() {
  git -C "$COMMON" worktree list --porcelain | sed -n 's/^worktree //p' | while read -r tree; do
    [ -f "$tree/apps/api/.env" ] || continue
    sed -n 's/^PORT=\([0-9][0-9]*\).*/\1/p' "$tree/apps/api/.env"
  done
}

CLAIMED="$(claimed_ports | sort -u)"
# Starts at 3011 rather than 3001: the primary checkout uses the 3001 default
# without necessarily recording it anywhere.
API_PORT=3011
while :; do
  if printf '%s\n' "$CLAIMED" | grep -qx "$API_PORT"; then
    API_PORT=$((API_PORT + 10))
    continue
  fi
  if command -v lsof >/dev/null 2>&1 && lsof -iTCP:"$API_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    API_PORT=$((API_PORT + 10))
    continue
  fi
  break
done
WEB_PORT=$((5173 + API_PORT - 3001))

if [ -f "$ROOT/apps/api/.env" ]; then
  cp "$ROOT/apps/api/.env" "$DEST/apps/api/.env"
  echo "==> Copied apps/api/.env from the current tree"
elif [ -f "$DEST/apps/api/.env.example" ]; then
  cp "$DEST/apps/api/.env.example" "$DEST/apps/api/.env"
  echo "==> Seeded apps/api/.env from .env.example (fill in the secrets)"
fi

if [ -f "$DEST/apps/api/.env" ]; then
  # Drop the inherited definitions before appending. Two PORT= lines in one file
  # leaves the effective value up to whether the loader takes the first or the
  # last, which is not something a per-worktree port should depend on.
  grep -vE '^[[:space:]]*(PORT|API_URL|APP_URL)=' "$DEST/apps/api/.env" \
    >"$DEST/apps/api/.env.new" || true
  mv "$DEST/apps/api/.env.new" "$DEST/apps/api/.env"
  {
    echo ""
    echo "# --- set by scripts/agent/new-worktree.sh for worktree '$SLUG' ---"
    echo "PORT=$API_PORT"
    echo "API_URL=http://localhost:$API_PORT"
    echo "APP_URL=http://localhost:$WEB_PORT"
  } >>"$DEST/apps/api/.env"
fi

echo "==> Installing dependencies (each worktree has its own node_modules)"
(cd "$DEST" && pnpm install)

cat <<EOF

Worktree ready.

  path    $DEST
  branch  $BRANCH
  api     http://localhost:$API_PORT
  web     http://localhost:$WEB_PORT  (vite picks the next free port itself)

Next:

  cd $DEST
  gh issue edit <N> --add-label status:in-progress --add-assignee johnbekele
  pnpm verify --fast

Caveat: apps/web/vite.config.ts hardcodes its proxy target to localhost:3001, so
a dev server in this tree still calls the API on 3001 rather than $API_PORT. Run
only one web dev server at a time, or make that target read an env var first.
See docs/ORCHESTRATION.md.

When the pull request has merged:

  git -C "$COMMON" worktree remove $DEST
  git -C "$COMMON" worktree prune
EOF
