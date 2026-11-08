#!/usr/bin/env bash
# Usage: ./switch.sh GK|G|A   — restart the single tournament bot with that variant (only between matches!)
cd "$(dirname "$0")"
case "$1" in
  GK) P='{"earlyCap":60,"earlyShade":1,"maxFrac":0.3,"lamMult":1.0,"holdMargin":4,"kBudget":0.8}' ;;
  G)  P='{"earlyCap":60,"earlyShade":1,"maxFrac":0.3,"lamMult":1.0,"holdMargin":4,"lateLeft":0}' ;;
  A)  P='{"lateLeft":0}' ;;
  *) echo "usage: $0 GK|G|A"; exit 1 ;;
esac
for pid in $(ps -ef | grep -iE "ltt2|ladder_then|run.sh|tsx src/index" | grep -v grep | awk '{print $2}'); do kill $pid 2>/dev/null; done
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Where-Object { \$_.CommandLine -match 'src.index\.ts' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }"
sleep 2
export BOT_NAME=scrbbel NO_LADDER=1 PARAMS_JSON="$P"
echo "starting variant $1: $P"
nohup ./run.sh > tourney.out 2>&1 &
