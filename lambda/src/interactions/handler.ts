import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { config, errorMessage, log, setLogContext } from "../shared/config";
import { verifyDiscordSignature } from "../shared/discord";
import { parseInteractionOptions, type InteractionDataOption } from "../shared/interaction-options";
import { PARAM_DISCORD_PUBLIC_KEY, getParameter } from "../shared/ssm";
import type { WorkerPayload } from "../shared/types";

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

interface Interaction {
  type: number;
  application_id?: string;
  token?: string;
  channel_id?: string;
  data?: { name?: string; options?: InteractionDataOption[] };
  member?: { user?: { username?: string; global_name?: string } };
  user?: { username?: string; global_name?: string };
}

/** Lambda の context（必要なフィールドのみ） */
export interface LambdaContext {
  awsRequestId?: string;
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

function headerLookup(
  headers: Record<string, string | undefined>,
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

/** 署名済みリクエストの再送（リプレイ）対策の許容時刻ずれ */
const REPLAY_WINDOW_SECONDS = 300;

function isTimestampFresh(timestamp: string, nowMs: number = Date.now()): boolean {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  return Math.abs(nowMs / 1000 - seconds) <= REPLAY_WINDOW_SECONDS;
}

export const handler = async (
  event: FunctionUrlEvent,
  context?: LambdaContext,
): Promise<FunctionUrlResult> => {
  const requestId = context?.awsRequestId;
  setLogContext(requestId ? { correlationId: requestId } : {});
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

  if (
    !signature ||
    !timestamp ||
    !isTimestampFresh(timestamp) ||
    !verifyDiscordSignature(rawBody, signature, timestamp, publicKey)
  ) {
    log("warn", "invalid request signature", {
      hasSignature: Boolean(signature),
      hasTimestamp: Boolean(timestamp),
      timestampFresh: timestamp ? isTimestampFresh(timestamp) : false,
    });
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
    const parsed = parseInteractionOptions(interaction.data?.options);
    const payload: WorkerPayload = {
      command: interaction.data?.name ?? "",
      subcommandGroup: parsed.subcommandGroup,
      subcommand: parsed.subcommand,
      options: parsed.args,
      applicationId: interaction.application_id ?? "",
      token: interaction.token ?? "",
      channelId: interaction.channel_id,
      invokedBy: interaction.member?.user?.username ?? interaction.user?.username,
      // interactions のリクエスト ID を worker のログにも流して突き合わせ可能にする
      correlationId: requestId,
    };
    log("info", "dispatching command to worker", {
      command: payload.command,
      invokedBy: payload.invokedBy,
    });
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
