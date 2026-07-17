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

locals {
  timestamp = regex_replace(timestamp(), "[- TZ:]", "")

  # server.json が AMI アーキテクチャの単一の真実の源
  # （Terraform / Docker / packer/base も同じファイルを読む）
  server_spec  = jsondecode(file("${path.root}/../server.json"))
  architecture = local.server_spec.ec2.architecture

  # ビルドは本番と同一 arch の安価なスポットインスタンスで行う
  build_instance_types = {
    arm64  = ["t4g.medium", "m6g.medium"]
    x86_64 = ["t3a.medium", "t3.medium"]
  }
}

source "amazon-ebs" "minecraft" {
  region       = var.region
  ami_name     = "mc-server-${local.timestamp}"
  ssh_username = "ec2-user"

  source_ami_filter {
    filters = {
      # ベース AMI（packer/base: AL2023 minimal + Java / SSM Agent / awscli /
      # rcon-cli 焼き込み済み）。dnf を日常ビルドから排除してビルド時間を短縮する。
      # 存在しない場合は先に ami-base-build.yml を実行すること
      name                = "mc-base-*"
      root-device-type    = "ebs"
      virtualization-type = "hvm"
    }
    most_recent = true
    owners      = ["self"]
  }

  launch_block_device_mappings {
    device_name           = "/dev/xvda"
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }

  tags = {
    Project = "mc-server"
    Name    = "mc-server-${local.timestamp}"
  }
  snapshot_tags = {
    Project = "mc-server"
  }

  # ビルド用スポットで AMI ビルド費も削減
  spot_price          = "auto"
  spot_instance_types = local.build_instance_types[local.architecture]
  fleet_tags = {
    Project = "mc-server"
  }
}

build {
  sources = ["source.amazon-ebs.minecraft"]

  # 事前に tools/download-artifacts で生成した artifacts/（リポジトリルート。
  # Docker と共通）と server/ をアップロード
  provisioner "file" {
    source      = "${path.root}/../artifacts"
    destination = "/tmp/artifacts"
  }

  provisioner "file" {
    source      = "${path.root}/../server"
    destination = "/tmp/server"
  }

  provisioner "shell" {
    script          = "${path.root}/provision/install.sh"
    execute_command = "sudo -E bash '{{ .Path }}'"
  }

  # CI が AMI ID を取り出して SSM /mc/ami-id を更新するための出力
  post-processor "manifest" {
    output     = "packer-manifest.json"
    strip_path = true
  }
}
