# ============================================================================
# dns: Route53 Hosted Zone
#
# 運用メモ:
#   Route53 コンソールでドメインを取得すると Hosted Zone が自動作成される。
#   その場合は新規作成せず、既存 zone をこのリソースに import する:
#
#     terraform import 'module.dns.aws_route53_zone.this' <ZONE_ID>
#
#   サーバーの A レコード（<subdomain>.<domain>, TTL 60）は Terraform では
#   管理しない。command-worker Lambda が起動時に UPSERT し、lifecycle
#   Lambda が terminate 時に削除する。
# ============================================================================

resource "aws_route53_zone" "this" {
  name    = var.domain_name
  comment = "Managed by terraform (mc-server)"
}
