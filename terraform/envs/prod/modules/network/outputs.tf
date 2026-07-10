output "vpc_id" {
  description = "VPC ID"
  value       = aws_vpc.this.id
}

output "subnet_ids" {
  description = "パブリックサブネット ID のリスト（AZ 順）"
  value       = aws_subnet.public[*].id
}

output "security_group_id" {
  description = "Minecraft サーバー用セキュリティグループ ID"
  value       = aws_security_group.mc_server.id
}
