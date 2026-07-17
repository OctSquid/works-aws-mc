#!/usr/bin/env bash
# アプリ AMI (mc-server-*) のプロビジョナ。ベース AMI (mc-base-*) の上に
# Minecraft 一式（Paper / プラグイン / スクリプト / systemd）を焼き込む。
# OS レイヤ（Java / SSM Agent / rcon-cli 等）は packer/base/install-base.sh 参照。
# シークレット (RCON パスワード等) は焼き込まず、起動時に SSM から取得する (render-config.sh)。
set -euo pipefail

# スクリプト群（ランタイムの実体。変更頻度が高いためアプリ側で毎回上書き）
cp /tmp/server/scripts/*.sh /opt/minecraft/bin/
chmod +x /opt/minecraft/bin/*.sh

# 配布物ツリーの組み立て (Docker と同一スクリプト)
/opt/minecraft/bin/build-dist.sh /tmp/artifacts /tmp/server /opt/minecraft-dist

# systemd ユニット
cp /tmp/server/systemd/*.service /tmp/server/systemd/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable mc-bootstrap.service minecraft.service mc-up-notify.service mc-idle-watchdog.timer

# 後片付け
rm -rf /tmp/artifacts /tmp/server

echo "AMI provisioning complete"
