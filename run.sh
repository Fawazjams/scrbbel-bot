#!/usr/bin/env bash
# Keeps the bot running; restarts on disconnect/crash.
cd "$(dirname "$0")"
export BOT_NAME=${BOT_NAME:-scrbbel}
while true; do
  npx tsx src/index.ts
  echo "bot exited ($?), restarting in 2s"; sleep 2
done
