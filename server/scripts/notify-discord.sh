#!/usr/bin/env bash
# Discord Webhook へ embed でメッセージを送る。usage: notify-discord.sh <message> [green|yellow|red|blurple|grey]
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/minecraft/env}"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && source "$ENV_FILE"

MESSAGE="${1:?usage: notify-discord.sh <message> [color]}"
COLOR_NAME="${2:-grey}"

if [ -z "${DISCORD_WEBHOOK_URL:-}" ]; then
  echo "DISCORD_WEBHOOK_URL not set; skipping notification: $MESSAGE"
  exit 0
fi

# lambda/src/shared/messages.ts の COLOR と同じ値
case "$COLOR_NAME" in
  green) COLOR=5763719 ;;   # 0x57f287
  yellow) COLOR=16705372 ;; # 0xfee75c
  red) COLOR=15548997 ;;    # 0xed4245
  blurple) COLOR=5793266 ;; # 0x5865f2
  *) COLOR=10070709 ;;      # 0x99aab5 (grey)
esac

curl -sf -X POST "$DISCORD_WEBHOOK_URL" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg description "$MESSAGE" --argjson color "$COLOR" \
    '{embeds: [{description: $description, color: $color}]}')" > /dev/null
