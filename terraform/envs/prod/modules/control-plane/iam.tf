# ============================================================================
# Lambda 用 IAM（関数ごとに最小権限のロールを分離）
#
# ロール名はすべて "mc-" プレフィクス（bootstrap の gha-terraform が
# mc-* のみ IAM 操作可能なため）。
# ============================================================================

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  for_each = local.functions

  name               = "mc-lambda-${each.key}"
  description        = "Execution role for ${each.value.name}"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

# CloudWatch Logs への書き込み（全関数共通）
resource "aws_iam_role_policy_attachment" "lambda_logs" {
  for_each = local.functions

  role       = aws_iam_role.lambda[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# 非同期 Invoke の on_failure destination（alerting.tf）への発行権限。
# destination への送信は各関数の実行ロールで行われる
data "aws_iam_policy_document" "publish_ops_alerts" {
  statement {
    sid       = "PublishOpsAlerts"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.ops_alerts.arn]
  }
}

resource "aws_iam_role_policy" "publish_ops_alerts" {
  for_each = toset(["command-worker", "lifecycle", "spot-interruption"])

  name   = "mc-${each.key}-ops-alerts"
  role   = aws_iam_role.lambda[each.key].id
  policy = data.aws_iam_policy_document.publish_ops_alerts.json
}

# ----------------------------------------------------------------------------
# mc-interactions: 署名検証と worker の async Invoke のみ
# ----------------------------------------------------------------------------

data "aws_iam_policy_document" "interactions" {
  statement {
    sid     = "InvokeWorker"
    actions = ["lambda:InvokeFunction"]
    resources = [
      "arn:aws:lambda:${var.region}:${local.account_id}:function:${local.functions["command-worker"].name}",
    ]
  }

  statement {
    sid     = "ReadDiscordPublicKey"
    actions = ["ssm:GetParameter"]
    resources = [
      "arn:aws:ssm:${var.region}:${local.account_id}:parameter/mc/discord/public-key",
    ]
  }
}

resource "aws_iam_role_policy" "interactions" {
  name   = "mc-interactions"
  role   = aws_iam_role.lambda["interactions"].id
  policy = data.aws_iam_policy_document.interactions.json
}

# ----------------------------------------------------------------------------
# mc-command-worker: 起動・停止の実処理
# ----------------------------------------------------------------------------

data "aws_iam_policy_document" "command_worker" {
  # Describe 系はリソースレベル制限非対応のため "*"
  # （DescribeSpotPriceHistory による安い AZ×タイプの選択を含む）
  statement {
    sid       = "Ec2Describe"
    actions   = ["ec2:Describe*"]
    resources = ["*"]
  }

  # RunInstances: インスタンス ARN には ec2:InstanceType 条件を付け、
  # server.json 由来の設定タイプ以外を起動できないようにする
  # （ロール漏洩時に高額インスタンスを起動されるリスクの遮断）
  statement {
    sid       = "Ec2RunInstancesTypeRestricted"
    actions   = ["ec2:RunInstances"]
    resources = ["arn:aws:ec2:${var.region}:${local.account_id}:instance/*"]

    condition {
      test     = "StringEquals"
      variable = "ec2:InstanceType"
      values   = var.instance_types
    }
  }

  # RunInstances が同時に触る付随リソース（AMI / サブネット / SG / ボリューム /
  # ENI / Launch Template / スポットリクエスト）。これらに InstanceType 条件は
  # 適用できないためリソース種別で限定する
  statement {
    sid     = "Ec2RunInstancesResources"
    actions = ["ec2:RunInstances"]
    resources = [
      "arn:aws:ec2:${var.region}:${local.account_id}:volume/*",
      "arn:aws:ec2:${var.region}:${local.account_id}:network-interface/*",
      "arn:aws:ec2:${var.region}:${local.account_id}:subnet/*",
      "arn:aws:ec2:${var.region}:${local.account_id}:security-group/*",
      "arn:aws:ec2:${var.region}:${local.account_id}:launch-template/*",
      "arn:aws:ec2:${var.region}:${local.account_id}:spot-instances-request/*",
      "arn:aws:ec2:${var.region}::image/*",
      "arn:aws:ec2:${var.region}::snapshot/*",
    ]
  }

  # タグ付け対象はインスタンス（LT の TagSpecifications / mc:stop-reason）と
  # データボリューム（mc:data）のみ
  statement {
    sid     = "Ec2CreateTags"
    actions = ["ec2:CreateTags"]
    resources = [
      "arn:aws:ec2:${var.region}:${local.account_id}:instance/*",
      "arn:aws:ec2:${var.region}:${local.account_id}:volume/*",
      "arn:aws:ec2:${var.region}:${local.account_id}:spot-instances-request/*",
    ]
  }

  # terminate は mc:role=server タグ付きインスタンスに限定
  statement {
    sid     = "Ec2Terminate"
    actions = ["ec2:TerminateInstances"]
    resources = [
      "arn:aws:ec2:${var.region}:${local.account_id}:instance/*",
    ]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/mc:role"
      values   = ["server"]
    }
  }

  # Launch Template のインスタンスプロファイルを渡すのは EC2 に対してのみ
  statement {
    sid       = "PassEc2Role"
    actions   = ["iam:PassRole"]
    resources = [var.ec2_instance_role_arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ec2.amazonaws.com"]
    }
  }

  # 起動後の A レコード UPSERT（対象 zone のみ）
  statement {
    sid = "Route53Upsert"
    actions = [
      "route53:ChangeResourceRecordSets",
      "route53:ListResourceRecordSets",
    ]
    resources = [local.zone_arn]
  }

  # 状態機械（条件付き更新による排他制御）
  statement {
    sid = "StateTable"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:ConditionCheckItem",
    ]
    resources = [aws_dynamodb_table.state.arn]
  }

  # /stop: RCON 告知 → save-all → stop → poweroff を RunCommand で実行。
  # ドキュメントは AWS-RunShellScript、対象は mc:role=server タグ付き
  # インスタンスに限定
  statement {
    sid       = "SsmSendCommandDocument"
    actions   = ["ssm:SendCommand"]
    resources = ["arn:aws:ssm:${var.region}::document/AWS-RunShellScript"]
  }

  statement {
    sid     = "SsmSendCommandInstances"
    actions = ["ssm:SendCommand"]
    resources = [
      "arn:aws:ec2:${var.region}:${local.account_id}:instance/*",
    ]

    condition {
      test     = "StringEquals"
      variable = "ssm:resourceTag/mc:role"
      values   = ["server"]
    }
  }

  # GetCommandInvocation はリソースレベル制限非対応
  statement {
    sid       = "SsmCommandResult"
    actions   = ["ssm:GetCommandInvocation"]
    resources = ["*"]
  }

  statement {
    sid = "ReadMcParameters"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
    ]
    resources = [
      "arn:aws:ssm:${var.region}:${local.account_id}:parameter/mc/*",
    ]
  }

  statement {
    sid       = "DecryptSsmSecureString"
    actions   = ["kms:Decrypt"]
    resources = [data.aws_kms_alias.ssm.target_key_arn]
  }
}

