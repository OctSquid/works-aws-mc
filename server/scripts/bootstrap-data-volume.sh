#!/usr/bin/env bash
# データ用 EBS ボリュームを検出し、未フォーマットなら mkfs して /srv/minecraft にマウントする。
# スナップショット復元ボリュームは既に XFS (ラベル MCDATA) なのでそのままマウントされる。
set -euo pipefail

MOUNT_POINT="/srv/minecraft"
LABEL="MCDATA"

mkdir -p "$MOUNT_POINT"

if mountpoint -q "$MOUNT_POINT"; then
  echo "already mounted"
  exit 0
fi

# アタッチ完了を待つ: ルートディスク以外の NVMe ブロックデバイスが現れるまで最大120秒
DATA_DEV=""
for _ in $(seq 1 60); do
  ROOT_DISK="$(lsblk -no PKNAME "$(findmnt -no SOURCE /)" 2>/dev/null || true)"
  for dev in /dev/nvme*n1; do
    [ -e "$dev" ] || continue
    [ "$(basename "$dev")" = "$ROOT_DISK" ] && continue
    DATA_DEV="$dev"
    break
  done
  [ -n "$DATA_DEV" ] && break
  sleep 2
done

if [ -z "$DATA_DEV" ]; then
  echo "data volume not found" >&2
  exit 1
fi

# ファイルシステムが無ければ初回起動: フォーマットする
if ! blkid "$DATA_DEV" >/dev/null 2>&1; then
  echo "formatting $DATA_DEV as xfs (first boot)"
  mkfs.xfs -L "$LABEL" "$DATA_DEV"
fi

mount "$DATA_DEV" "$MOUNT_POINT"
echo "mounted $DATA_DEV at $MOUNT_POINT"
