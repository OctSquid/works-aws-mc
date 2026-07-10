# ============================================================================
# envs/prod: オンデマンド Minecraft サーバー基盤
#
# タグ運用メモ（Lambda / インスタンス側との取り決め。Terraform 管理外）:
#   - mc:role=server    : Launch Template の tag_specifications で付与。
#                         IAM のタグ条件（SSM SendCommand 先の限定等）に使用
#   - mc:stop-reason    : 停止理由（idle / manual / spot）。watchdog や
#                         spot-interruption Lambda がインスタンスに付与し、
#                         lifecycle Lambda が Discord 通知の文言分岐に使用
#   - mc:data=true      : データ用 EBS ボリューム。command-worker が起動後に
#                         CreateTags で付与し（ルートボリュームへの誤付与を
#                         避けるため TagSpecifications は使わない）、
#                         lifecycle Lambda がスナップショット対象の特定に使用
# ============================================================================

locals {
  server_fqdn = "${var.subdomain}.${var.domain_name}"

  # Lambda のビルド成果物ディレクトリ（リポジトリルートの lambda/dist/）。
  # path.root = terraform/envs/prod なので 3 階層上がリポジトリルート。
  # dist が未ビルドでも validate は通る（plan/apply には事前ビルドが必要）。
  lambda_dist_dir = "${path.root}/../../../lambda/dist"
}

module "network" {
  source = "./modules/network"
}

module "dns" {
  source = "./modules/dns"

  domain_name = var.domain_name
}

module "server" {
  source = "./modules/server"

  region                = var.region
  security_group_id     = module.network.security_group_id
  default_instance_type = var.instance_types[0]
}

module "control_plane" {
  source = "./modules/control-plane"

  region                = var.region
  launch_template_id    = module.server.launch_template_id
  subnet_ids            = module.network.subnet_ids
  hosted_zone_id        = module.dns.zone_id
  server_fqdn           = local.server_fqdn
  instance_types        = var.instance_types
  data_volume_size_gb   = var.data_volume_size_gb
  snapshot_retention    = var.snapshot_retention
  ec2_instance_role_arn = module.server.instance_role_arn
  lambda_dist_dir       = local.lambda_dist_dir
}

module "ops" {
  source = "./modules/ops"

  budget_limit_usd = var.budget_limit_usd
  budget_email     = var.budget_email
}
