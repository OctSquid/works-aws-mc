#!/usr/bin/env bash
# AMI 内の配布物 (/opt/minecraft-dist) をデータボリューム (/srv/minecraft) へ反映する。
# 原則: jar と Git 管理の設定は「常に上書き（Git が正）」、
#       ワールド・プレイヤーデータ・plugins.json の preserve パターンは「常に保持（サーバーが正）」。
set -euo pipefail

DIST="${DIST:-/opt/minecraft-dist}"
DATA="${DATA:-/srv/minecraft}"
MC_USER="${MC_USER:-minecraft}"

mkdir -p "$DATA/plugins"

# 除外リストを生成: manifest.json の preserve (plugins.json 由来) + sync-preserve.txt
EXCLUDES="$(mktemp)"
trap 'rm -f "$EXCLUDES"' EXIT
jq -r '.preserve[]?' "$DIST/manifest.json" >> "$EXCLUDES"
grep -vE '^\s*(#|$)' "$DIST/sync-preserve.txt" >> "$EXCLUDES" || true

# dist に存在しない古いプラグイン jar を削除（plugins/ 直下の jar のみ。データディレクトリは触らない）
for jar in "$DATA"/plugins/*.jar; do
  [ -e "$jar" ] || continue
  if [ ! -e "$DIST/server/plugins/$(basename "$jar")" ]; then
    echo "removing stale plugin: $(basename "$jar")"
    rm -f "$jar"
  fi
done

# --delete は使わない: dist に無いファイル（ワールド、プラグイン生成データ等）はデフォルト保持
# -a ではなく -rlptD: owner/group は rsync で保持せず下の chown で揃える
# （macOS の Docker バインドマウントは chown 非対応で rsync -a が失敗するため）
rsync -rlptD --exclude-from="$EXCLUDES" "$DIST/server/" "$DATA/"

if id "$MC_USER" >/dev/null 2>&1; then
  # バインドマウント上では chown できないことがあるが、その環境では
  # 所有権によらず書き込めるため無視してよい（EC2 の xfs では必ず成功する）
  chown -R "$MC_USER:$MC_USER" "$DATA" 2>/dev/null || echo "warn: chown skipped (bind mount?)"
fi
echo "dist synced to $DATA"
