#!/usr/bin/env bash
# ベース AMI (mc-base-*) のプロビジョナ。変化の少ない OS レイヤのみ焼き込む。
# アプリ側 (Paper / プラグイン / スクリプト / systemd) は packer/provision/install.sh。
set -euo pipefail

RCON_CLI_VERSION="${RCON_CLI_VERSION:?server.json の tooling.rcon_cli_version が必要}"

# Minecraft 26.1+ は Java 25 以上が必要
# amazon-ssm-agent / awscli-2 は minimal AMI に含まれないため明示的に入れる
# （SSM RunCommand と render-config.sh の `aws ssm get-parameter` が依存）
# tar / gzip は rcon-cli 展開用（標準 AMI では no-op）
dnf install -y java-25-amazon-corretto-headless jq rsync amazon-ssm-agent awscli-2 tar gzip
systemctl enable amazon-ssm-agent

useradd -r -m -d /var/lib/minecraft -s /sbin/nologin minecraft

mkdir -p /opt/minecraft/bin

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
rm -f /tmp/rcon-cli

# データボリュームのマウントポイント
mkdir -p /srv/minecraft

echo "base AMI provisioning complete"
