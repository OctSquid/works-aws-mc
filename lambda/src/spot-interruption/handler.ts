import { errorMessage, log } from "../shared/config";
import { tagStopReason } from "../shared/ec2";
import { spotInterruptionNotice } from "../shared/messages";
import { notifyWebhookBestEffort } from "../shared/notify";
import { runShellCommand } from "../shared/ssm";
import { getServerRecord } from "../shared/state";
import type { EventBridgeEvent } from "../shared/types";

export const handler = async (event: EventBridgeEvent): Promise<void> => {
  if (event["detail-type"] !== "EC2 Spot Instance Interruption Warning") {
    log("warn", "unexpected event ignored", { detailType: event["detail-type"] });
    return;
  }
  const instanceId = event.detail?.["instance-id"];
  if (typeof instanceId !== "string" || instanceId === "") {
    log("warn", "interruption warning without instance-id");
    return;
  }

  const record = await getServerRecord();
  if (record?.instance_id !== instanceId) {
    log("info", "interruption for unknown instance, ignoring", {
      instanceId,
      recordedInstanceId: record?.instance_id,
    });
    return;
  }

  log("info", "spot interruption warning", { instanceId });

  // Discord へ即時通知（ベストエフォート）
  await notifyWebhookBestEffort(spotInterruptionNotice());

  // 停止理由タグ（lifecycle が通知の文言に使う）
  try {
    await tagStopReason(instanceId, "spot");
  } catch (err) {
    log("error", "failed to tag stop reason", { instanceId, error: errorMessage(err) });
  }

  // ゲーム内告知 + save-all + stop（terminate は AWS に任せる）。失敗は無視（ベストエフォート）
  try {
    await runShellCommand(instanceId, ["/opt/minecraft/bin/mc-shutdown.sh spot --fast"]);
  } catch (err) {
    log("warn", "ssm send-command failed (best effort)", { instanceId, error: errorMessage(err) });
  }
};
