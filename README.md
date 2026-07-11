# aws-mc-server

AWS 上のオンデマンド Minecraft サーバー基盤。Paper + GeyserMC + Floodgate で **Java 版 / Bedrock 版の両方に対応**。
Discord の Slash Command で必要な時だけスポットインスタンスを起動し、プレイヤーが 15 分間不在なら自動停止・terminate する。ワールドデータは停止時に EBS スナップショットへ退避し、次回起動時に復元する。

- 稼働 30〜100 時間/月で **約 ¥650〜¥1,400/月**（+ ドメイン代 ≈$14/年）
- すべて IaC（Terraform + Packer）、デプロイは GitHub Actions（OIDC・長期キーなし）

## アーキテクチャ

```bash
[Discord] ─/start /stop /status─▶ [Lambda: interactions] (Function URL, 署名検証, deferred応答)
                                      │ async invoke
                                      ▼
                                 [Lambda: command-worker] (DynamoDB で排他・状態機械)
                                      │ 最安AZのスポットを自動選択して起動 / SSM経由で graceful stop
                                      ▼
[EC2 スポット m6g.large (Graviton/arm64)] ← Packer製AMI (Paper + Geyser + Floodgate + 設定焼き込み)
   ├ /srv/minecraft = データ用EBS (停止時スナップショット化 → 起動時復元)
   └ systemd timer: 15分無人で自動停止
[EventBridge] ─ スポット中断警告 / terminate / snapshot完了 ─▶ [Lambda: lifecycle 等]
[Route53] 起動時に A レコード UPSERT (Elastic IP 不使用)
```

各コンポーネントの詳細設計は `plan.md` を参照。

## リポジトリ構成

| パス                        | 内容                                                                    |
| --------------------------- | ----------------------------------------------------------------------- |
| `server.json`               | Minecraft/Paper バージョン、JVM ヒープ、EC2 の arch・インスタンスタイプ |
| `plugins.json`              | プラグイン定義（追加はここに 1 エントリ書くだけ）                       |
| `server-config/`            | サーバー・プラグイン設定、インスタンス上のスクリプト、systemd ユニット  |
| `tools/download-artifacts/` | server.json/plugins.json を解釈して Paper + プラグインを DL             |
| `tools/register-commands/`  | Discord Slash Commands 登録                                             |
| `packer/`                   | AMI ビルド定義                                                          |
| `lambda/`                   | interactions / command-worker / lifecycle / spot-interruption           |
| `terraform/bootstrap/`      | 初回手動 apply（state バケット, GitHub OIDC, CI ロール）                |
| `terraform/envs/prod/`      | 本番環境一式                                                            |
| `docker/`                   | ローカルテスト環境（本番と同じプロビジョニングスクリプトを使用）        |

## 初回セットアップ

### 0. 前提

