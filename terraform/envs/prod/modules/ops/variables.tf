variable "budget_limit_usd" {
  description = "月額予算の上限 (USD)"
  type        = number
}

variable "budget_email" {
  description = "予算アラートの通知先メールアドレス"
  type        = string
}
