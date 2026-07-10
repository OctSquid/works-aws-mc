output "zone_id" {
  description = "Hosted Zone ID"
  value       = aws_route53_zone.this.zone_id
}

output "name_servers" {
  description = "Hosted Zone のネームサーバ一覧"
  value       = aws_route53_zone.this.name_servers
}

output "zone_arn" {
  description = "Hosted Zone の ARN"
  value       = aws_route53_zone.this.arn
}
