variable "vpc_cidr" {
  description = "VPC の CIDR ブロック"
  type        = string
  default     = "10.64.0.0/16"
}

variable "az_count" {
  description = "パブリックサブネットを分散させる AZ 数（スポット確保の選択肢を増やすため 3AZ）"
  type        = number
  default     = 3
}

variable "name" {
  description = "リソース名のプレフィクス"
  type        = string
  default     = "mc-server"
}
