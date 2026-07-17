#!/usr/bin/env bash
# セットアップ状態の読み取り専用診断。何も変更しない。
# 実行: mise run doctor
set -uo pipefail

FAIL=0
ok() { echo "✓ $1"; }
ng() {
  echo "✗ $1"
  FAIL=1
}

echo "== ツール =="
for tool in aws terraform packer node npm docker; do
  if command -v "$tool" >/dev/null 2>&1; then
    ok "$tool: $("$tool" --version 2>&1 | head -1)"
  else
    ng "$tool が見つかりません（mise install / Docker Desktop を確認）"
  fi
done

echo
echo "== AWS 認証 =="
if identity="$(aws sts get-caller-identity --output text --query Account 2>&1)"; then
  ok "アカウント: ${identity}（AWS_PROFILE=${AWS_PROFILE:-未設定}）"
else
  ng "aws sts get-caller-identity に失敗: $identity"
  echo "以降の AWS チェックをスキップします"
  exit 1
fi

echo
echo "== SSM パラメータ（placeholder のままなら未投入） =="
for param in /mc/discord/public-key /mc/discord/bot-token /mc/discord/webhook-url /mc/rcon-password /mc/ami-id; do
  value="$(aws ssm get-parameter --name "$param" --with-decryption --query Parameter.Value --output text 2>/dev/null)"
  if [ -z "$value" ]; then
    ng "$param が存在しません（terraform apply が未実行？）"
  elif [ "$value" = "placeholder" ]; then
    ng "$param が placeholder のままです（mise run setup:secrets を実行）"
  else
    ok "$param"
  fi
done

echo
echo "== AMI =="
ami_id="$(aws ssm get-parameter --name /mc/ami-id --query Parameter.Value --output text 2>/dev/null)"
if [ -n "$ami_id" ]; then
  ami_name="$(aws ec2 describe-images --image-ids "$ami_id" --query 'Images[0].Name' --output text 2>/dev/null)"
  case "$ami_name" in
    mc-server-*) ok "/mc/ami-id → $ami_name" ;;
    None | "") ng "/mc/ami-id の AMI ($ami_id) が見つかりません" ;;
    *) ng "/mc/ami-id が Packer 製でない AMI を指しています ($ami_name)。ami-build.yml を実行" ;;
  esac
fi

base_count="$(aws ec2 describe-images --owners self --filters 'Name=name,Values=mc-base-*' \
  --query 'length(Images)' --output text 2>/dev/null)"
if [ "${base_count:-0}" != "0" ]; then
  ok "ベース AMI (mc-base-*): ${base_count} 世代"
else
  ng "ベース AMI (mc-base-*) がありません（ami-base-build.yml を実行。無いと ami-build が失敗する）"
fi

echo
echo "== Lambda / Function URL =="
if url="$(aws lambda get-function-url-config --function-name mc-interactions --query FunctionUrl --output text 2>/dev/null)"; then
  ok "Function URL: $url"
  status="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$url" -H 'content-type: application/json' -d '{}' 2>/dev/null)"
  if [ "$status" = "401" ]; then
    ok "未署名 POST に 401（署名検証が機能。この URL を Discord の Interactions Endpoint に設定）"
  else
    ng "未署名 POST への応答が ${status}（期待: 401）。Lambda のデプロイ / public-key 投入を確認"
  fi
else
  ng "mc-interactions の Function URL がありません（terraform apply が未実行？）"
fi

echo
echo "== バックアップ =="
total_gb="$(aws ec2 describe-snapshots --owner-ids self \
  --filters Name=tag:mc:data,Values=true Name=status,Values=completed \
  --query 'sum(Snapshots[].VolumeSize)' --output text 2>/dev/null)"
count="$(aws ec2 describe-snapshots --owner-ids self \
  --filters Name=tag:mc:data,Values=true Name=status,Values=completed \
  --query 'length(Snapshots)' --output text 2>/dev/null)"
if [ "${count:-0}" != "0" ] && [ -n "${count:-}" ]; then
  ok "ワールドスナップショット: ${count} 世代 / 計 ${total_gb}GB（≈\$$(echo "$total_gb" | awk '{printf "%.2f", $1 * 0.05}')/月）"
else
  echo "- ワールドスナップショットなし（初回起動前なら正常）"
fi

echo
if [ "$FAIL" = "0" ]; then
  echo "🎉 すべての診断に合格しました"
else
  echo "⚠️ 未完了の項目があります（上の ✗ を参照）"
  exit 1
fi
