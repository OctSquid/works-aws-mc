# ============================================================================
# bootstrap: 手動で1回だけ apply する root モジュール
#
# - Terraform state 用 S3 バケット（envs/prod が backend として使用）
# - GitHub Actions OIDC プロバイダ
# - CI 用 IAM ロール: gha-terraform（terraform plan/apply 用）
#                     gha-packer   （AMI ビルド用）
#
# state はローカル管理（backend ブロックなし）。terraform.tfstate は
# リポジトリの .gitignore で除外済み。
# ============================================================================

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "mc-server"
      ManagedBy = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}

# ----------------------------------------------------------------------------
# Terraform state 用 S3 バケット
# ----------------------------------------------------------------------------

resource "aws_s3_bucket" "tf_state" {
  bucket = var.state_bucket_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ----------------------------------------------------------------------------
# GitHub Actions OIDC プロバイダ
# ----------------------------------------------------------------------------

data "tls_certificate" "github_actions" {
  url = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_openid_connect_provider" "github_actions" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.github_actions.certificates[0].sha1_fingerprint]
}

# 両ロール共通の AssumeRole（Web Identity）ポリシー。
# sub を "repo:<owner>/<repo>:*" に制限し、対象リポジトリ以外からの
# AssumeRole を拒否する。ブランチ/環境まで絞る場合は
# "repo:owner/repo:ref:refs/heads/main" のように変更する。
data "aws_iam_policy_document" "github_actions_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github_actions.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:*"]
    }
  }
}

# ----------------------------------------------------------------------------
# gha-terraform: GitHub Actions から terraform plan/apply するためのロール
# ----------------------------------------------------------------------------

resource "aws_iam_role" "gha_terraform" {
  name               = "gha-terraform"
  description        = "GitHub Actions role for terraform plan/apply (envs/prod)"
  assume_role_policy = data.aws_iam_policy_document.github_actions_assume.json
}

# IAM 以外は PowerUserAccess でカバーする（EC2/Lambda/DynamoDB/Route53/
# EventBridge/SSM/S3/Budgets/CloudWatch Logs 等）。
resource "aws_iam_role_policy_attachment" "gha_terraform_poweruser" {
  role       = aws_iam_role.gha_terraform.name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

# PowerUserAccess は IAM の書き込みを含まないため、envs/prod が作成する
# IAM リソースに限って権限を付与する。envs/prod 側の IAM ロール /
# インスタンスプロファイルはすべて "mc-" プレフィクスで命名する規約なので、
# リソース ARN を mc-* に限定することで、CI がそれ以外の IAM を
# 変更できないように絞っている（さらに絞るなら Permissions Boundary の
# 強制条件を追加する）。
data "aws_iam_policy_document" "gha_terraform_iam" {
  statement {
    sid = "IamRead"
    actions = [
      "iam:Get*",
      "iam:List*",
    ]
    resources = ["*"]
  }

  statement {
    sid = "IamManageMcRoles"
    actions = [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:UpdateRole",
      "iam:UpdateRoleDescription",
      "iam:UpdateAssumeRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:PassRole",
    ]
    resources = [
      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/mc-*",
    ]
  }

  statement {
    sid = "IamManageMcInstanceProfiles"
    actions = [
      "iam:CreateInstanceProfile",
      "iam:DeleteInstanceProfile",
      "iam:AddRoleToInstanceProfile",
      "iam:RemoveRoleFromInstanceProfile",
      "iam:TagInstanceProfile",
      "iam:UntagInstanceProfile",
    ]
    resources = [
      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:instance-profile/mc-*",
    ]
  }
}

resource "aws_iam_role_policy" "gha_terraform_iam" {
  name   = "iam-mc-prefix-only"
  role   = aws_iam_role.gha_terraform.id
  policy = data.aws_iam_policy_document.gha_terraform_iam.json
}

# ----------------------------------------------------------------------------
# gha-packer: GitHub Actions から Packer で AMI をビルドするためのロール
# ----------------------------------------------------------------------------

resource "aws_iam_role" "gha_packer" {
  name               = "gha-packer"
  description        = "GitHub Actions role for Packer AMI builds"
  assume_role_policy = data.aws_iam_policy_document.github_actions_assume.json
}

# Packer 公式ドキュメント記載の amazon-ebs ビルダー推奨権限セット。
# EC2 の性質上リソースレベル制限が難しい API が多いため "*" とする。
# AMI/スナップショットの世代整理（DeregisterImage/DeleteSnapshot）も
# このセットに含まれる。
data "aws_iam_policy_document" "gha_packer" {
  statement {
    sid = "PackerEC2"
    actions = [
      "ec2:AttachVolume",
      "ec2:AuthorizeSecurityGroupIngress",
      "ec2:CopyImage",
      "ec2:CreateImage",
      "ec2:CreateKeyPair",
      "ec2:CreateSecurityGroup",
      "ec2:CreateSnapshot",
      "ec2:CreateTags",
      "ec2:CreateVolume",
      "ec2:DeleteKeyPair",
      "ec2:DeleteSecurityGroup",
      "ec2:DeleteSnapshot",
      "ec2:DeleteVolume",
      "ec2:DeregisterImage",
      "ec2:DescribeImageAttribute",
      "ec2:DescribeImages",
      "ec2:DescribeInstances",
      "ec2:DescribeInstanceStatus",
      "ec2:DescribeRegions",
      "ec2:DescribeSecurityGroups",
      "ec2:DescribeSnapshots",
      "ec2:DescribeSubnets",
      "ec2:DescribeTags",
      "ec2:DescribeVolumes",
      "ec2:DetachVolume",
      "ec2:GetPasswordData",
      "ec2:ModifyImageAttribute",
      "ec2:ModifyInstanceAttribute",
      "ec2:ModifySnapshotAttribute",
      "ec2:RegisterImage",
      "ec2:RunInstances",
      "ec2:StopInstances",
      "ec2:TerminateInstances",
    ]
    resources = ["*"]
  }

  # ビルド完了後に /mc/ami-id を新 AMI ID へ更新する
  statement {
    sid = "PublishAmiId"
    actions = [
      "ssm:PutParameter",
      "ssm:GetParameter",
    ]
    resources = [
      "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter/mc/ami-id",
    ]
  }

  # ビルドインスタンスにインスタンスプロファイルを付ける場合に必要
  # （SSM communicator 利用時など。不要なら削除してよい）
  statement {
    sid       = "PassBuildRole"
    actions   = ["iam:PassRole", "iam:GetInstanceProfile"]
    resources = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/mc-*"]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "gha_packer" {
  name   = "packer-ami-build"
  role   = aws_iam_role.gha_packer.id
  policy = data.aws_iam_policy_document.gha_packer.json
}
