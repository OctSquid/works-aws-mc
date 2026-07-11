variable "region" {
  description = "AWS リージョン"
  type        = string
  default     = "ap-northeast-1"
}

variable "domain_name" {
  description = "Route53 で管理するドメイン名（例: \"example.com\"）"
  type        = string
}

variable "subdomain" {
  description = "Minecraft サーバー用サブドメイン（\"<subdomain>.<domain_name>\" が接続先 FQDN になる）"
  type        = string
  default     = "mc"
}

variable "data_volume_size_gb" {
  description = "データ用 EBS ボリューム（/srv/minecraft）のサイズ (GiB)"
  type        = number
  default     = 20
}

variable "snapshot_retention" {
  description = "データボリュームのスナップショット保持世代数（超過分は lifecycle Lambda が削除）"
  type        = number
  default     = 7
}

variable "budget_limit_usd" {
  description = "AWS Budgets の月額上限 (USD)。80%/100% 到達でメール通知"
  type        = number
  default     = 15
}

variable "budget_email" {
  description = "Budgets アラートの通知先メールアドレス"
  type        = string
}
