# ============================================================================
# control-plane: Lambda×4 + Function URL + DynamoDB + EventBridge + SSM
#
# 関数（命名は Lambda 実装側と合意済み・変更禁止）:
#   - mc-interactions      : Discord Interactions 受付（Function URL, 10s）
#   - mc-command-worker    : /start /stop /status の実処理（async, 600s）
#   - mc-lifecycle         : terminated / snapshot 完了イベント処理（600s）
#   - mc-spot-interruption : スポット中断警告の処理（60s）
# ============================================================================

data "aws_caller_identity" "current" {}

data "aws_kms_alias" "ssm" {
  name = "alias/aws/ssm"
}

locals {
  account_id = data.aws_caller_identity.current.account_id
  zone_arn   = "arn:aws:route53:::hostedzone/${var.hosted_zone_id}"

  # 全関数共通の環境変数
  common_env = {
    TABLE_NAME          = aws_dynamodb_table.state.name
    LAUNCH_TEMPLATE_ID  = var.launch_template_id
    SUBNET_IDS          = join(",", var.subnet_ids)
    HOSTED_ZONE_ID      = var.hosted_zone_id
    SERVER_FQDN         = var.server_fqdn
    INSTANCE_TYPES      = join(",", var.instance_types)
    PURCHASING          = var.purchasing
    DATA_VOLUME_SIZE_GB = tostring(var.data_volume_size_gb)
    SNAPSHOT_RETENTION  = tostring(var.snapshot_retention)
  }

  # キー = lambda/dist/ 配下のディレクトリ名
  functions = {
    "interactions" = {
      name    = "mc-interactions"
      timeout = 10
      env = merge(local.common_env, {
        WORKER_FUNCTION_NAME = "mc-command-worker"
      })
    }
    "command-worker" = {
      name    = "mc-command-worker"
      timeout = 600
      env     = local.common_env
    }
    "lifecycle" = {
      name    = "mc-lifecycle"
      timeout = 600
      env     = local.common_env
    }
    "spot-interruption" = {
      name    = "mc-spot-interruption"
      timeout = 60
      env     = local.common_env
    }
  }
}

# ----------------------------------------------------------------------------
# DynamoDB: 状態機械（1アイテム、条件付き更新で /start 連打の排他制御）
# ----------------------------------------------------------------------------

resource "aws_dynamodb_table" "state" {
  name         = "mc-server-state"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }
}

# ----------------------------------------------------------------------------
# Lambda 関数
# ----------------------------------------------------------------------------

# ビルド済み成果物（esbuild 出力の ESM）を zip 化する。
# dist が存在しなくても validate は通るが、plan/apply には
# 事前に lambda/ 側のビルドが必要。
data "archive_file" "lambda" {
  for_each = local.functions

  type        = "zip"
  source_dir  = "${var.lambda_dist_dir}/${each.key}"
  output_path = "${path.root}/.terraform/tmp/lambda-${each.key}.zip"
}

