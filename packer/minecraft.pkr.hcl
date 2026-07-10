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

# m7a (x86_64) 向け AMI のため、ビルドも安価な x86_64 インスタンスで行う
variable "build_instance_type" {
  type    = string
  default = "t3a.medium"
}

variable "rcon_cli_version" {
  type    = string
  default = "1.6.11"
}

locals {
  timestamp = regex_replace(timestamp(), "[- TZ:]", "")
}

source "amazon-ebs" "minecraft" {
  region       = var.region
  ami_name     = "mc-server-${local.timestamp}"
  ssh_username = "ec2-user"

  source_ami_filter {
    filters = {
      name                = "al2023-ami-2023.*-x86_64"
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
    Name    = "mc-server-${local.timestamp}"
  }
  snapshot_tags = {
    Project = "mc-server"
  }

  # ビルド用スポットで AMI ビルド費も削減
  spot_price          = "auto"
  spot_instance_types = [var.build_instance_type, "t3.medium"]
  fleet_tags = {
    Project = "mc-server"
  }
}

build {
  sources = ["source.amazon-ebs.minecraft"]

  # 事前に tools/download-artifacts で生成した artifacts/ と server-config/ をアップロード
  provisioner "file" {
    source      = "${path.root}/provision/artifacts"
    destination = "/tmp/artifacts"
  }

  provisioner "file" {
    source      = "${path.root}/../server-config"
    destination = "/tmp/server-config"
  }

  provisioner "shell" {
    environment_vars = ["RCON_CLI_VERSION=${var.rcon_cli_version}"]
    script           = "${path.root}/provision/install.sh"
    execute_command  = "sudo -E bash '{{ .Path }}'"
  }

  # CI が AMI ID を取り出して SSM /mc/ami-id を更新するための出力
  post-processor "manifest" {
    output     = "packer-manifest.json"
    strip_path = true
  }
}
