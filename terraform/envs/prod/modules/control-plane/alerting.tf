# ============================================================================
# 失敗の可視化
#
# コントロールプレーンは非同期 Invoke（interactions → command-worker、
# EventBridge → lifecycle / spot-interruption）で動くため、リトライ枯渇後の
# 失敗は既定では黙って消える。EC2 の起動・削除やスナップショットを扱う以上、
# 失敗の握り潰しはボリューム残置（課金）やロック残りに直結するので、
# on_failure destination とエラーアラームを SNS → メールで必ず届ける。
# いずれもアイドル時のコストは $0（SNS メール無料枠 / アラーム無料枠内）。
# ============================================================================

resource "aws_sns_topic" "ops_alerts" {
  name = "mc-ops-alerts"
}

resource "aws_sns_topic_subscription" "ops_alerts_email" {
  topic_arn = aws_sns_topic.ops_alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# 非同期 Invoke がリトライ枯渇で失敗したらイベント内容ごと SNS へ流す。
# interactions は同期（Function URL）なので対象外
resource "aws_lambda_function_event_invoke_config" "async_failures" {
  for_each = toset(["command-worker", "lifecycle", "spot-interruption"])

  function_name          = aws_lambda_function.this[each.key].function_name
  maximum_retry_attempts = 2

  destination_config {
    on_failure {
      destination = aws_sns_topic.ops_alerts.arn
    }
  }
}

# ハンドラ内で握り潰さずに throw されたエラー（＝バグや権限不足）の検知
resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = local.functions

  alarm_name          = "${each.value.name}-errors"
  alarm_description   = "${each.value.name} の Lambda エラー発生"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = each.value.name
  }

  alarm_actions = [aws_sns_topic.ops_alerts.arn]
}
