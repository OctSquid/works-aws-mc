import { config, errorMessage, log } from "../shared/config";
import { sendWebhook } from "../shared/discord";
import {
  DATA_DEVICE_NAME,
  STOP_REASON_TAG_KEY,
  TAG_ROLE,
  cleanupOldSnapshots,
  createDataSnapshot,
  deleteVolumeIfExists,
  describeInstance,
  findOrphanDataVolume,
  isDataSnapshot,
  waitForVolumeAvailable,
  type StopReason,
} from "../shared/ec2";
import { deleteARecord } from "../shared/route53";
import { PARAM_DISCORD_WEBHOOK_URL, getParameter } from "../shared/ssm";
import { getServerRecord, transitionState } from "../shared/state";

interface EventBridgeEvent {
  "detail-type"?: string;
  detail?: Record<string, unknown>;
}

async function notify(content: string): Promise<void> {
  try {
    const webhookUrl = await getParameter(PARAM_DISCORD_WEBHOOK_URL);
    await sendWebhook(webhookUrl, content);
  } catch (err) {
    log("error", "failed to send webhook notification", { error: errorMessage(err) });
  }
}

export const handler = async (event: EventBridgeEvent): Promise<void> => {
  const detailType = event["detail-type"];
  log("info", "lifecycle event received", { detailType, detail: event.detail });

  if (detailType === "EC2 Instance State-change Notification") {
    const detail = event.detail ?? {};
    if (detail["state"] === "terminated" && typeof detail["instance-id"] === "string") {
      await onInstanceTerminated(detail["instance-id"]);
    }
    return;
  }

  if (detailType === "EBS Snapshot Notification") {
    await onSnapshotEvent(event.detail ?? {});
    return;
  }

  log("warn", "unknown event ignored", { detailType });
};

// ---------------------------------------------------------------------------
// terminated → スナップショット作成
// ---------------------------------------------------------------------------

const STOP_MESSAGES: Record<StopReason, string> = {
  manual: "🛑 サーバーを手動停止しました。",
  "auto-idle": "🛑 15分間プレイヤー不在のため自動停止しました。",
  spot: "⚠️ スポット中断により停止しました。",
};

function stopMessage(reason: string | undefined): string {
  if (reason && reason in STOP_MESSAGES) return STOP_MESSAGES[reason as StopReason];
  return "🛑 サーバーが停止しました（理由: spot または不明）。";
}

async function onInstanceTerminated(instanceId: string): Promise<void> {
  // 無関係なインスタンスの terminate は無視する
  const instance = await describeInstance(instanceId);
  const tags = instance?.Tags ?? [];
  const isMcServer = tags.some((t) => t.Key === TAG_ROLE.Key && t.Value === TAG_ROLE.Value);
  if (!instance || !isMcServer) {
    log("info", "terminated instance is not mc-server, ignoring", { instanceId });
    return;
  }

  const record = await getServerRecord();

  // 冪等性: 同一インスタンスで既にスナップショット処理へ進んでいれば重複イベント
  if (record?.state === "SNAPSHOTTING" && record.instance_id === instanceId) {
    log("info", "duplicate terminated event ignored", { instanceId });
    return;
  }

  const stopReason = tags.find((t) => t.Key === STOP_REASON_TAG_KEY)?.Value;

  // DNS レコードは先に消しておく（冪等）
  try {
    await deleteARecord(config.hostedZoneId, config.serverFqdn);
  } catch (err) {
    log("error", "failed to delete route53 record", { error: errorMessage(err) });
  }

  // データボリュームの特定: state 記録 → インスタンス BDM → タグ検索
  let volumeId = record?.volume_id;
  if (!volumeId) {
    volumeId = instance.BlockDeviceMappings?.find((m) => m.DeviceName === DATA_DEVICE_NAME)?.Ebs?.VolumeId;
  }
  if (!volumeId) {
    volumeId = (await findOrphanDataVolume().catch(() => undefined))?.volumeId;
  }

  if (!volumeId) {
    if (record?.state === "STOPPED" || record?.state === "SNAPSHOTTING") {
      log("info", "no data volume found and state already settled, ignoring", { instanceId, state: record?.state });
      return;
    }
    log("error", "data volume not found for terminated instance", { instanceId });
    await transitionState({
      from: ["RUNNING", "STOPPING", "STARTING"],
      to: "STOPPED",
      clear: ["instance_id", "volume_id"],
    }).catch((err) => log("error", "state revert failed", { error: errorMessage(err) }));
    await notify(
      `${stopMessage(stopReason)}\n⚠️ データボリュームが見つからなかったため、バックアップは作成されませんでした。`,
    );
    return;
  }

  // デタッチ完了（available）を最大5分待つ
  const available = await waitForVolumeAvailable(volumeId);
  if (!available) {
    await notify(
      `${stopMessage(stopReason)}\n❌ データボリューム (\`${volumeId}\`) が available になりませんでした。次回 \`/start\` 時にこのボリュームを再利用して復旧を試みます。`,
    );
    await transitionState({
      from: ["RUNNING", "STOPPING", "STARTING"],
      to: "STOPPED",
      set: { volume_id: volumeId },
      clear: ["instance_id"],
    }).catch((err) => log("error", "state revert failed", { error: errorMessage(err) }));
    return;
  }

  const snapshotId = await createDataSnapshot(volumeId);

  const transition = await transitionState({
    from: ["RUNNING", "STOPPING", "STARTING", "STOPPED"],
    to: "SNAPSHOTTING",
    set: { snapshot_id: snapshotId, volume_id: volumeId, instance_id: instanceId },
  });
  if (!transition.ok) {
    log("warn", "transition to SNAPSHOTTING rejected", { currentState: transition.currentState });
  }

  await notify(`${stopMessage(stopReason)}\n💾 バックアップ（スナップショット）を作成しています…`);
}

