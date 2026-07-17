import nacl from "tweetnacl";
import { log, sleep } from "./config";

const DISCORD_API_BASE = "https://discord.com/api/v10";

/**
 * Discord Interactions の ed25519 署名を検証する。
 * @param rawBody   リクエストボディ（無加工の文字列）
 * @param signature x-signature-ed25519 ヘッダ（hex）
 * @param timestamp x-signature-timestamp ヘッダ
 * @param publicKeyHex Bot の公開鍵（hex）
 */
export function verifyDiscordSignature(
  rawBody: string,
  signature: string,
  timestamp: string,
  publicKeyHex: string,
): boolean {
  try {
    return nacl.sign.detached.verify(
      new TextEncoder().encode(timestamp + rawBody),
      Uint8Array.from(Buffer.from(signature, "hex")),
      Uint8Array.from(Buffer.from(publicKeyHex, "hex")),
    );
  } catch (err) {
    log("warn", "signature verification threw", { error: String(err) });
    return false;
  }
}

/** Discord の埋め込み（必要なフィールドのみ。discord.js には依存しない） */
export interface Embed {
  title?: string;
  description?: string;
  /** 左端のアクセントカラー（0xRRGGBB） */
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  /** ISO 8601 */
  timestamp?: string;
}

/** 送信メッセージ。文字列なら従来どおり plain content として送る */
export type OutgoingMessage = string | { content?: string; embeds?: Embed[] };

function toMessageBody(message: OutgoingMessage): { content?: string; embeds?: Embed[] } {
  return typeof message === "string" ? { content: message } : message;
}

interface DiscordRequestOptions {
  /**
   * 404 を短いバックオフで再試行する。deferred ACK（type:5）の登録が完了する前に
   * PATCH @original が届くと 404 になるため、@original 編集でのみ有効にする。
   */
  retry404?: boolean;
}

const MAX_TOTAL_ATTEMPTS = 5;
const RETRY_404_DELAYS_MS = [300, 600, 1200] as const;
const RETRY_5XX_DELAYS_MS = [500, 1500] as const;
const MAX_429_RETRIES = 3;
const MAX_429_WAIT_MS = 5_000;

/** 429 レスポンスから待機時間を決める（body の retry_after 秒 → Retry-After ヘッダ → 1秒） */
function retryAfterMs(res: Response, bodyText: string): number {
  let seconds: number | undefined;
  try {
    const parsed = JSON.parse(bodyText) as { retry_after?: number };
    if (typeof parsed.retry_after === "number") seconds = parsed.retry_after;
  } catch {
    // JSON でなければヘッダにフォールバック
  }
  if (seconds === undefined) {
    const header = Number(res.headers.get("retry-after"));
    if (Number.isFinite(header)) seconds = header;
  }
  return Math.min(Math.max((seconds ?? 1) * 1000, 0), MAX_429_WAIT_MS);
}

/**
 * Discord API を呼ぶ。429 / 5xx / ネットワークエラー（と opts.retry404 時の 404）は
 * バックオフ付きで再試行し、それでも失敗したら throw する（握り潰さない）。
 */
async function discordRequest(
  url: string,
  method: string,
  body: unknown,
  logLabel: string,
  opts: DiscordRequestOptions = {},
): Promise<void> {
  let retries404 = 0;
  let retries5xx = 0;
  let retries429 = 0;
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_TOTAL_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      lastError = String(err);
      const delay = RETRY_5XX_DELAYS_MS[retries5xx];
      if (delay === undefined) break;
      retries5xx++;
      log("warn", "discord api request threw, retrying", {
        label: logLabel,
        method,
        attempt,
        error: lastError,
      });
      await sleep(delay);
      continue;
    }
    if (res.ok) return;

    const text = await res.text().catch(() => "");
    lastError = `status=${res.status} response=${text.slice(0, 500)}`;

    let delay: number | undefined;
    if (res.status === 429 && retries429 < MAX_429_RETRIES) {
      retries429++;
      delay = retryAfterMs(res, text);
    } else if (res.status === 404 && opts.retry404) {
      delay = RETRY_404_DELAYS_MS[retries404];
      if (delay !== undefined) retries404++;
    } else if (res.status >= 500) {
      delay = RETRY_5XX_DELAYS_MS[retries5xx];
      if (delay !== undefined) retries5xx++;
    }
    if (delay === undefined) break;
    log("warn", "discord api request failed, retrying", {
      label: logLabel,
      method,
      status: res.status,
      attempt,
      delayMs: delay,
    });
    await sleep(delay);
  }
  log("error", "discord api request failed", { label: logLabel, method, error: lastError });
  throw new Error(`Discord API 呼び出しに失敗しました (${logLabel}): ${lastError}`);
}

/** deferred 応答（@original）を編集する（初回 followup 用: PATCH） */
export async function editOriginalResponse(
  applicationId: string,
  token: string,
  message: OutgoingMessage,
): Promise<void> {
  await discordRequest(
    `${DISCORD_API_BASE}/webhooks/${applicationId}/${token}/messages/@original`,
    "PATCH",
    toMessageBody(message),
    "edit-original",
    // deferred ACK の登録完了前に届くと 404 になるためリトライで吸収する
    { retry404: true },
  );
}

/** 追加の followup メッセージを送信する（POST） */
export async function sendFollowup(
  applicationId: string,
  token: string,
  message: OutgoingMessage,
): Promise<void> {
  await discordRequest(
    `${DISCORD_API_BASE}/webhooks/${applicationId}/${token}`,
    "POST",
    toMessageBody(message),
    "followup",
  );
}

/** Webhook URL（SSM /mc/discord/webhook-url）へ通知を送信する */
export async function sendWebhook(webhookUrl: string, message: OutgoingMessage): Promise<void> {
  await discordRequest(webhookUrl, "POST", toMessageBody(message), "webhook");
}
