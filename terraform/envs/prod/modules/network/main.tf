# ============================================================================
# network: VPC + パブリックサブネット×3AZ + IGW
#
# NAT Gateway / EIP は作らない（最大のコスト要因を回避）。
# インスタンスはパブリックサブネットでパブリック IP を自動付与し、
# Route53 の A レコードを command-worker が毎回 UPSERT する。
# ============================================================================

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = var.name
  }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = var.name
  }
}

resource "aws_subnet" "public" {
  count = var.az_count

  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name = "${var.name}-public-${data.aws_availability_zones.available.names[count.index]}"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${var.name}-public"
  }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count = var.az_count

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# ----------------------------------------------------------------------------
# セキュリティグループ
# 開けるのは Minecraft の 25565/tcp (Java) と 19132/udp (Bedrock) のみ。
# RCON(25575) は localhost 完結、SSH は使わず SSM Session Manager を利用
# するため、どちらも開放しない。
# ----------------------------------------------------------------------------

resource "aws_security_group" "mc_server" {
  name        = var.name
  description = "Minecraft server (Java 25565/tcp, Bedrock 19132/udp). No RCON/SSH."
  vpc_id      = aws_vpc.this.id

  tags = {
    Name = var.name
  }
}

resource "aws_vpc_security_group_ingress_rule" "java_ipv4" {
  security_group_id = aws_security_group.mc_server.id
  description       = "Minecraft Java Edition"
  ip_protocol       = "tcp"
  from_port         = 25565
  to_port           = 25565
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "java_ipv6" {
  security_group_id = aws_security_group.mc_server.id
  description       = "Minecraft Java Edition"
  ip_protocol       = "tcp"
  from_port         = 25565
  to_port           = 25565
  cidr_ipv6         = "::/0"
}

resource "aws_vpc_security_group_ingress_rule" "bedrock_ipv4" {
  security_group_id = aws_security_group.mc_server.id
  description       = "Minecraft Bedrock Edition (GeyserMC)"
  ip_protocol       = "udp"
  from_port         = 19132
  to_port           = 19132
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "bedrock_ipv6" {
  security_group_id = aws_security_group.mc_server.id
  description       = "Minecraft Bedrock Edition (GeyserMC)"
  ip_protocol       = "udp"
  from_port         = 19132
  to_port           = 19132
  cidr_ipv6         = "::/0"
}

resource "aws_vpc_security_group_egress_rule" "all_ipv4" {
  security_group_id = aws_security_group.mc_server.id
  description       = "Allow all outbound"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "all_ipv6" {
  security_group_id = aws_security_group.mc_server.id
  description       = "Allow all outbound"
  ip_protocol       = "-1"
  cidr_ipv6         = "::/0"
}
