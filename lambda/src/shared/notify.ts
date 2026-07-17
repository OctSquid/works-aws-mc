import { errorMessage, log } from "./config";
import { sendWebhook, type OutgoingMessage } from "./discord";
import { PARAM_DISCORD_WEBHOOK_URL, getParameter } from "./ssm";

/**
 * 運用 Webhook（SSM /mc/discord/webhook-url）への通知。
 * 通知失敗で本処理（スナップショット等）を止めないため、失敗は記録して握り潰す。
 * 以前は lifecycle / spot-interruption に同じ実装がコピーされていた。
 */
export async function notifyWebhookBestEffort(message: OutgoingMessage): Promise<void> {
  try {
    const webhookUrl = await getParameter(PARAM_DISCORD_WEBHOOK_URL);
    await sendWebhook(webhookUrl, message);
  } catch (err) {
    log("error", "failed to send webhook notification", { error: errorMessage(err) });
  }
}
