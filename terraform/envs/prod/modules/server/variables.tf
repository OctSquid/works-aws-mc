variable "region" {
  description = "AWS リージョン（IAM ポリシーの ARN 構築に使用）"
  type        = string
}

variable "security_group_id" {
  description = "Minecraft サーバーにアタッチするセキュリティグループ ID"
  type        = string
}

variable "default_instance_type" {
  description = "Launch Template のデフォルトインスタンスタイプ（command-worker が RunInstances 時に候補リストから上書きする）"
  type        = string
}

variable "ami_ssm_parameter" {
  description = "AMI ID を格納する SSM パラメータ名（Launch Template が動的に解決）"
  type        = string
  default     = "/mc/ami-id"
}

variable "root_volume_size_gb" {
  description = "ルートボリュームのサイズ (GiB)"
  type        = number
  default     = 8
}

variable "name" {
  description = "リソース名のプレフィクス"
  type        = string
  default     = "mc-server"
}
