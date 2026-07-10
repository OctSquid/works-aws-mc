# ============================================================================
# server: Launch Template + EC2 用 IAM ロール / インスタンスプロファイル
#
# 起動そのものは command-worker Lambda が RunInstances で行う。
# Launch Template には以下を「あえて書かない」:
#   - instance_market_options : スポット指定は worker が RunInstances 時に
#       InstanceMarketOptions で毎回付与する。LT に焼き込むと明示オプション
#       （/start ondemand:true）でのオンデマンドフォールバックができなくなる
#   - データボリュームの BDM  : 復元元スナップショット ID が毎回変わるため
#       worker が RunInstances 時に上書きする（DeleteOnTermination=false,
#       タグ mc:data=true を worker 側で必ず指定する）
# ============================================================================

data "aws_caller_identity" "current" {}

# SecureString パラメータの復号に使う AWS マネージドキー
data "aws_kms_alias" "ssm" {
  name = "alias/aws/ssm"
}

# ----------------------------------------------------------------------------
# EC2 用 IAM ロール（"mc-" プレフィクス必須: bootstrap の gha-terraform が
# mc-* のみ IAM 操作可能なため）
# ----------------------------------------------------------------------------

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ec2" {
  name               = "${var.name}-ec2"
  description        = "Minecraft server EC2 instance role"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

# SSM Agent（RunCommand / Session Manager）用
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "ec2_inline" {
  # idle-watchdog 等が自インスタンスへ mc:stop-reason タグを付ける。
  # タグ条件 ec2:ResourceTag/mc:role=server で「mc:role=server タグを持つ
  # インスタンス」に限定（このタグは Launch Template の tag_specifications
  # で全インスタンスに付与される）。
  statement {
    sid     = "TagOwnInstances"
    actions = ["ec2:CreateTags"]
    resources = [
      "arn:aws:ec2:${var.region}:${data.aws_caller_identity.current.account_id}:instance/*",
    ]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/mc:role"
      values   = ["server"]
    }
  }

  # Describe 系はリソースレベル制限非対応
  statement {
    sid = "DescribeInstances"
    actions = [
      "ec2:DescribeInstances",
      "ec2:DescribeTags",
    ]
    resources = ["*"]
  }

  # 初回起動時に Webhook URL / RCON パスワードを埋め込むための読み取り
  statement {
    sid     = "ReadRuntimeSecrets"
    actions = ["ssm:GetParameter"]
    resources = [
      "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter/mc/discord/webhook-url",
      "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter/mc/rcon-password",
    ]
  }

  # SecureString の復号（aws/ssm マネージドキー）
  statement {
    sid       = "DecryptSsmSecureString"
    actions   = ["kms:Decrypt"]
    resources = [data.aws_kms_alias.ssm.target_key_arn]
  }
}

resource "aws_iam_role_policy" "ec2_inline" {
  name   = "mc-server-runtime"
  role   = aws_iam_role.ec2.id
  policy = data.aws_iam_policy_document.ec2_inline.json
}

resource "aws_iam_instance_profile" "ec2" {
  name = "${var.name}-ec2"
  role = aws_iam_role.ec2.name
}

# ----------------------------------------------------------------------------
# Launch Template
# ----------------------------------------------------------------------------

resource "aws_launch_template" "mc_server" {
  name        = var.name
  description = "Minecraft server (launched on demand by mc-command-worker)"

  # AMI は Packer が更新する SSM パラメータから起動時に解決する。
  # AMI 更新のたびに terraform apply は不要。
  image_id = "resolve:ssm:${var.ami_ssm_parameter}"

  # デフォルト値。worker が RunInstances 時にスポット価格の安い順で上書きする
  instance_type = var.default_instance_type

  vpc_security_group_ids = [var.security_group_id]

  iam_instance_profile {
    arn = aws_iam_instance_profile.ec2.arn
  }

  # idle-watchdog の poweroff で terminate させる（stop で EBS 課金を
  # 残さない。データはスナップショット経由で永続化）
  instance_initiated_shutdown_behavior = "terminate"

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required" # IMDSv2 必須
  }

  # ルートボリューム（AL2023 のルートデバイス）。データ用ボリュームは
  # ここには定義しない（モジュール先頭のコメント参照）
  block_device_mappings {
    device_name = "/dev/xvda"

    ebs {
      volume_size           = var.root_volume_size_gb
      volume_type           = "gp3"
      delete_on_termination = true
    }
  }

  # mc:role=server は IAM のタグ条件（EC2 ロールの CreateTags、Lambda の
  # SSM SendCommand 先の限定）で使用する
  tag_specifications {
    resource_type = "instance"

    tags = {
      Name      = var.name
      "mc:role" = "server"
    }
  }

  tag_specifications {
    resource_type = "volume"

    tags = {
      Name = "${var.name}-root"
    }
  }

  update_default_version = true
}
