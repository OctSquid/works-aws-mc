# ============================================================================
# S3 backend
#
# バケット名などの環境依存値はコードに埋め込まず、初期化時に
# -backend-config で渡す（bootstrap の output "state_bucket_name" を使う）:
#
#   terraform init \
#     -backend-config="bucket=<state_bucket_name>" \
#     -backend-config="region=ap-northeast-1"
#
# use_lockfile = true により Terraform 1.10+ の S3 ネイティブロック
# （state ファイルと同じキーに .tflock を置く方式）を使用する。
# DynamoDB ロックテーブルは不要。
# ============================================================================

terraform {
  required_version = ">= 1.10"

  backend "s3" {
    key          = "envs/prod/terraform.tfstate"
    use_lockfile = true
  }
}
