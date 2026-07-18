/**
 * /health — プレイヤー数 / TPS / CPU / メモリ / ディスクを SSM 1 往復で取得して表示。
 * CloudWatch Agent は導入していないため、インスタンス上で直接収集する。
 */
import { editOriginalResponse } from "../shared/discord";
import { healthEmbed, healthUnavailableMessage } from "../shared/messages";
import { runShellCommandWithOutput } from "../shared/ssm";
import { getServerRecord } from "../shared/state";
import type { InteractionContext } from "../shared/types";
import { RCON_SH, stripColorCodes } from "./rcon";

// セクションマーカーで区切って 1 コマンドにまとめる（固定文字列のみ・ユーザー入力なし）。
// rcon は minecraft 停止直後に失敗し得るため || true で他セクションを守る。
const HEALTH_SCRIPT = [
  `echo '===PLAYERS==='; ${RCON_SH} list || true`,
  `echo '===TPS==='; ${RCON_SH} tps || true`,
  `echo '===LOAD==='; echo "$(cat /proc/loadavg | cut -d' ' -f1-3) / $(nproc) cores"`,
  `echo '===MEM==='; free -m | awk 'NR==2 {printf "%d / %d MB (%.0f%%)\\n", $3, $2, $3*100/$2}'`,
  `echo '===DISK==='; df -h /srv/minecraft | awk 'NR==2 {printf "%s / %s (%s)\\n", $3, $2, $5}'`,
];

export interface HealthSections {
  players?: string | undefined;
  tps?: string | undefined;
  load?: string | undefined;
  memory?: string | undefined;
  disk?: string | undefined;
}

const SECTION_KEYS: Record<string, keyof HealthSections> = {
  PLAYERS: "players",
  TPS: "tps",
  LOAD: "load",
  MEM: "memory",
  DISK: "disk",
};

/** マーカー区切りの stdout を各セクションへ分解する（純関数） */
export function parseHealthOutput(stdout: string): HealthSections {
  const sections: HealthSections = {};
  let currentKey: keyof HealthSections | undefined;
  let buffer: string[] = [];
  const flush = () => {
    if (currentKey) {
      const text = buffer.join("\n").trim();
      if (text) sections[currentKey] = text;
    }
    buffer = [];
  };
  for (const line of stripColorCodes(stdout).split("\n")) {
    const marker = /^===([A-Z]+)===$/.exec(line.trim());
    if (marker?.[1] && SECTION_KEYS[marker[1]]) {
      flush();
      currentKey = SECTION_KEYS[marker[1]];
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

export async function handleHealth(ctx: InteractionContext): Promise<void> {
  const record = await getServerRecord();
  const state = record?.state ?? "STOPPED";

  if (state !== "RUNNING" || !record?.instance_id) {
    await editOriginalResponse(ctx.applicationId, ctx.token, healthEmbed({ state }));
    return;
  }

  const result = await runShellCommandWithOutput(record.instance_id, HEALTH_SCRIPT, {
    timeoutMs: 30_000,
  });
  if (result.status !== "Success") {
    await editOriginalResponse(
      ctx.applicationId,
      ctx.token,
      healthEmbed({
        state,
        warning: healthUnavailableMessage(result.stderr.trim() || `status: ${result.status}`),
      }),
    );
    return;
  }

  await editOriginalResponse(
    ctx.applicationId,
    ctx.token,
    healthEmbed({ state, ...parseHealthOutput(result.stdout) }),
  );
}
