#!/usr/bin/env bash
# Discord Webhook へメッセージを送る。usage: notify-discord.sh <message>
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/minecraft/env}"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && source "$ENV_FILE"

if [ -z "${DISCORD_WEBHOOK_URL:-}" ]; then
  echo "DISCORD_WEBHOOK_URL not set; skipping notification: $*"
  exit 0
fi

curl -sf -X POST "$DISCORD_WEBHOOK_URL" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg content "$*" '{content: $content}')" > /dev/null
