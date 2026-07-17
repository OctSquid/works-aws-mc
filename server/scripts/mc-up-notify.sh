#!/usr/bin/env bash
# minecraft.service 起動後、RCON が応答する（＝ワールド読込完了）まで待って Discord に通知する。
set -euo pipefail

for _ in $(seq 1 120); do
  if /opt/minecraft/bin/rcon.sh list >/dev/null 2>&1; then
    /opt/minecraft/bin/notify-discord.sh "✅ ワールドの読み込みが完了しました。サーバーに接続できます！"
    exit 0
  fi
  sleep 5
done

/opt/minecraft/bin/notify-discord.sh "⚠️ サーバープロセスは起動しましたが、10分以内にワールド読み込みが完了しませんでした。ログの確認が必要です。"
exit 1
