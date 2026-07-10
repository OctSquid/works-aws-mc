#!/usr/bin/env bash
# サーバーの graceful shutdown。command-worker (SSM RunCommand) / idle-watchdog / spot-interruption から呼ばれる。
# usage: mc-shutdown.sh <manual|auto-idle|spot> [--fast]
# 1. RCON でゲーム内告知 → 猶予 → save-all
# 2. systemctl stop minecraft (ExecStop で RCON stop による graceful 終了)
# 3. インスタンスに mc:stop-reason タグを付与 (lifecycle Lambda が Discord 通知の文言に使う)
# 4. poweroff → InstanceInitiatedShutdownBehavior=terminate により terminate
#    (spot 中断時は AWS 側が terminate するため poweroff しない)
set -euo pipefail

REASON="${1:?usage: mc-shutdown.sh <manual|auto-idle|spot> [--fast]}"
GRACE=60
[ "${2:-}" = "--fast" ] && GRACE=10

BIN=/opt/minecraft/bin

if systemctl is-active --quiet minecraft; then
  case "$REASON" in
    spot)      "$BIN/rcon.sh" "say [お知らせ] スポット中断のため約2分後にサーバーが停止します。データは保存されます。" || true ;;
    auto-idle) "$BIN/rcon.sh" "say [お知らせ] プレイヤー不在のためサーバーを停止します。" || true ;;
    *)         "$BIN/rcon.sh" "say [お知らせ] ${GRACE}秒後にサーバーを停止します。" || true ;;
  esac
  sleep "$GRACE"
  "$BIN/rcon.sh" "save-all flush" || true
  sleep 5
fi

systemctl stop minecraft || true

# mc:stop-reason タグを付与
TOKEN="$(curl -sf -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')" || true
if [ -n "${TOKEN:-}" ]; then
  INSTANCE_ID="$(curl -sf http://169.254.169.254/latest/meta-data/instance-id -H "X-aws-ec2-metadata-token: $TOKEN")"
  REGION="$(curl -sf http://169.254.169.254/latest/meta-data/placement/region -H "X-aws-ec2-metadata-token: $TOKEN")"
  aws ec2 create-tags --region "$REGION" --resources "$INSTANCE_ID" \
    --tags "Key=mc:stop-reason,Value=$REASON" || true
fi

if [ "$REASON" != "spot" ]; then
  poweroff
fi
