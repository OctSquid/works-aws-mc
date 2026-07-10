import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { config, errorMessage, log } from "../shared/config";
import { verifyDiscordSignature } from "../shared/discord";
import { PARAM_DISCORD_PUBLIC_KEY, getParameter } from "../shared/ssm";

/** Lambda Function URL イベント（必要なフィールドのみ） */
export interface FunctionUrlEvent {
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

export interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

interface InteractionOption {
  name: string;
  value?: unknown;
  type?: number;
}

interface Interaction {
  type: number;
  application_id?: string;
  token?: string;
  channel_id?: string;
  data?: { name?: string; options?: InteractionOption[] };
  member?: { user?: { username?: string; global_name?: string } };
  user?: { username?: string; global_name?: string };
}

/** command-worker へ渡すペイロード */
export interface WorkerPayload {
  command: string;
  options: Record<string, unknown>;
  applicationId: string;
  token: string;
  channelId?: string;
  invokedBy?: string;
}

const lambda = new LambdaClient({});

let publicKeyPromise: Promise<string> | undefined;

/** テスト用: 公開鍵キャッシュを消去する */
export function resetPublicKeyCache(): void {
  publicKeyPromise = undefined;
}

async function getPublicKey(): Promise<string> {
  publicKeyPromise ??= getParameter(PARAM_DISCORD_PUBLIC_KEY);
  try {
    return await publicKeyPromise;
  } catch (err) {
    publicKeyPromise = undefined; // 失敗した Promise をキャッシュしない
    throw err;
  }
}

function respond(statusCode: number, body: unknown): FunctionUrlResult {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function headerLookup(headers: Record<string, string | undefined>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

export const handler = async (event: FunctionUrlEvent): Promise<FunctionUrlResult> => {
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : (event.body ?? "");
  const headers = event.headers ?? {};
  const signature = headerLookup(headers, "x-signature-ed25519");
  const timestamp = headerLookup(headers, "x-signature-timestamp");

  let publicKey: string;
  try {
    publicKey = await getPublicKey();
  } catch (err) {
    log("error", "failed to fetch discord public key", { error: errorMessage(err) });
    return respond(500, { error: "internal error" });
  }

  if (!signature || !timestamp || !verifyDiscordSignature(rawBody, signature, timestamp, publicKey)) {
    log("warn", "invalid request signature", { hasSignature: Boolean(signature), hasTimestamp: Boolean(timestamp) });
    return respond(401, { error: "invalid request signature" });
  }

  let interaction: Interaction;
  try {
    interaction = JSON.parse(rawBody) as Interaction;
  } catch {
    return respond(400, { error: "invalid json body" });
  }

  // PING → PONG
  if (interaction.type === 1) {
    log("info", "ping received");
    return respond(200, { type: 1 });
  }

  // APPLICATION_COMMAND → worker を非同期 Invoke して deferred 応答
  if (interaction.type === 2) {
    const options: Record<string, unknown> = {};
    for (const opt of interaction.data?.options ?? []) {
      options[opt.name] = opt.value;
    }
    const payload: WorkerPayload = {
      command: interaction.data?.name ?? "",
      options,
      applicationId: interaction.application_id ?? "",
      token: interaction.token ?? "",
      channelId: interaction.channel_id,
      invokedBy: interaction.member?.user?.username ?? interaction.user?.username,
    };
    log("info", "dispatching command to worker", { command: payload.command, invokedBy: payload.invokedBy });
    try {
      await lambda.send(
        new InvokeCommand({
          FunctionName: config.workerFunctionName,
          InvocationType: "Event",
          Payload: Buffer.from(JSON.stringify(payload)),
        }),
      );
    } catch (err) {
      log("error", "failed to invoke worker", { error: errorMessage(err) });
      return respond(200, {
        type: 4,
        data: { content: `❌ コマンドの受付に失敗しました: ${errorMessage(err)}` },
      });
    }
    // type 5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
    return respond(200, { type: 5 });
  }

  log("warn", "unsupported interaction type", { type: interaction.type });
  return respond(400, { error: "unsupported interaction type" });
};
