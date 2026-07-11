import { GetParameterCommand, SSMClient, SendCommandCommand } from "@aws-sdk/client-ssm";
import { log } from "./config";

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
