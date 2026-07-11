#!/usr/bin/env bash
# ローカル (Docker) 用エントリポイント。EC2 の mc-bootstrap.service 相当:
# データボリュームのマウントは Docker volume が担うため、sync + render のみ実行して起動する。
set -euo pipefail

export LOCAL=1
export DATA=/srv/minecraft

/opt/minecraft/bin/sync-dist.sh
/opt/minecraft/bin/render-config.sh

exec su-exec minecraft /opt/minecraft/bin/mc-start.sh
