output "function_url" {
  description = "Discord の Interactions Endpoint URL に設定する Lambda Function URL"
  value       = module.control_plane.function_url
}

output "zone_id" {
  description = "Route53 Hosted Zone ID"
  value       = module.dns.zone_id
}

output "zone_name_servers" {
  description = "Hosted Zone のネームサーバ（レジストラ側に設定する。Route53 でドメイン取得した場合は自動設定済み）"
  value       = module.dns.name_servers
}

output "server_fqdn" {
  description = "Minecraft サーバーの接続先 FQDN"
  value       = local.server_fqdn
}

output "launch_template_id" {
  description = "Minecraft サーバー用 Launch Template ID"
  value       = module.server.launch_template_id
}

output "lambda_function_names" {
  description = "作成した Lambda 関数名の一覧"
  value       = module.control_plane.lambda_function_names
}

output "vpc_id" {
  description = "VPC ID"
  value       = module.network.vpc_id
}

output "subnet_ids" {
  description = "パブリックサブネット ID（3AZ）"
  value       = module.network.subnet_ids
}

output "security_group_id" {
  description = "Minecraft サーバー用セキュリティグループ ID"
  value       = module.network.security_group_id
}

output "dynamodb_table_name" {
  description = "状態管理用 DynamoDB テーブル名"
  value       = module.control_plane.dynamodb_table_name
}
