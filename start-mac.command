#!/bin/sh
# SynthStack launcher (macOS). Builds if needed, serves, opens browser.
# First run: right-click -> Open (Gatekeeper).
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required but was not found on PATH."
  read -r _
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install --no-fund --no-audit || exit 1
fi
if [ ! -d dist ]; then
  echo "Building..."
  npm run build || exit 1
fi
(sleep 2 && open "http://localhost:4173/") &
npm run preview
