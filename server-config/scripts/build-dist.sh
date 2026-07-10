#!/usr/bin/env bash
# artifacts/ (download-artifacts の出力) + server-config/ から配布物ツリーを組み立てる。
# Packer の AMI ビルドと Docker イメージビルドの両方から呼ばれる（単一ソース）。
# usage: build-dist.sh <artifacts-dir> <server-config-dir> <dest-dir>
set -euo pipefail

ARTIFACTS="$1"
SERVER_CONFIG="$2"
DEST="$3"

mkdir -p "$DEST/server/plugins"

# Paper 本体・プラグイン jar・manifest
cp "$ARTIFACTS/paper.jar" "$DEST/server/paper.jar"
cp "$ARTIFACTS"/plugins/*.jar "$DEST/server/plugins/" 2>/dev/null || true
cp "$ARTIFACTS/manifest.json" "$DEST/manifest.json"

# Git 管理の設定ファイル群（サーバー直下 + config/ + プラグイン設定ディレクトリ）
cp "$SERVER_CONFIG/server.properties.tmpl" "$DEST/server/"
cp "$SERVER_CONFIG"/*.yml "$DEST/server/" 2>/dev/null || true
if [ -d "$SERVER_CONFIG/config" ]; then
  mkdir -p "$DEST/server/config"
  cp -r "$SERVER_CONFIG/config/." "$DEST/server/config/"
fi
if [ -d "$SERVER_CONFIG/plugins" ]; then
  cp -r "$SERVER_CONFIG/plugins/." "$DEST/server/plugins/"
fi

# 除外パターン（プラグイン非依存分）も dist に同梱し、sync-dist.sh が参照する
cp "$SERVER_CONFIG/sync-preserve.txt" "$DEST/sync-preserve.txt"

# EULA 同意（運用者が Minecraft EULA に同意している前提。README 参照）
echo "eula=true" > "$DEST/server/eula.txt"

echo "dist built at $DEST"