resource "aws_cloudwatch_log_group" "lambda" {
  for_each = local.functions

  name              = "/aws/lambda/${each.value.name}"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "this" {
  for_each = local.functions

  function_name = each.value.name
  role          = aws_iam_role.lambda[each.key].arn

  filename         = data.archive_file.lambda[each.key].output_path
  source_code_hash = data.archive_file.lambda[each.key].output_base64sha256

  runtime       = var.lambda_runtime
  architectures = ["arm64"]       # 依存は pure JS のみ。Graviton で GB-秒あたり約 20% 安い
  handler       = "index.handler" # ESM（dist 側の package.json で type: module）
  timeout       = each.value.timeout
  memory_size   = var.lambda_memory_mb

  environment {
    variables = each.value.env
  }

  depends_on = [aws_cloudwatch_log_group.lambda]
}

# Discord の Interactions Endpoint。認証は Lambda 内の ed25519 署名検証で
# 行うため authorization_type は NONE
resource "aws_lambda_function_url" "interactions" {
  function_name      = aws_lambda_function.this["interactions"].function_name
  authorization_type = "NONE"
}

# ----------------------------------------------------------------------------
# EventBridge ルール
# ----------------------------------------------------------------------------

# 1. スポット中断警告（2分前）→ mc-spot-interruption
resource "aws_cloudwatch_event_rule" "spot_interruption" {
  name        = "mc-spot-interruption-warning"
  description = "EC2 Spot Instance Interruption Warning -> mc-spot-interruption"

  event_pattern = jsonencode({
    source      = ["aws.ec2"]
    detail-type = ["EC2 Spot Instance Interruption Warning"]
  })
}

resource "aws_cloudwatch_event_target" "spot_interruption" {
  rule = aws_cloudwatch_event_rule.spot_interruption.name
  arn  = aws_lambda_function.this["spot-interruption"].arn
}

resource "aws_lambda_permission" "spot_interruption" {
  statement_id  = "AllowEventBridgeSpotInterruption"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this["spot-interruption"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.spot_interruption.arn
}

# 2. インスタンス terminated → mc-lifecycle（残存ボリュームのスナップショット化）
resource "aws_cloudwatch_event_rule" "instance_terminated" {
  name        = "mc-instance-terminated"
  description = "EC2 instance terminated -> mc-lifecycle"

  event_pattern = jsonencode({
    source      = ["aws.ec2"]
    detail-type = ["EC2 Instance State-change Notification"]
    detail = {
      state = ["terminated"]
    }
  })
}

resource "aws_cloudwatch_event_target" "instance_terminated" {
  rule = aws_cloudwatch_event_rule.instance_terminated.name
  arn  = aws_lambda_function.this["lifecycle"].arn
}

resource "aws_lambda_permission" "instance_terminated" {
  statement_id  = "AllowEventBridgeInstanceTerminated"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this["lifecycle"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.instance_terminated.arn
}

# 3. スナップショット完了 → mc-lifecycle（ボリューム削除・世代整理）
resource "aws_cloudwatch_event_rule" "snapshot_completed" {
  name        = "mc-snapshot-completed"
  description = "EBS snapshot createSnapshot succeeded -> mc-lifecycle"

  event_pattern = jsonencode({
    source      = ["aws.ec2"]
    detail-type = ["EBS Snapshot Notification"]
    detail = {
      event  = ["createSnapshot"]
      result = ["succeeded"]
    }
  })
}

resource "aws_cloudwatch_event_target" "snapshot_completed" {
  rule = aws_cloudwatch_event_rule.snapshot_completed.name
  arn  = aws_lambda_function.this["lifecycle"].arn
}

resource "aws_lambda_permission" "snapshot_completed" {
  statement_id  = "AllowEventBridgeSnapshotCompleted"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this["lifecycle"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.snapshot_completed.arn
}

# ----------------------------------------------------------------------------
# SSM Parameters
#
# Terraform はプレースホルダで「枠」だけ作成し、実値は手動 / CLI /
# Packer（/mc/ami-id）で投入する。ignore_changes = [value] により
# 投入済みの実値を Terraform が巻き戻すことはない。
#
# 実値の投入例:
#   aws ssm put-parameter --name /mc/discord/bot-token \
#     --type SecureString --value '<token>' --overwrite
# ----------------------------------------------------------------------------

# Launch Template の "resolve:ssm:" は data_type = aws:ec2:image の
# パラメータしか参照できず、このタイプは実在する AMI ID しか書き込めない。
# 初期値には最新の AL2023 AMI を使う（Packer CI が実 AMI で上書きする）。
data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-${var.architecture}"]
  }

  lifecycle {
    # instance_types と AMI arch の不整合は /start 時まで発覚しないため plan で落とす
    precondition {
      condition = alltrue([
        for type in var.instance_types :
        can(regex("^[a-z]+\\d+g", type)) == (var.architecture == "arm64")
      ])
      error_message = "instance_types (${join(", ", var.instance_types)}) が architecture=${var.architecture} と整合しません。"
    }
  }
}

locals {
  ssm_parameters = {
    "ami-id" = {
      name        = "/mc/ami-id"
      type        = "String"
      data_type   = "aws:ec2:image"
      value       = data.aws_ami.al2023.id
      description = "Current Minecraft server AMI ID (updated by Packer CI)"
    }
    "discord-public-key" = {
      name        = "/mc/discord/public-key"
      type        = "String"
      value       = "placeholder"
      description = "Discord application public key (ed25519 signature verification)"
    }
    "discord-bot-token" = {
      name        = "/mc/discord/bot-token"
      type        = "SecureString"
      value       = "placeholder"
      description = "Discord bot token (slash command registration)"
    }
    "discord-webhook-url" = {
      name        = "/mc/discord/webhook-url"
      type        = "SecureString"
      value       = "placeholder"
      description = "Discord webhook URL for server notifications"
    }
    "rcon-password" = {
      name        = "/mc/rcon-password"
      type        = "SecureString"
      value       = "placeholder"
      description = "RCON password (localhost only)"
    }
  }
}

resource "aws_ssm_parameter" "this" {
  for_each = local.ssm_parameters

  name        = each.value.name
  type        = each.value.type
  data_type   = lookup(each.value, "data_type", null)
  value       = each.value.value
  description = each.value.description

  lifecycle {
    ignore_changes = [value]
  }
}