// ---------------------------------------------------------------------------
// snapshot completed → ボリューム削除・世代整理
// ---------------------------------------------------------------------------

function extractId(arnOrId: unknown): string | undefined {
  if (typeof arnOrId !== "string" || arnOrId === "") return undefined;
  const last = arnOrId.split("/").pop();
  return last === "" ? undefined : last;
}

async function onSnapshotEvent(detail: Record<string, unknown>): Promise<void> {
  if (detail["event"] !== "createSnapshot" || detail["result"] !== "succeeded") {
    log("info", "snapshot event ignored", { event: detail["event"], result: detail["result"] });
    return;
  }
  const snapshotId = extractId(detail["snapshot_id"]);
  if (!snapshotId) {
    log("warn", "snapshot event without snapshot_id");
    return;
  }

  const record = await getServerRecord();

  // 対象確認: state の snapshot_id と一致、またはタグ mc:data=true
  const matchesRecord = record?.snapshot_id === snapshotId;
  if (!matchesRecord && !(await isDataSnapshot(snapshotId))) {
    log("info", "snapshot is not mc data snapshot, ignoring", { snapshotId });
    return;
  }

  // 冪等性: 既に STOPPED まで処理済みなら重複イベント
  if (record?.state === "STOPPED" && matchesRecord) {
    log("info", "duplicate snapshot event ignored", { snapshotId });
    return;
  }

  // ボリューム削除（record 優先、無ければイベントの source ARN から）
  const volumeId = record?.volume_id ?? extractId(detail["source"]);
  if (volumeId) {
    try {
      await deleteVolumeIfExists(volumeId);
    } catch (err) {
      log("error", "failed to delete volume", { volumeId, error: errorMessage(err) });
      await notify(`⚠️ バックアップ後のボリューム削除に失敗しました (\`${volumeId}\`): ${errorMessage(err)}`);
    }
  } else {
    log("warn", "no volume id to delete", { snapshotId });
  }

  // 世代整理（今回作成分は絶対に消さない）
  try {
    const deleted = await cleanupOldSnapshots(config.snapshotRetention, snapshotId);
    if (deleted.length > 0) {
      log("info", "old snapshots cleaned up", { deleted });
    }
  } catch (err) {
    log("error", "snapshot cleanup failed", { error: errorMessage(err) });
  }

  const transition = await transitionState({
    from: ["SNAPSHOTTING"],
    to: "STOPPED",
    set: { snapshot_id: snapshotId },
    clear: ["instance_id", "az", "instance_type", "spot_price", "volume_id"],
  });
  if (!transition.ok) {
    // 既に STOPPED（重複イベント等）なら通知しない
    log("info", "transition to STOPPED rejected, skipping notification", {
      currentState: transition.currentState,
    });
    return;
  }

  await notify("✅ バックアップ完了。`/start` で再開できます。");
};
