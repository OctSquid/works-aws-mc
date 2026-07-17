/** データボリューム・スナップショットのライフサイクル */
import {
  AttachVolumeCommand,
  CreateSnapshotCommand,
  CreateTagsCommand,
  DeleteSnapshotCommand,
  DeleteVolumeCommand,
  DescribeSnapshotsCommand,
  DescribeVolumesCommand,
  type Snapshot,
} from "@aws-sdk/client-ec2";
import { log, sleep } from "../config";
import { latestBy, sortLatestFirst } from "../util";
import { ec2 } from "./client";
import { DATA_DEVICE_NAME, TAG_DATA, TAG_PROJECT } from "./constants";

/** 最新の completed データスナップショット（tag:mc:data=true）を返す */
export async function findLatestDataSnapshot(): Promise<
  { snapshotId: string; startTime?: Date | undefined } | undefined
> {
  const res = await ec2.send(
    new DescribeSnapshotsCommand({
      OwnerIds: ["self"],
      Filters: [
        { Name: "tag:mc:data", Values: ["true"] },
        { Name: "status", Values: ["completed"] },
      ],
    }),
  );
  const latest = latestBy(
    (res.Snapshots ?? []).filter((s): s is Snapshot & { SnapshotId: string } =>
      Boolean(s.SnapshotId),
    ),
    (s) => s.StartTime,
  );
  if (!latest) return undefined;
  return { snapshotId: latest.SnapshotId, startTime: latest.StartTime };
}

/** 孤児データボリューム（tag:mc:data=true かつ available）を返す */
export async function findOrphanDataVolume(): Promise<
  { volumeId: string; az: string } | undefined
> {
  const res = await ec2.send(
    new DescribeVolumesCommand({
      Filters: [
        { Name: "tag:mc:data", Values: ["true"] },
        { Name: "status", Values: ["available"] },
      ],
    }),
  );
  const volume = latestBy(res.Volumes ?? [], (v) => v.CreateTime);
  if (!volume?.VolumeId || !volume.AvailabilityZone) return undefined;
  return { volumeId: volume.VolumeId, az: volume.AvailabilityZone };
}

export async function attachDataVolume(volumeId: string, instanceId: string): Promise<void> {
  await ec2.send(
    new AttachVolumeCommand({
      VolumeId: volumeId,
      InstanceId: instanceId,
      Device: DATA_DEVICE_NAME,
    }),
  );
  log("info", "orphan data volume attached", { volumeId, instanceId });
}

/**
 * データボリュームへ mc:data=true 等のタグを付ける。
 * RunInstances の volume TagSpecifications はルートボリュームにも適用されて
 * しまうため、起動後にデータボリュームだけを狙ってタグ付けする。
 */
export async function tagDataVolume(volumeId: string): Promise<void> {
  await ec2.send(
    new CreateTagsCommand({
      Resources: [volumeId],
      Tags: [TAG_DATA, TAG_PROJECT, { Key: "Name", Value: "mc-data" }],
    }),
  );
  log("info", "data volume tagged", { volumeId });
}

/** ボリュームが available になるまでポーリングする（デフォルト最大5分） */
export async function waitForVolumeAvailable(
  volumeId: string,
  { timeoutMs = 300_000, intervalMs = 10_000 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
    const state = res.Volumes?.[0]?.State;
    if (state === "available") return true;
    if (Date.now() >= deadline) {
      log("warn", "volume did not become available in time", { volumeId, state });
      return false;
    }
    await sleep(intervalMs);
  }
}

/** データボリュームのスナップショットを作成する */
export async function createDataSnapshot(
  volumeId: string,
  now: Date = new Date(),
): Promise<string> {
  const res = await ec2.send(
    new CreateSnapshotCommand({
      VolumeId: volumeId,
      Description: `mc-server world data ${now.toISOString()}`,
      TagSpecifications: [
        {
          ResourceType: "snapshot",
          Tags: [TAG_DATA, TAG_PROJECT, { Key: "Name", Value: "mc-data" }],
        },
      ],
    }),
  );
  const snapshotId = res.SnapshotId;
  if (!snapshotId) throw new Error("CreateSnapshot がスナップショット ID を返しませんでした");
  log("info", "snapshot creation started", { volumeId, snapshotId });
  return snapshotId;
}

/** ボリュームを削除する（既に無ければ何もしない: 冪等） */
export async function deleteVolumeIfExists(volumeId: string): Promise<boolean> {
  try {
    await ec2.send(new DeleteVolumeCommand({ VolumeId: volumeId }));
    log("info", "volume deleted", { volumeId });
    return true;
  } catch (err) {
    const code = (err as { name?: string }).name ?? "";
    if (code === "InvalidVolume.NotFound") {
      log("info", "volume already deleted", { volumeId });
      return false;
    }
    throw err;
  }
}

/**
 * 古いデータスナップショットを整理する。
 * 新しい順に retention 世代残して削除。protectSnapshotId（今回作成分）は絶対に消さない。
 */
export async function cleanupOldSnapshots(
  retention: number,
  protectSnapshotId?: string,
): Promise<string[]> {
  const res = await ec2.send(
    new DescribeSnapshotsCommand({
      OwnerIds: ["self"],
      Filters: [
        { Name: "tag:mc:data", Values: ["true"] },
        { Name: "status", Values: ["completed"] },
      ],
    }),
  );
  const sorted = sortLatestFirst(
    (res.Snapshots ?? []).filter((s): s is Snapshot & { SnapshotId: string } =>
      Boolean(s.SnapshotId),
    ),
    (s) => s.StartTime,
  );
  const toDelete = sorted
    .slice(Math.max(retention, 1))
    .filter((s) => s.SnapshotId !== protectSnapshotId);
  const deleted: string[] = [];
  for (const snapshot of toDelete) {
    try {
      await ec2.send(new DeleteSnapshotCommand({ SnapshotId: snapshot.SnapshotId }));
      deleted.push(snapshot.SnapshotId);
      log("info", "old snapshot deleted", { snapshotId: snapshot.SnapshotId });
    } catch (err) {
      log("warn", "failed to delete old snapshot", {
        snapshotId: snapshot.SnapshotId,
        error: String(err),
      });
    }
  }
  return deleted;
}

/** スナップショットの現在の状態（pending / completed / error）を返す */
export async function getSnapshotState(snapshotId: string): Promise<string | undefined> {
  try {
    const res = await ec2.send(new DescribeSnapshotsCommand({ SnapshotIds: [snapshotId] }));
    return res.Snapshots?.[0]?.State;
  } catch (err) {
    log("warn", "describe snapshot failed", { snapshotId, error: String(err) });
    return undefined;
  }
}

/** スナップショットが mc:data=true か確認する */
export async function isDataSnapshot(snapshotId: string): Promise<boolean> {
  try {
    const res = await ec2.send(new DescribeSnapshotsCommand({ SnapshotIds: [snapshotId] }));
    const snapshot = res.Snapshots?.[0];
    return (snapshot?.Tags ?? []).some((t) => t.Key === TAG_DATA.Key && t.Value === TAG_DATA.Value);
  } catch (err) {
    log("warn", "describe snapshot failed", { snapshotId, error: String(err) });
    return false;
  }
}
