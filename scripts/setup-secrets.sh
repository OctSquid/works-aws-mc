#!/usr/bin/env bash
# .env の値を SSM Parameter Store へ投入する（初回セットアップの手作業を置き換え）。
# 実行: mise run setup:secrets（.env は mise が自動注入する）
# 冪等: 何度実行しても安全。rcon-password だけは投入済みなら上書きしない。
set -euo pipefail

: "${DISCORD_PUBLIC_KEY:?DISCORD_PUBLIC_KEY が未設定です（.env を確認、.env.example 参照）}"
: "${DISCORD_BOT_TOKEN:?DISCORD_BOT_TOKEN が未設定です（.env を確認）}"
: "${DISCORD_WEBHOOK_URL:?DISCORD_WEBHOOK_URL が未設定です（.env を確認）}"

put() {
  local name="$1" type="$2" value="$3"
  aws ssm put-parameter --overwrite --name "$name" --type "$type" --value "$value" >/dev/null
  echo "✓ $name"
}

put /mc/discord/public-key String "$DISCORD_PUBLIC_KEY"
put /mc/discord/bot-token SecureString "$DISCORD_BOT_TOKEN"
put /mc/discord/webhook-url SecureString "$DISCORD_WEBHOOK_URL"

# rcon-password: 未投入（placeholder）のときだけ自動生成する。
# 稼働中サーバーのパスワードを意図せずローテーションしないため
current="$(aws ssm get-parameter --name /mc/rcon-password --with-decryption \
  --query Parameter.Value --output text 2>/dev/null || echo placeholder)"
if [ "$current" = "placeholder" ]; then
  put /mc/rcon-password SecureString "$(openssl rand -hex 24)"
else
  echo "- /mc/rcon-password は投入済みのためスキップ（再生成するときは AWS CLI で直接上書き）"
fi

echo "完了。次: git push で Terraform/AMI をデプロイし、mise run doctor で確認"
