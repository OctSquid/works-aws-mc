#!/usr/bin/env bash
# Paper サーバーを Aikar's flags (https://docs.papermc.io/paper/aikars-flags/) で起動する。
# ヒープサイズは server.json 由来の manifest.json (jvm.heap_mb) から取得。
set -euo pipefail

DIST="${DIST:-/opt/minecraft-dist}"
DATA="${DATA:-/srv/minecraft}"

# ローカル (Docker) ではメモリが小さいことがあるため HEAP_MB_OVERRIDE で上書き可能
HEAP_MB="${HEAP_MB_OVERRIDE:-$(jq -r '.jvm.heap_mb' "$DIST/manifest.json")}"

cd "$DATA"
exec java \
  -Xms"${HEAP_MB}"M -Xmx"${HEAP_MB}"M \
  -XX:+UseG1GC \
  -XX:+ParallelRefProcEnabled \
  -XX:MaxGCPauseMillis=200 \
  -XX:+UnlockExperimentalVMOptions \
  -XX:+DisableExplicitGC \
  -XX:+AlwaysPreTouch \
  -XX:G1NewSizePercent=30 \
  -XX:G1MaxNewSizePercent=40 \
  -XX:G1HeapRegionSize=8M \
  -XX:G1ReservePercent=20 \
  -XX:G1HeapWastePercent=5 \
  -XX:G1MixedGCCountTarget=4 \
  -XX:InitiatingHeapOccupancyPercent=15 \
  -XX:G1MixedGCLiveThresholdPercent=90 \
  -XX:G1RSetUpdatingPauseTimePercent=5 \
  -XX:SurvivorRatio=32 \
  -XX:+PerfDisableSharedMem \
  -XX:MaxTenuringThreshold=1 \
  -Dusing.aikars.flags=https://mcflags.emc.gs \
  -Daikars.new.flags=true \
  -jar paper.jar nogui
