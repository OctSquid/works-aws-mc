# ローカルテスト環境。Packer (AMI) と同じ build-dist.sh / sync-dist.sh / server-config を通すことで
# 本番と同一のプロビジョニングを検証する。
# OS は Alpine (musl) のため AL2023 の完全再現ではないが、共有スクリプト
# (build-dist / sync-dist / render-config / mc-start) と Paper / Java 25 の検証は維持される。
# JVM は Temurin JRE 25（本番は Corretto 25 だが、同じ OpenJDK/HotSpot ビルドで挙動差は実質なし）。
# ビルド前に `npm run download` (tools/download-artifacts) で artifacts/ を生成しておくこと。

# ステージ 1: 配布物ツリーの組み立て（成果物は /opt に残し、素材レイヤはイメージに残さない）
FROM alpine:3.22 AS build

# buildkit がホストの arch を自動設定する（server.json の本番 arch には従わない —
# エミュレーションだと JVM の JIT が不安定なため、ローカルは常にネイティブでテストする）
ARG TARGETARCH
ARG RCON_CLI_VERSION=1.6.11

RUN apk add --no-cache bash curl

# rcon-cli (itzg) — watchdog / graceful stop の検証用
RUN mkdir -p /opt/minecraft/bin \
  && curl -sfL "https://github.com/itzg/rcon-cli/releases/download/${RCON_CLI_VERSION}/rcon-cli_${RCON_CLI_VERSION}_linux_${TARGETARCH}.tar.gz" \
  | tar -xz -C /tmp \
  && install -m 755 /tmp/rcon-cli /opt/minecraft/bin/rcon-cli

COPY server-config/scripts/ /opt/minecraft/bin/
RUN chmod +x /opt/minecraft/bin/*.sh

COPY artifacts/ /tmp/artifacts/
COPY server-config/ /tmp/server-config/
RUN /opt/minecraft/bin/build-dist.sh /tmp/artifacts /tmp/server-config /opt/minecraft-dist

# ステージ 2: ランタイム
# Minecraft 26.1+ は Java 25 以上が必要
FROM eclipse-temurin:25-jre-alpine

# runuser (util-linux) の代わりに su-exec で minecraft ユーザーに降格する
RUN apk add --no-cache bash jq rsync curl su-exec

RUN addgroup -S minecraft \
  && adduser -S -G minecraft -h /var/lib/minecraft -s /sbin/nologin minecraft \
  && install -d -o minecraft -g minecraft /var/lib/minecraft

COPY --from=build /opt/minecraft/bin /opt/minecraft/bin
COPY --from=build /opt/minecraft-dist /opt/minecraft-dist

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 25565/tcp 19132/udp
VOLUME /srv/minecraft

ENTRYPOINT ["/entrypoint.sh"]
