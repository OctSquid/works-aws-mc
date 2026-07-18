import {
  GetCommandInvocationCommand,
  GetParameterCommand,
  SSMClient,
  SendCommandCommand,
} from "@aws-sdk/client-ssm";
import { log, sleep } from "./config";

/** SSM Parameter Store の固定パス（Terraform 側と合意済み） */
export const PARAM_AMI_ID = "/mc/ami-id";
export const PARAM_DISCORD_PUBLIC_KEY = "/mc/discord/public-key";
export const PARAM_DISCORD_BOT_TOKEN = "/mc/discord/bot-token";
export const PARAM_DISCORD_WEBHOOK_URL = "/mc/discord/webhook-url";
export const PARAM_RCON_PASSWORD = "/mc/rcon-password";

const ssm = new SSMClient({});

const parameterCache = new Map<string, string>();

/** テスト用: モジュールスコープのパラメータキャッシュを消去する */
export function clearSsmParameterCache(): void {
  parameterCache.clear();
}

/** SSM パラメータを取得する（モジュールスコープでキャッシュ） */
export async function getParameter(name: string, withDecryption = true): Promise<string> {
  const cached = parameterCache.get(name);
  if (cached !== undefined) return cached;
  const res = await ssm.send(
    new GetParameterCommand({ Name: name, WithDecryption: withDecryption }),
  );
  const value = res.Parameter?.Value;
  if (value === undefined || value === "") {
    throw new Error(`SSM パラメータ ${name} が空です`);
  }
  parameterCache.set(name, value);
  return value;
}

/** AWS-RunShellScript でインスタンス上のシェルコマンドを実行する */
export async function runShellCommand(
  instanceId: string,
  commands: string[],
): Promise<string | undefined> {
  const res = await ssm.send(
    new SendCommandCommand({
      DocumentName: "AWS-RunShellScript",
      InstanceIds: [instanceId],
      Parameters: { commands },
      TimeoutSeconds: 300,
    }),
  );
  const commandId = res.Command?.CommandId;
  log("info", "ssm send-command dispatched", { instanceId, commandId, commands });
  return commandId;
}

export interface ShellCommandResult {
  status: "Success" | "Failed" | "TimedOut" | "Cancelled";
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "Success",
  "Failed",
  "TimedOut",
  "Cancelled",
]);

/**
 * シェルコマンドを実行し、完了までポーリングして stdout/stderr を回収する。
 * fire-and-forget でよい場合は runShellCommand を使うこと。
 */
export async function runShellCommandWithOutput(
  instanceId: string,
  commands: string[],
  { timeoutMs = 60_000, intervalMs = 2_000 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<ShellCommandResult> {
  const commandId = await runShellCommand(instanceId, commands);
  if (!commandId) throw new Error("SSM SendCommand が CommandId を返しませんでした");

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let invocation;
    try {
      invocation = await ssm.send(
        new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }),
      );
    } catch (err) {
      // SendCommand 直後は結果整合で InvocationDoesNotExist が返り得る → まだ Pending 扱い
      if ((err as { name?: string }).name !== "InvocationDoesNotExist") throw err;
    }
    const status = invocation?.Status ?? "";
    if (invocation && TERMINAL_STATUSES.has(status)) {
      log("info", "ssm command finished", { instanceId, commandId, status });
      return {
        status: status as ShellCommandResult["status"],
        stdout: invocation.StandardOutputContent ?? "",
        stderr: invocation.StandardErrorContent ?? "",
        exitCode: invocation.ResponseCode,
      };
    }
    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  }
  log("error", "ssm command polling timed out", { instanceId, commandId, timeoutMs });
  throw new Error(
    `SSM コマンドの完了待ちがタイムアウトしました（${Math.round(timeoutMs / 1000)}秒）`,
  );
}
