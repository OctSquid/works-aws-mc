/**
 * /admin・/health・/logs が共用する RCON / インスタンス操作ヘルパー。
 * RCON はインスタンス上の rcon.sh（localhost 完結）に SSM RunCommand 経由で到達する。
 */
import { editOriginalResponse } from "../shared/discord";
import { serverNotRunningMessage } from "../shared/messages";
import { runShellCommandWithOutput, type ShellCommandResult } from "../shared/ssm";
import { getServerRecord } from "../shared/state";
import { shellQuote } from "../shared/util";
import type { InteractionContext } from "../shared/types";

export const RCON_SH = "/opt/minecraft/bin/rcon.sh";

/**
 * RUNNING かつ instance_id が記録されているときだけインスタンス ID を返す。
 * それ以外は未稼働メッセージを応答して undefined を返す（呼び出し側は早期 return）。
 */
export async function requireRunningInstance(ctx: InteractionContext): Promise<string | undefined> {
  const record = await getServerRecord();
  if (record?.state === "RUNNING" && record.instance_id) return record.instance_id;
  await editOriginalResponse(ctx.applicationId, ctx.token, serverNotRunningMessage(record?.state));
  return undefined;
}

/** Minecraft のカラーコード（§x）を除去する */
export function stripColorCodes(text: string): string {
  return text.replaceAll(/§./g, "");
}

/** シェルへ渡す前に制御文字を除去する（複数行入力や端末制御の混入防止） */
function sanitizeConsoleInput(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replaceAll(/[\x00-\x1f\x7f]/g, " ").trim();
}

/** RCON でコンソールコマンドを 1 つ実行し、出力（カラーコード除去済み）を返す */
export async function runRcon(
  instanceId: string,
  mcCommand: string,
  timeoutMs = 30_000,
): Promise<ShellCommandResult> {
  const sanitized = sanitizeConsoleInput(mcCommand);
  const result = await runShellCommandWithOutput(
    instanceId,
    [`${RCON_SH} ${shellQuote(sanitized)}`],
    { timeoutMs },
  );
  return { ...result, stdout: stripColorCodes(result.stdout) };
}

/** Minecraft (Java 版) の正規プレイヤー名のみ許可する */
export function isValidPlayerName(name: string): boolean {
  return /^[A-Za-z0-9_]{1,16}$/.test(name);
}

/**
 * /admin cmd で禁止するコンソールコマンド。
 * stop/restart は state machine（DynamoDB）の外でサーバーを落とし、
 * mc:stop-reason タグ無しの終了 → lifecycle が「spot または不明」と誤認するためブロック。
 */
const BLOCKED_CONSOLE_COMMANDS: ReadonlySet<string> = new Set(["stop", "restart"]);

/** 先頭の `/` を取り除いたコンソールコマンドを返す。ブロック対象なら undefined */
export function normalizeConsoleCommand(input: string): string | undefined {
  const command = sanitizeConsoleInput(input).replace(/^\//, "");
  const head = command.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (BLOCKED_CONSOLE_COMMANDS.has(head)) return undefined;
  return command;
}
