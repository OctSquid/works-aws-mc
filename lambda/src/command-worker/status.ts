import { config } from "../shared/config";
import { editOriginalResponse } from "../shared/discord";
import { describeInstance, getCurrentSpotPrice } from "../shared/ec2";
import { STATUS_STOPPED_MESSAGE, statusEmbed, statusTerminatedWarning } from "../shared/messages";
import { getServerRecord } from "../shared/state";
import type { InteractionContext } from "../shared/types";

function formatUptime(launchTime: Date, now: Date = new Date()): string {
  const totalMinutes = Math.max(0, Math.floor((now.getTime() - launchTime.getTime()) / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}時間${minutes}分` : `${minutes}分`;
}

export async function handleStatus(ctx: InteractionContext): Promise<void> {
  const record = await getServerRecord();

  if (!record || record.state === "STOPPED") {
    await editOriginalResponse(ctx.applicationId, ctx.token, STATUS_STOPPED_MESSAGE);
    return;
  }

  let ip: string | undefined;
  let uptime: string | undefined;
  let purchasingLine: string | undefined;
  let warning: string | undefined;
  let showInstance = false;

  if (
    record.instance_id &&
    (record.state === "RUNNING" || record.state === "STARTING" || record.state === "STOPPING")
  ) {
    const instance = await describeInstance(record.instance_id);
    const instanceState = instance?.State?.Name;
    if (instance && instanceState !== "terminated" && instanceState !== "shutting-down") {
      showInstance = true;
      ip = instance.PublicIpAddress;
      if (instance.LaunchTime) uptime = formatUptime(instance.LaunchTime);
      if (record.purchasing === "ondemand") {
        purchasingLine = "オンデマンド";
      } else if (record.az && record.instance_type) {
        // purchasing 未記録の旧レコードはスポットとして扱う（後方互換）
        const price = await getCurrentSpotPrice(record.instance_type, record.az).catch(
          () => undefined,
        );
        if (price !== undefined) {
          purchasingLine = `スポット（現在: $${price.toFixed(4)}/時 / 起動時: $${record.spot_price?.toFixed(4) ?? "?"}/時）`;
        } else {
          purchasingLine = "スポット";
        }
      }
    } else {
      warning = statusTerminatedWarning(record.instance_id);
    }
  }

  await editOriginalResponse(
    ctx.applicationId,
    ctx.token,
    statusEmbed({
      state: record.state,
      fqdn: ip ? config.serverFqdn : undefined,
      ip,
      instanceId: showInstance ? record.instance_id : undefined,
      az: record.az,
      instanceType: record.instance_type,
      uptime,
      purchasingLine,
      updatedAt: record.updated_at,
      warning,
    }),
  );
}
