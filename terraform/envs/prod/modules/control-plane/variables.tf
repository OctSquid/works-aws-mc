variable "region" {
  description = "AWS リージョン（IAM ポリシーの ARN 構築に使用）"
  type        = string
}

variable "launch_template_id" {
  description = "Minecraft サーバー用 Launch Template ID（command-worker が RunInstances に使用）"
  type        = string
}

variable "subnet_ids" {
  description = "起動先候補のパブリックサブネット ID（AZ 分散。worker がスポット価格で選択）"
  type        = list(string)
}

variable "hosted_zone_id" {
  description = "サーバーの A レコードを管理する Route53 Hosted Zone ID"
  type        = string
}

variable "server_fqdn" {
  description = "Minecraft サーバーの接続先 FQDN（例: \"mc.example.com\"）"
  type        = string
}

variable "instance_types" {
  description = "スポット起動候補のインスタンスタイプ（優先順）"
  type        = list(string)

  validation {
    condition     = length(var.instance_types) > 0
    error_message = "instance_types は 1 つ以上指定してください。"
  }
}

variable "architecture" {
  description = "サーバーの CPU アーキテクチャ（シード AMI の選択に使用。instance_types と整合していること）"
  type        = string

  validation {
    condition     = contains(["arm64", "x86_64"], var.architecture)
    error_message = "architecture は arm64 か x86_64 を指定してください。"
  }
}

variable "data_volume_size_gb" {
  description = "データ用 EBS ボリュームのサイズ (GiB)。初回起動（スナップショットなし）時に worker が使用"
  type        = number
}

variable "snapshot_retention" {
  description = "スナップショット保持世代数（lifecycle Lambda が超過分を削除）"
  type        = number
}

variable "ec2_instance_role_arn" {
  description = "EC2 インスタンスロールの ARN（command-worker の iam:PassRole 対象）"
  type        = string
}

variable "lambda_dist_dir" {
  description = "Lambda ビルド成果物ディレクトリ（配下に interactions/ command-worker/ lifecycle/ spot-interruption/ がある前提）"
  type        = string
}

variable "log_retention_days" {
  description = "Lambda の CloudWatch Logs 保持日数"
  type        = number
  default     = 14
}

variable "lambda_runtime" {
  description = "Lambda ランタイム"
  type        = string
  default     = "nodejs24.x"
}

variable "lambda_memory_mb" {
  description = "Lambda のメモリサイズ (MB)"
  type        = number
  default     = 256
}
