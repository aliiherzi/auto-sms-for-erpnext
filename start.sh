#!/bin/sh
# Auto SMS for ERPNext - run it on this Mac or Linux computer (for testing).
# In Terminal: sh start.sh   (keep the window open while you test; Ctrl+C stops it)
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "Node.js is not installed."
  echo "Download the LTS version from https://nodejs.org , install it, then run: sh start.sh"
  echo
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing for the first time - this takes 2 to 3 minutes..."
  npm ci || { echo "Installation failed. Check your internet connection and try again."; exit 1; }
fi

node scripts/setup-env.mjs
OPEN_BROWSER=1 AUTO_PORT=1 exec npm run dev
