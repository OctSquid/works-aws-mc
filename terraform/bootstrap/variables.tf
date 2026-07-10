variable "github_repository" {
  description = "GitHub Actions OIDC を許可するリポジトリ（\"owner/repo\" 形式。例: \"yoshi/aws-mc-server\"）"
  type        = string

  validation {
    condition     = can(regex("^[^/]+/[^/]+$", var.github_repository))
    error_message = "github_repository は \"owner/repo\" 形式で指定してください。"
  }
}

variable "region" {
  description = "AWS リージョン"
  type        = string
  default     = "ap-northeast-1"
}

variable "state_bucket_name" {
  description = "Terraform state を保存する S3 バケット名（グローバルに一意。例: \"mc-server-tfstate-<account-id>\"）"
  type        = string
}