- `mise install`（aws-cli / terraform / packer / node が入る）
- AWS アカウントと管理者権限、AWS CLI のプロファイル設定
- [Minecraft EULA](https://aka.ms/MinecraftEULA) への同意（AMI に `eula=true` を焼き込むため）

### 1. Terraform bootstrap（手動・1回だけ）

```sh
cd terraform/bootstrap
terraform init
terraform apply -var github_repository=<owner>/<repo> -var state_bucket_name=<一意なバケット名>
```

state バケット・GitHub OIDC プロバイダ・CI 用 IAM ロール（`gha-terraform` / `gha-packer`）が作成される。

### 2. ドメイン取得（Route53）

1. AWS コンソール → Route53 →「ドメインの登録」で取得（`.com` ≈ $14/年）。Hosted Zone が自動作成される
2. Hosted Zone を Terraform 管理に取り込む:
   ```sh
   cd terraform/envs/prod
   terraform import -var domain_name=<domain> -var budget_email=<email> \
     module.dns.aws_route53_zone.this <ZONE_ID>
   ```

### 3. Discord アプリケーション作成

1. [Discord Developer Portal](https://discord.com/developers/applications) で New Application
2. 控える値: **Application ID**、**Public Key**、Bot タブの **Token**
3. サーバー（ギルド）に Bot を招待（スコープ `applications.commands` のみで可）
4. 通知用チャンネルで Webhook を作成し URL を控える

### 4. GitHub リポジトリ設定

- Variables: `AWS_ACCOUNT_ID`, `TF_STATE_BUCKET`, `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID`
- Secrets: `DISCORD_BOT_TOKEN`（CurseForge のプラグインを使う場合は `CURSEFORGE_API_KEY` も）

### 5. シークレットの投入（SSM Parameter Store）

Terraform はプレースホルダでパラメータを作るので、実値を CLI で投入する:

```sh
aws ssm put-parameter --overwrite --name /mc/discord/public-key --type String --value '<PUBLIC_KEY>'
aws ssm put-parameter --overwrite --name /mc/discord/bot-token --type SecureString --value '<BOT_TOKEN>'
aws ssm put-parameter --overwrite --name /mc/discord/webhook-url --type SecureString --value '<WEBHOOK_URL>'
aws ssm put-parameter --overwrite --name /mc/rcon-password --type SecureString --value "$(openssl rand -hex 24)"
```

### 6. デプロイ

1. main に push → `terraform.yml` が Lambda ビルド + terraform apply
2. `ami-build.yml` を手動実行（または server.json 等の変更を push）→ AMI ビルド + SSM `/mc/ami-id` 更新
3. `discord-commands.yml` を手動実行 → Slash Commands 登録
4. Terraform 出力の `function_url` を Discord Developer Portal の **Interactions Endpoint URL** に設定
   （Discord が PING を送って検証するため、Lambda デプロイ後に行うこと）

## 日常運用

| 操作                   | 方法                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| サーバー起動           | Discord で `/start`（最も安い AZ×インスタンスタイプのスポットを自動選択）                            |
| スポット枯渇時         | `/start ondemand:True` でオンデマンド起動（割高。明示指定のみ）                                      |
| サーバー停止           | `/stop`（自動でスナップショットバックアップ）。放置でも 15 分無人で自動停止                          |
| 状態確認               | `/status`                                                                                            |
| プラグイン追加・更新   | `plugins.json` を編集して PR → main マージで AMI 自動再ビルド → 次回 `/start` から反映               |
| MC バージョンアップ    | `server.json` の `minecraft_version` を更新（同上）                                                  |
| インスタンスタイプ変更 | `server.json` の `ec2` を編集（arch 変更時は AMI 再ビルド + terraform apply の両方が自動で走る）     |
| サーバー設定変更       | `server-config/` を編集（同上）                                                                      |
| 管理コマンド実行       | SSM Session Manager で接続し `sudo /opt/minecraft/bin/rcon.sh <command>`（SSH ポートは開いていない） |

### サーバーコンソールへのアクセス

SSH ポートは開けていないため、接続はすべて **SSM Session Manager** 経由で行う（IAM 権限があれば追加設定不要）。

```sh
# 稼働中インスタンスの ID を取得
INSTANCE_ID=$(aws ec2 describe-instances \
  --filters 'Name=tag:mc:role,Values=server' 'Name=instance-state-name,Values=running' \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)

# シェルに入る（要: AWS CLI + Session Manager プラグイン https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html ）
aws ssm start-session --target "$INSTANCE_ID"
```

セッション内でよく使う操作:

```sh
# Minecraft コンソール（RCON）— 引数なしで対話モード、引数ありで1コマンド実行
sudo /opt/minecraft/bin/rcon.sh              # 対話コンソール（exit で抜ける）
sudo /opt/minecraft/bin/rcon.sh list         # 例: プレイヤー一覧
sudo /opt/minecraft/bin/rcon.sh "op Yoppy431" # 例: OP 付与

# サーバーログの追尾
sudo journalctl -fu minecraft                # systemd 経由（起動失敗の調査はこちら）
sudo tail -f /srv/minecraft/logs/latest.log  # Minecraft 本体のログ

# サービスの状態確認・再起動
systemctl status minecraft mc-bootstrap mc-up-notify
sudo systemctl restart minecraft
```

セッションに入らず 1 コマンドだけ実行する場合は SSM RunCommand でも可:

```sh
aws ssm send-command --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["/opt/minecraft/bin/rcon.sh list"]'
```

> 注意: `stop` を RCON から直接打つとサーバープロセスは止まるが、terminate・スナップショットの
> ライフサイクルは Discord の `/stop`（または自動停止）経由でないと走らない。
> 通常の停止は必ず `/stop` を使うこと。

### プラグインの追加方法

`plugins.json` の `plugins` 配列に 1 エントリ追加する。対応ソース: `hangar`（PaperMC 公式・推奨）/ `modrinth` / `github` / `geysermc` / `curseforge`（要 API キー）/ `url` / `local`（手動入手 jar を `server-config/plugins-local/` に置く）。

```jsonc
{
  "name": "VeinMiner",
  "source": "hangar",
  "id": "VeinMiner",
  "version": "latest",
  "preserve": ["plugins/VeinMiner/*.db"],
}
```

- **`preserve` を必ず検討すること**: プレイヤーデータやセーブ依存ファイルのパターンを書くと、AMI 更新時も上書きされず保持される
- SpigotMC 配布のみのプラグインは Cloudflare 保護のため自動 DL 不可が多い。`local` ソースを使う

### 設定の上書き・保持ルール

起動時に AMI 内の配布物をデータボリュームへ rsync する（`sync-dist.sh`）:

- **Git が正（常に上書き）**: Paper 本体、プラグイン jar（dist に無い古い jar は削除）、`server-config/` 管理の設定ファイル
- **サーバーが正（常に保持）**: `world*/`、`usercache.json`、ban/ops/whitelist、`plugins.json` の `preserve` パターン、`server-config/sync-preserve.txt` のパターン
- dist に存在しないファイル（プラグイン生成データ等）はそもそも触らない（`--delete` 不使用）

## ローカルテスト

```sh
cd tools/download-artifacts && npm install && npm run download   # artifacts/ を生成
cd ../../docker && docker compose up --build
```

- Java 版: `localhost` / Bedrock 版: `localhost:19132`
  （Windows の Bedrock 版は loopback 制限の解除が必要: `CheckNetIsolation LoopbackExempt -a -n=Microsoft.MinecraftUWP_8wekyb3d8bbwe`）
- ワールドは `docker/data/` に永続化される。`docker compose down` →再作成でも残ることを確認できる
- RCON テスト: `docker compose exec minecraft /opt/minecraft/bin/rcon.sh list`
- イメージは Alpine ベース（JVM は Temurin JRE 25。本番は Corretto 25 だがともに OpenJDK ビルドで実質同等）。
  musl のため AL2023 の完全再現ではないが、検証の目的は共有プロビジョニングスクリプトと
  Paper の動作確認であり、そこは維持される

> **注意（Apple Silicon）**: Docker デーモンが x86_64 エミュレーション（colima の x86_64 VM 等）の場合、
> JVM の JIT が SIGSEGV でクラッシュすることがある。ネイティブ arch の VM（`colima start --arch aarch64 --vm-type vz`
> や Docker Desktop）を使うこと。応急処置は `JAVA_TOOL_OPTIONS=-Xint`（非常に遅い）。
>
> ローカルビルドは常に**ホストのネイティブ arch** に従う（server.json の `ec2.architecture` は
> 本番 AMI / EC2 専用で、Docker ビルドには影響しない）。

### Lint / Format

リポジトリ全体を [oxlint](https://oxc.rs/docs/guide/usage/linter) / [oxfmt](https://oxc.rs/docs/guide/usage/formatter) で検査・整形する（CI の `lint` ワークフローでも同じチェックが走る）。

```sh
npm ci            # リポジトリルートで（初回のみ）
npm run lint      # oxlint（.oxlintrc.json）
npm run fmt       # oxfmt で整形（.oxfmtrc.json）
npm run fmt:check # 整形差分の検査のみ（CI と同じ）
```

## 障害時リカバリ

| 症状                                  | 対応                                                                                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/start` が「既に操作が進行中」のまま | 15 分待つと状態ロックは奪取可能になる。急ぐ場合は DynamoDB `mc-server-state` の `state` を `STOPPED` に手動更新                                             |
| スナップショット作成に失敗した        | データはボリュームに残っている（DeleteOnTermination=false）。`mc:data=true` タグの available ボリュームを確認し、次回 `/start` はそのボリュームを再利用する |
| ワールドを過去時点に戻したい          | DynamoDB を STOPPED にした上で、戻したい世代より新しいスナップショット（`mc:data=true`）を削除 → `/start`（最新スナップショットから復元される）             |
| Bedrock 版で入れない                  | Floodgate の `key.pem` が失われた可能性。スナップショットから復元するか、全 Bedrock プレイヤーの再リンクが必要                                              |
| インスタンスに入りたい                | `aws ssm start-session --target <instance-id>`                                                                                                              |

## リソースのライフサイクル（何が残り、何が自動で消えるか）

| リソース                                 | 挙動                                                                                                                                                          | 課金                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| ゲーム用インスタンス                     | `/stop`・自動停止・スポット中断で **terminate**。コンソールには約1時間 `terminated` 表示で残るが、これは AWS の表示仕様で**実体はなく課金もない**             | 稼働中のみ                        |
| Packer ビルド用インスタンス (t4g.medium) | ビルド完了時に Packer が terminate（上と同様にしばらく表示は残る）                                                                                            | ビルド中のみ（スポット・数分）    |
| データ用 EBS ボリューム                  | terminate 後に lifecycle Lambda がスナップショット化 → **削除**。残るのは異常時のみ（データ保全のため意図的に残す）                                           | 稼働中のみ                        |
| ワールドスナップショット (20GB)          | 停止のたびに1つ作成、**直近 `snapshot_retention` 世代（現在3）を残して自動削除**。毎回別ボリューム由来のため増分にならず、実使用量×世代数で課金される点に注意 | ~$0.05/GB・月 × 実使用量 × 世代数 |
| AMI                                      | ビルドのたびに作成、**最新2世代を残して自動 deregister**（付随する 8GB スナップショットも削除）                                                               | 実使用 ~3GB × 2世代 ≈ $0.3/月     |
| Route53 A レコード                       | terminate 時に lifecycle Lambda が削除                                                                                                                        | zone 代のみ                       |

つまり**停止中に残るのは「スナップショット類 + Route53 zone」だけ**（合計 $1〜2/月 程度）。
コンソールで「インスタンスが溜まっている」ように見えたら、まず State 列が `terminated` かを確認すること。

## コスト管理

- AWS Budgets（月 $15、Terraform 変数で変更可）で 80%/100% 時にメール通知
- 主なコスト: スポット稼働時間（≈$0.06/h）、EBS スナップショット 7 世代、AMI 2 世代、Route53 zone $0.5/月
- NAT Gateway / Elastic IP / ALB は使わない（これが低コストの前提。追加しないこと）