resource "aws_iam_role_policy" "command_worker" {
  name   = "mc-command-worker"
  role   = aws_iam_role.lambda["command-worker"].id
  policy = data.aws_iam_policy_document.command_worker.json
}

# ----------------------------------------------------------------------------
# mc-lifecycle: terminated 後のスナップショット化とボリューム/世代整理
# ----------------------------------------------------------------------------

data "aws_iam_policy_document" "lifecycle" {
  statement {
    sid = "Ec2Describe"
    actions = [
      "ec2:DescribeVolumes",
      "ec2:DescribeSnapshots",
      "ec2:DescribeInstances",
    ]
    resources = ["*"]
  }

  # CreateSnapshot: 対象ボリュームは mc:data=true 付きのみ、生成される
  # スナップショットには mc:data=true タグの付与を必須にする
  statement {
    sid       = "SnapshotCreateFromDataVolume"
    actions   = ["ec2:CreateSnapshot"]
    resources = ["arn:aws:ec2:${var.region}:${local.account_id}:volume/*"]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/mc:data"
      values   = ["true"]
    }
  }

  statement {
    sid       = "SnapshotCreateTagged"
    actions   = ["ec2:CreateSnapshot"]
    resources = ["arn:aws:ec2:${var.region}::snapshot/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/mc:data"
      values   = ["true"]
    }
  }

  # CreateSnapshot の TagSpecifications 用（作成時のみタグ付け可）
  statement {
    sid       = "TagOnSnapshotCreate"
    actions   = ["ec2:CreateTags"]
    resources = ["arn:aws:ec2:${var.region}::snapshot/*"]

    condition {
      test     = "StringEquals"
      variable = "ec2:CreateAction"
      values   = ["CreateSnapshot"]
    }
  }

  # 削除は mc:data=true タグ付きリソースに限定する。タグ付け漏れの
  # ボリュームは削除に失敗して残るが、失敗は on_failure destination /
  # エラーアラーム（alerting.tf）で通知されるため、無差別削除権限より安全
  statement {
    sid = "DeleteDataVolumeAndSnapshots"
    actions = [
      "ec2:DeleteVolume",
      "ec2:DeleteSnapshot",
    ]
    resources = [
      "arn:aws:ec2:${var.region}:${local.account_id}:volume/*",
      "arn:aws:ec2:${var.region}::snapshot/*",
    ]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/mc:data"
      values   = ["true"]
    }
  }

  # watchdog tick の強制停止経路: mc:stop-reason タグ付与と terminate
  # （いずれも mc:role=server タグ付きインスタンス限定）
  statement {
    sid       = "TagStopReason"
    actions   = ["ec2:CreateTags"]
    resources = ["arn:aws:ec2:${var.region}:${local.account_id}:instance/*"]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/mc:role"
      values   = ["server"]
    }
  }

  statement {
    sid       = "Ec2Terminate"
    actions   = ["ec2:TerminateInstances"]
    resources = ["arn:aws:ec2:${var.region}:${local.account_id}:instance/*"]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/mc:role"
      values   = ["server"]
    }
  }

  # watchdog tick の graceful shutdown（mc-shutdown.sh max-runtime）
  statement {
    sid       = "SsmSendCommandDocument"
    actions   = ["ssm:SendCommand"]
    resources = ["arn:aws:ssm:${var.region}::document/AWS-RunShellScript"]
  }

  statement {
    sid       = "SsmSendCommandInstances"
    actions   = ["ssm:SendCommand"]
    resources = ["arn:aws:ec2:${var.region}:${local.account_id}:instance/*"]

    condition {
      test     = "StringEquals"
      variable = "ssm:resourceTag/mc:role"
      values   = ["server"]
    }
  }

  # terminate 後の A レコード削除
  statement {
    sid = "Route53Delete"
    actions = [
      "route53:ChangeResourceRecordSets",
      "route53:ListResourceRecordSets",
    ]
    resources = [local.zone_arn]
  }

  statement {
    sid = "StateTable"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:ConditionCheckItem",
    ]
    resources = [aws_dynamodb_table.state.arn]
  }

  # 停止理由付きの Discord 通知
  statement {
    sid     = "ReadWebhookUrl"
    actions = ["ssm:GetParameter"]
    resources = [
      "arn:aws:ssm:${var.region}:${local.account_id}:parameter/mc/discord/webhook-url",
    ]
  }

  statement {
    sid       = "DecryptSsmSecureString"
    actions   = ["kms:Decrypt"]
    resources = [data.aws_kms_alias.ssm.target_key_arn]
  }
}

