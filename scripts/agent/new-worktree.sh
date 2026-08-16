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

# One port pair per tree, so concurrent dev servers cannot reach each other's
# database.
#
# Deriving the pair from a count of existing trees is what this used to do, and it
# is wrong twice over. Removing a merged tree lowers the count, so the next tree
# created is handed the ports of a tree that is still running. And the arithmetic
# walks: at twenty-six trees, 5173 + 26 * 10 is 5433, which is the port
# docker-compose publishes Postgres on, so the web app was told it lived on the
# database. Ports are therefore claimed by looking at what is actually taken.
#
# Reserved: 80, 3001, 5174 and 5433 are published by docker-compose, and 5173 is
# vite's default in the main checkout.
RESERVED=' 80 3001 5173 5174 5433 '

# Ports written into any other tree's .env: the API port from PORT, and the web
# port from APP_URL. Both are needed. Reading only PORT leaves every tree
# believing no web port is taken, so they are all handed the same one.
#
# The last assignment of a key wins in this file, so read the last one rather than
# the first: an earlier line may be a stale value inherited from the tree the file
# was copied from.
claimed_ports() {
  local env
  for env in "$TREES"/*/apps/api/.env; do
    [ -f "$env" ] || continue
    sed -n 's/^PORT=\([0-9]\{1,\}\).*/\1/p' "$env" | tail -n 1
    sed -n 's|^APP_URL=http://localhost:\([0-9]\{1,\}\).*|\1|p' "$env" | tail -n 1
  done
}

port_is_free() {
  local port="$1"
  case "$RESERVED" in *" $port "*) return 1 ;; esac
  printf '%s\n' "$CLAIMED" | grep -qx "$port" && return 1
  # A listener means something is using it now even if no .env admits to it.
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && return 1
  fi
  return 0
}

CLAIMED="$(claimed_ports)"

API_PORT=''
for candidate in $(seq 3011 10 3491); do
  if port_is_free "$candidate"; then
    API_PORT="$candidate"
    break
  fi
done
[ -n "$API_PORT" ] || die 'no free API port between 3011 and 3491; prune merged worktrees'

WEB_PORT=''
for candidate in $(seq 5183 10 5423); do
  if port_is_free "$candidate"; then
    WEB_PORT="$candidate"
    break
  fi
done
[ -n "$WEB_PORT" ] || die 'no free web port between 5183 and 5423; prune merged worktrees'

if [ -f "$ROOT/apps/api/.env" ]; then
  cp "$ROOT/apps/api/.env" "$DEST/apps/api/.env"
  echo "==> Copied apps/api/.env from the current tree"
elif [ -f "$DEST/apps/api/.env.example" ]; then
  cp "$DEST/apps/api/.env.example" "$DEST/apps/api/.env"
  echo "==> Seeded apps/api/.env from .env.example (fill in the secrets)"
fi

if [ -f "$DEST/apps/api/.env" ]; then
  # Strip the three keys before writing them, rather than appending and trusting
  # last-one-wins. A file carrying PORT twice is read differently by dotenv, by
  # `set -a; . .env`, and by anything parsing it with grep, and the tree that
  # copied it inherits whichever the reader happens to prefer.
  ENV_FILE="$DEST/apps/api/.env"
  grep -v -E '^[[:space:]]*(PORT|API_URL|APP_URL)=' "$ENV_FILE" >"$ENV_FILE.tmp" || true
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  {
    echo ""
    echo "# --- set by scripts/agent/new-worktree.sh for worktree '$SLUG' ---"
    echo "PORT=$API_PORT"
    echo "API_URL=http://localhost:$API_PORT"
    echo "APP_URL=http://localhost:$WEB_PORT"
  } >>"$ENV_FILE"
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
