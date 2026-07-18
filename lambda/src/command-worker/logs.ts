/**
 * /logs — latest.log の末尾 N 行を表示する。
 * ログは CloudWatch Logs へ転送していないため、SSM でインスタンス上から直接読む。
 */
import { editOriginalResponse } from "../shared/discord";
import { LOGS_MAX_CONTENT_LENGTH, logsMessage } from "../shared/messages";
import { runShellCommandWithOutput } from "../shared/ssm";
import { truncateTail } from "../shared/util";
import type { InteractionContext } from "../shared/types";
import { requireRunningInstance } from "./rcon";

const LOG_FILE = "/srv/minecraft/logs/latest.log";
export const DEFAULT_LINES = 50;
export const MAX_LINES = 200;

export function clampLines(value: unknown): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LINES;
  return Math.min(n, MAX_LINES);
}

export async function handleLogs(ctx: InteractionContext): Promise<void> {
  const lines = clampLines(ctx.args["lines"]);

  const instanceId = await requireRunningInstance(ctx);
  if (!instanceId) return;

  // lines は数値化・clamp 済みのためインジェクション経路はない
  const result = await runShellCommandWithOutput(
    instanceId,
    [`tail -n ${lines} ${LOG_FILE} 2>&1 || true`],
    { timeoutMs: 30_000 },
  );
  await editOriginalResponse(
    ctx.applicationId,
    ctx.token,
    logsMessage(lines, truncateTail(result.stdout, LOGS_MAX_CONTENT_LENGTH)),
  );
}
