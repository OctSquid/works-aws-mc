#!/usr/bin/env bash
# Packer プロビジョナ。AMI に Minecraft 一式を焼き込む。
# シークレット (RCON パスワード等) は焼き込まず、起動時に SSM から取得する (render-config.sh)。
set -euo pipefail

RCON_CLI_VERSION="${RCON_CLI_VERSION:-1.6.11}"

# Minecraft 26.1+ は Java 25 以上が必要
dnf install -y java-25-amazon-corretto-headless jq rsync

useradd -r -m -d /var/lib/minecraft -s /sbin/nologin minecraft

# スクリプト群
mkdir -p /opt/minecraft/bin
cp /tmp/server-config/scripts/*.sh /opt/minecraft/bin/
chmod +x /opt/minecraft/bin/*.sh

# rcon-cli (itzg) — arch はビルドインスタンス自身から導出（AMI と常に一致する）
case "$(uname -m)" in
  aarch64) RCON_ARCH=arm64 ;;
  x86_64) RCON_ARCH=amd64 ;;
  *)
    echo "unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac
curl -sfL "https://github.com/itzg/rcon-cli/releases/download/${RCON_CLI_VERSION}/rcon-cli_${RCON_CLI_VERSION}_linux_${RCON_ARCH}.tar.gz" \
  | tar -xz -C /tmp
install -m 755 /tmp/rcon-cli /opt/minecraft/bin/rcon-cli

# 配布物ツリーの組み立て (Docker と同一スクリプト)
/opt/minecraft/bin/build-dist.sh /tmp/artifacts /tmp/server-config /opt/minecraft-dist

# systemd ユニット
cp /tmp/server-config/systemd/*.service /tmp/server-config/systemd/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable mc-bootstrap.service minecraft.service mc-up-notify.service mc-idle-watchdog.timer

# データボリュームのマウントポイント
mkdir -p /srv/minecraft

# 後片付け
rm -rf /tmp/artifacts /tmp/server-config /tmp/rcon-cli

echo "AMI provisioning complete"
