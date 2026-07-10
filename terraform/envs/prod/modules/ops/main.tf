# ============================================================================
# ops: コスト監視
#
# アカウント全体の月額コストに対する予算アラート。
# 実績 (ACTUAL) が 80% / 100% に達した時点でメール通知する。
# Lambda の CloudWatch Log Group（保持14日）は Lambda 定義と同居させるため
# control-plane モジュール側で作成している。
# ============================================================================

resource "aws_budgets_budget" "monthly" {
  name        = "mc-server-monthly"
  budget_type = "COST"

  limit_amount = tostring(var.budget_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_email]
  }
}
