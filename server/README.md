# server/ — サーバー実体（AMI / Docker に焼き込まれるもの）

- `scripts/` … インスタンス・コンテナの `/opt/minecraft/bin` に配置される**ランタイムスクリプト**（起動・同期・監視・停止）
- `systemd/` … 本番インスタンスのユニット定義（起動順・アイドル監視タイマー）
- それ以外 … Paper / Bukkit / プラグインの**設定ツリー**（Git が正。起動時に `sync-dist.sh` がデータボリュームへ同期し、`sync-preserve.txt` と plugins.json の `preserve` に一致するものだけサーバー側を保持）
