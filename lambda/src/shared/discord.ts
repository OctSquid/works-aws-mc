import nacl from "tweetnacl";
import { log } from "./config";

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

async function discordRequest(
  url: string,
  method: string,
  body: unknown,
  logLabel: string,
): Promise<void> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log("error", "discord api request failed", {
        label: logLabel,
        method,
        status: res.status,
        response: text.slice(0, 500),
      });
    }
  } catch (err) {
    log("error", "discord api request threw", { label: logLabel, method, error: String(err) });
  }
}

/** deferred 応答（@original）を編集する（初回 followup 用: PATCH） */
export async function editOriginalResponse(
  applicationId: string,
  token: string,
  content: string,
): Promise<void> {
  await discordRequest(
    `${DISCORD_API_BASE}/webhooks/${applicationId}/${token}/messages/@original`,
    "PATCH",
    { content },
    "edit-original",
  );
}

/** 追加の followup メッセージを送信する（POST） */
export async function sendFollowup(
  applicationId: string,
  token: string,
  content: string,
): Promise<void> {
  await discordRequest(
    `${DISCORD_API_BASE}/webhooks/${applicationId}/${token}`,
    "POST",
    { content },
    "followup",
  );
}

/** Webhook URL（SSM /mc/discord/webhook-url）へ通知を送信する */
export async function sendWebhook(webhookUrl: string, content: string): Promise<void> {
  await discordRequest(webhookUrl, "POST", { content }, "webhook");
}
