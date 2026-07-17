#!/usr/bin/env bash
# ローカル RCON へコマンドを送る薄いラッパー。usage: rcon.sh <command...>
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/minecraft/env}"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && source "$ENV_FILE"

exec /opt/minecraft/bin/rcon-cli \
  --host 127.0.0.1 --port 25575 --password "${RCON_PASSWORD:?RCON_PASSWORD not set}" "$@"
