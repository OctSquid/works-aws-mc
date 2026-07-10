output "launch_template_id" {
  description = "Launch Template ID"
  value       = aws_launch_template.mc_server.id
}

output "instance_profile_arn" {
  description = "EC2 インスタンスプロファイルの ARN"
  value       = aws_iam_instance_profile.ec2.arn
}

output "instance_role_arn" {
  description = "EC2 用 IAM ロールの ARN（command-worker の iam:PassRole 対象）"
  value       = aws_iam_role.ec2.arn
}

output "instance_role_name" {
  description = "EC2 用 IAM ロール名"
  value       = aws_iam_role.ec2.name
}
