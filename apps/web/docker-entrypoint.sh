#!/bin/sh
set -e

echo "Installing dependencies..."
pnpm install --frozen-lockfile

echo "Building @infracanvas/core..."
pnpm --filter @infracanvas/core build

echo "Starting web dev server..."
exec pnpm --filter @infracanvas/web dev --host 0.0.0.0
