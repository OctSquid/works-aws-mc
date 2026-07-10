output "state_bucket_name" {
  description = "Terraform state 用 S3 バケット名（envs/prod の -backend-config に渡す）"
  value       = aws_s3_bucket.tf_state.bucket
}

output "state_bucket_arn" {
  description = "Terraform state 用 S3 バケットの ARN"
  value       = aws_s3_bucket.tf_state.arn
}

output "github_oidc_provider_arn" {
  description = "GitHub Actions OIDC プロバイダの ARN"
  value       = aws_iam_openid_connect_provider.github_actions.arn
}

output "gha_terraform_role_arn" {
  description = "GitHub Actions（terraform plan/apply）が Assume するロール ARN"
  value       = aws_iam_role.gha_terraform.arn
}

output "gha_packer_role_arn" {
  description = "GitHub Actions（Packer AMI ビルド）が Assume するロール ARN"
  value       = aws_iam_role.gha_packer.arn
}
