packer {
  required_plugins {
    amazon = {
      source  = "github.com/hashicorp/amazon"
      version = ">= 1.3.0"
    }
  }
}

variable "region" {
  type    = string
  default = "ap-northeast-1"
}

# ============================================================================
# ベース AMI（mc-base-*）: AL2023 minimal + Java / SSM Agent / awscli / rcon-cli
#
# dnf トランザクション（特に Corretto と awscli）が AMI ビルド時間の支配項のため、
# 変化の少ない OS レイヤをここに焼き込み、日常の minecraft.pkr.hcl ビルドは
# ファイルコピーだけで済むよう二層化している。
# 再ビルドは ami-base-build.yml（workflow_dispatch / 月次 / このディレクトリの変更時）。
# ============================================================================

locals {
  timestamp = regex_replace(timestamp(), "[- TZ:]", "")

  # server.json が arch と rcon-cli バージョンの単一の真実の源
  server_spec      = jsondecode(file("${path.root}/../../server.json"))
  architecture     = local.server_spec.ec2.architecture
  rcon_cli_version = local.server_spec.tooling.rcon_cli_version

  build_instance_types = {
    arm64  = ["t4g.medium", "m6g.medium"]
    x86_64 = ["t3a.medium", "t3.medium"]
  }
}

source "amazon-ebs" "base" {
  region       = var.region
  ami_name     = "mc-base-${local.timestamp}"
  ssh_username = "ec2-user"

  source_ami_filter {
    filters = {
      # minimal AMI: SSM Agent / awscli は入っていないため install-base.sh で追加する
      name                = "al2023-ami-minimal-2023.*-${local.architecture}"
      root-device-type    = "ebs"
      virtualization-type = "hvm"
    }
    most_recent = true
    owners      = ["amazon"]
  }

  launch_block_device_mappings {
    device_name           = "/dev/xvda"
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }

  tags = {
    Project = "mc-server"
    Name    = "mc-base-${local.timestamp}"
  }
  snapshot_tags = {
    Project = "mc-server"
  }

  spot_price          = "auto"
  spot_instance_types = local.build_instance_types[local.architecture]
  fleet_tags = {
    Project = "mc-server"
  }
}

build {
  sources = ["source.amazon-ebs.base"]

  provisioner "shell" {
    environment_vars = ["RCON_CLI_VERSION=${local.rcon_cli_version}"]
    script           = "${path.root}/install-base.sh"
    # execute_command を上書きする場合、{{ .Vars }} を含めないと
    # environment_vars がスクリプトへ渡らない（sudo 昇格 + 環境変数注入）
    execute_command = "chmod +x '{{ .Path }}'; sudo -E sh -c '{{ .Vars }} bash {{ .Path }}'"
  }

  post-processor "manifest" {
    output     = "packer-manifest.json"
    strip_path = true
  }
}
