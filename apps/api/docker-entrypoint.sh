#!/bin/sh
set -e

echo "Installing dependencies..."
pnpm install --frozen-lockfile

echo "Starting API server..."
exec pnpm --filter @infracanvas/api dev