resource "aws_iam_role_policy" "lifecycle" {
  name   = "mc-lifecycle"
  role   = aws_iam_role.lambda["lifecycle"].id
  policy = data.aws_iam_policy_document.lifecycle.json
}

# ----------------------------------------------------------------------------
# mc-spot-interruption: 中断警告時の告知・save-all・タグ付け
# ----------------------------------------------------------------------------

data "aws_iam_policy_document" "spot_interruption" {
  statement {
    sid       = "Ec2Describe"
    actions   = ["ec2:DescribeInstances"]
    resources = ["*"]
  }

  # mc:stop-reason=spot タグの付与（mc:role=server タグ付きインスタンス限定）
  statement {
    sid     = "TagStopReason"
    actions = ["ec2:CreateTags"]
    resources = [
      "arn:aws:ec2:${var.region}:${local.account_id}:instance/*",
    ]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/mc:role"
      values   = ["server"]
    }
  }

  # RCON でのゲーム内告知 + save-all
  statement {
    sid       = "SsmSendCommandDocument"
    actions   = ["ssm:SendCommand"]
    resources = ["arn:aws:ssm:${var.region}::document/AWS-RunShellScript"]
  }

  statement {
    sid     = "SsmSendCommandInstances"
    actions = ["ssm:SendCommand"]
    resources = [
      "arn:aws:ec2:${var.region}:${local.account_id}:instance/*",
    ]

    condition {
      test     = "StringEquals"
      variable = "ssm:resourceTag/mc:role"
      values   = ["server"]
    }
  }

  # 状態の参照のみ（更新は lifecycle が行う）
  statement {
    sid = "StateTableRead"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:Query",
    ]
    resources = [aws_dynamodb_table.state.arn]
  }

  statement {
    sid     = "ReadWebhookUrl"
    actions = ["ssm:GetParameter"]
    resources = [
      "arn:aws:ssm:${var.region}:${local.account_id}:parameter/mc/discord/webhook-url",
    ]
  }

  statement {
    sid       = "DecryptSsmSecureString"
    actions   = ["kms:Decrypt"]
    resources = [data.aws_kms_alias.ssm.target_key_arn]
  }
}

resource "aws_iam_role_policy" "spot_interruption" {
  name   = "mc-spot-interruption"
  role   = aws_iam_role.lambda["spot-interruption"].id
  policy = data.aws_iam_policy_document.spot_interruption.json
}
