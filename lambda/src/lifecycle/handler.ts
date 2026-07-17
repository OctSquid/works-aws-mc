import { config, errorMessage, log } from "../shared/config";
import {
  DATA_DEVICE_NAME,
  STOP_REASON_TAG_KEY,
  TAG_ROLE,
  cleanupOldSnapshots,
  createDataSnapshot,
  deleteVolumeIfExists,
  describeInstance,
  findOrphanDataVolume,
  getSnapshotState,
  isDataSnapshot,
  tagStopReason,
  terminateInstance,
  waitForVolumeAvailable,
} from "../shared/ec2";
import {
  INSTANCE_GONE_NOTICE,
  backupCompleteNotice,
  backupSkippedNotice,
  maxRuntimeStopNotice,
  snapshotStartedNotice,
  stalledStateNotice,
  volumeDeleteFailedNotice,
  volumeNotAvailableNotice,
} from "../shared/messages";
import { notifyWebhookBestEffort as notify } from "../shared/notify";
import { deleteARecord } from "../shared/route53";
import { runShellCommand } from "../shared/ssm";
import { getServerRecord, transitionState } from "../shared/state";
import type { EventBridgeEvent } from "../shared/types";

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

  if (detailType === "MC Watchdog Tick") {
    await onWatchdogTick();
    return;
  }

  log("warn", "unknown event ignored", { detailType });
};

// ---------------------------------------------------------------------------
// terminated → スナップショット作成
// ---------------------------------------------------------------------------

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
    volumeId = instance.BlockDeviceMappings?.find((m) => m.DeviceName === DATA_DEVICE_NAME)?.Ebs
      ?.VolumeId;
  }
  if (!volumeId) {
    volumeId = (await findOrphanDataVolume().catch(() => undefined))?.volumeId;
  }

  if (!volumeId) {
    if (record?.state === "STOPPED" || record?.state === "SNAPSHOTTING") {
      log("info", "no data volume found and state already settled, ignoring", {
        instanceId,
        state: record?.state,
      });
      return;
    }
    log("error", "data volume not found for terminated instance", { instanceId });
    await transitionState({
      from: ["RUNNING", "STOPPING", "STARTING"],
      to: "STOPPED",
      clear: ["instance_id", "volume_id"],
    }).catch((err) => log("error", "state revert failed", { error: errorMessage(err) }));
    await notify(backupSkippedNotice(stopReason));
    return;
  }

  // デタッチ完了（available）を最大5分待つ
  const available = await waitForVolumeAvailable(volumeId);
  if (!available) {
    await notify(volumeNotAvailableNotice(stopReason, volumeId));
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

  await notify(snapshotStartedNotice(stopReason));
}

// ---------------------------------------------------------------------------
// watchdog tick (EventBridge スケジュール) → AWS 側の暴走・スタック検出
// ---------------------------------------------------------------------------

/** 遷移中状態がこの時間を超えて停滞していたら異常とみなす */
const STALLED_TRANSITION_MS = 30 * 60 * 1000;

/**
 * インスタンス上の idle-watchdog が壊れていても暴走コストを止められるよう、
 * AWS 側から定期的に実態を突き合わせる最終防衛線。
 * - RUNNING で MAX_RUNTIME_HOURS 超過 → 強制停止
 * - RUNNING だが実インスタンス不在 → terminated イベント取りこぼしとして回復
 * - STARTING/STOPPING/SNAPSHOTTING の長時間停滞 → 警告（SNAPSHOTTING は完了パスを駆動）
 */
async function onWatchdogTick(): Promise<void> {
  const record = await getServerRecord();
  if (!record || record.state === "STOPPED") return;

  const updatedAtMs = Date.parse(record.updated_at);
  const stalledMs = Number.isFinite(updatedAtMs) ? Date.now() - updatedAtMs : Infinity;

  if (record.state === "RUNNING") {
    const instance = record.instance_id ? await describeInstance(record.instance_id) : undefined;
    const stateName = instance?.State?.Name;

    if (!instance || stateName === "terminated" || stateName === "shutting-down") {
      // terminated イベントを取りこぼした可能性。スナップショット経路を再駆動する
      log("warn", "state is RUNNING but instance is gone, recovering", {
        instanceId: record.instance_id,
        instanceState: stateName,
      });
      if (record.instance_id && instance) {
        await onInstanceTerminated(record.instance_id);
      } else {
        await transitionState({
          from: ["RUNNING"],
          to: "STOPPED",
          clear: ["instance_id"],
        }).catch((err) => log("error", "state revert failed", { error: errorMessage(err) }));
        await notify(INSTANCE_GONE_NOTICE);
      }
      return;
    }

    const launchTimeMs = instance.LaunchTime?.getTime();
    const maxRuntimeMs = config.maxRuntimeHours * 60 * 60 * 1000;
    if (launchTimeMs !== undefined && Date.now() - launchTimeMs > maxRuntimeMs) {
      log("warn", "max runtime exceeded, forcing shutdown", {
        instanceId: record.instance_id,
        maxRuntimeHours: config.maxRuntimeHours,
      });
      await notify(maxRuntimeStopNotice(config.maxRuntimeHours));
      try {
        // インスタンス上の graceful shutdown（告知 → save-all → poweroff → terminate）
        await runShellCommand(record.instance_id!, [
          "/opt/minecraft/bin/mc-shutdown.sh max-runtime",
        ]);
      } catch (err) {
        log("warn", "ssm shutdown failed, terminating directly", { error: errorMessage(err) });
        await tagStopReason(record.instance_id!, "max-runtime").catch(() => undefined);
        await terminateInstance(record.instance_id!);
      }
    }
    return;
  }

  // STARTING / STOPPING / SNAPSHOTTING
  if (stalledMs < STALLED_TRANSITION_MS) return;

  if (record.state === "SNAPSHOTTING" && record.snapshot_id) {
    // snapshot 完了イベントを取りこぼした場合の回復: 完了済みなら完了パスを駆動する
    const snapshotState = await getSnapshotState(record.snapshot_id);
    if (snapshotState === "completed") {
      log("warn", "snapshot already completed but event was missed, recovering", {
        snapshotId: record.snapshot_id,
      });
      await onSnapshotEvent({
        event: "createSnapshot",
        result: "succeeded",
        snapshot_id: record.snapshot_id,
        ...(record.volume_id ? { source: record.volume_id } : {}),
      });
      return;
    }
  }

  log("warn", "state transition stalled", { state: record.state, stalledMs });
  await notify(stalledStateNotice(record.state, Math.round(stalledMs / 60_000)));
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
      await notify(volumeDeleteFailedNotice(volumeId, errorMessage(err)));
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
    clear: ["instance_id", "az", "instance_type", "purchasing", "spot_price", "volume_id"],
  });
  if (!transition.ok) {
    // 既に STOPPED（重複イベント等）なら通知しない
    log("info", "transition to STOPPED rejected, skipping notification", {
      currentState: transition.currentState,
    });
    return;
  }

  await notify(backupCompleteNotice());
}
