#!/bin/bash
# Opportunity Explorer — double-click to launch.
# Starts the local server and opens the app in your browser.
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-4317}"

# Open the browser shortly after the server comes up.
( sleep 1.2; open "http://localhost:${PORT}" ) &

echo "Starting Opportunity Explorer on http://localhost:${PORT}"
echo "(Close this window or press Ctrl-C to stop.)"
# --no-warnings keeps the node:sqlite experimental notice out of the console.
exec node --no-warnings server.mjs
