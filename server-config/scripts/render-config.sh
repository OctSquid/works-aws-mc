#!/usr/bin/env bash
# シークレットを SSM Parameter Store から取得して /etc/minecraft/env に書き出し、
# server.properties.tmpl から server.properties を生成する。
# AMI にはシークレットを焼き込まず、毎回起動時に取得する。
# ローカル (Docker) では LOCAL=1 で環境変数 RCON_PASSWORD をそのまま使う。
set -euo pipefail

DATA="${DATA:-/srv/minecraft}"
ENV_FILE="${ENV_FILE:-/etc/minecraft/env}"

mkdir -p "$(dirname "$ENV_FILE")"

if [ "${LOCAL:-0}" != "1" ]; then
  TOKEN="$(curl -sf -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')"
  REGION="$(curl -sf http://169.254.169.254/latest/meta-data/placement/region -H "X-aws-ec2-metadata-token: $TOKEN")"
  RCON_PASSWORD="$(aws ssm get-parameter --region "$REGION" --name /mc/rcon-password --with-decryption --query Parameter.Value --output text)"
  DISCORD_WEBHOOK_URL="$(aws ssm get-parameter --region "$REGION" --name /mc/discord/webhook-url --with-decryption --query Parameter.Value --output text)"
else
  RCON_PASSWORD="${RCON_PASSWORD:-local-dev-password}"
  DISCORD_WEBHOOK_URL="${DISCORD_WEBHOOK_URL:-}"
fi

umask 077
cat > "$ENV_FILE" <<EOF
RCON_PASSWORD=${RCON_PASSWORD}
DISCORD_WEBHOOK_URL=${DISCORD_WEBHOOK_URL}
EOF

sed "s|@RCON_PASSWORD@|${RCON_PASSWORD}|" "$DATA/server.properties.tmpl" > "$DATA/server.properties"
echo "config rendered"
