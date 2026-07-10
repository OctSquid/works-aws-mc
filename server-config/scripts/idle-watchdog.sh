#!/usr/bin/env bash
# systemd timer から1分毎に実行。RCON でプレイヤー数を確認し、
# 15回連続 0 人なら mc-shutdown.sh auto-idle で自動停止する。
# 起動直後 15 分間はグレース期間として停止しない（起動して誰も入る前に落ちる事故防止）。
set -euo pipefail

IDLE_LIMIT="${IDLE_LIMIT:-15}"
GRACE_SEC="${GRACE_SEC:-900}"
COUNT_FILE="/run/mc-idle-count"

systemctl is-active --quiet minecraft || exit 0

# グレース期間: minecraft.service の起動からの経過秒数
STARTED_AT="$(systemctl show minecraft -p ActiveEnterTimestampMonotonic --value)"
NOW="$(awk '{printf "%d", $1 * 1000000}' /proc/uptime)"
ELAPSED_SEC=$(( (NOW - STARTED_AT) / 1000000 ))
if [ "$ELAPSED_SEC" -lt "$GRACE_SEC" ]; then
  exit 0
fi

# "There are 3 of a max of 20 players online: ..." からプレイヤー数を抽出
LIST_OUT="$(/opt/minecraft/bin/rcon.sh list 2>/dev/null || echo "")"
PLAYERS="$(echo "$LIST_OUT" | grep -oE 'There are [0-9]+' | grep -oE '[0-9]+' || echo "")"

if [ -z "$PLAYERS" ]; then
  # RCON 不通（起動中など）はカウントしない
  exit 0
fi

if [ "$PLAYERS" -gt 0 ]; then
  echo 0 > "$COUNT_FILE"
  exit 0
fi

COUNT="$(cat "$COUNT_FILE" 2>/dev/null || echo 0)"
COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNT_FILE"
echo "idle check: players=0 count=$COUNT/$IDLE_LIMIT"

if [ "$COUNT" -ge "$IDLE_LIMIT" ]; then
  echo "idle limit reached; shutting down"
  /opt/minecraft/bin/mc-shutdown.sh auto-idle --fast
fi
