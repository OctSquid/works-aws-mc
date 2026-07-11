# ローカルテスト環境。Packer (AMI) と同じ build-dist.sh / sync-dist.sh / server-config を通すことで
# 本番と同一のプロビジョニングを検証する。
# ビルド前に `npm run download` (tools/download-artifacts) で artifacts/ を生成しておくこと。
FROM amazonlinux:2023

# buildkit がホストの arch を自動設定する（server.json の本番 arch には従わない —
# エミュレーションだと JVM の JIT が不安定なため、ローカルは常にネイティブでテストする）
ARG TARGETARCH=amd64
ARG RCON_CLI_VERSION=1.6.11

# Minecraft 26.1+ は Java 25 以上が必要
RUN dnf install -y java-25-amazon-corretto-headless jq rsync tar gzip shadow-utils util-linux \
  && dnf clean all

RUN useradd -r -m -d /var/lib/minecraft -s /sbin/nologin minecraft

# rcon-cli (itzg) — watchdog / graceful stop の検証用
RUN mkdir -p /opt/minecraft/bin \
  && curl -sfL "https://github.com/itzg/rcon-cli/releases/download/${RCON_CLI_VERSION}/rcon-cli_${RCON_CLI_VERSION}_linux_${TARGETARCH}.tar.gz" \
  | tar -xz -C /tmp \
  && install -m 755 /tmp/rcon-cli /opt/minecraft/bin/rcon-cli

COPY server-config/scripts/ /opt/minecraft/bin/
RUN chmod +x /opt/minecraft/bin/*.sh

COPY artifacts/ /tmp/artifacts/
COPY server-config/ /tmp/server-config/
RUN /opt/minecraft/bin/build-dist.sh /tmp/artifacts /tmp/server-config /opt/minecraft-dist \
  && rm -rf /tmp/artifacts /tmp/server-config

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 25565/tcp 19132/udp
VOLUME /srv/minecraft

ENTRYPOINT ["/entrypoint.sh"]
