import {
  AttachVolumeCommand,
  CreateSnapshotCommand,
  CreateTagsCommand,
  DeleteSnapshotCommand,
  DeleteVolumeCommand,
  DescribeInstancesCommand,
  DescribeSnapshotsCommand,
  DescribeSpotPriceHistoryCommand,
  DescribeSubnetsCommand,
  DescribeVolumesCommand,
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
  type Instance,
  type RunInstancesCommandInput,
  type Snapshot,
  type SpotPrice,
  type _InstanceType,
} from "@aws-sdk/client-ec2";
import { log, sleep } from "./config";

const ec2 = new EC2Client({});

export const TAG_PROJECT = { Key: "Project", Value: "mc-server" } as const;
export const TAG_ROLE = { Key: "mc:role", Value: "server" } as const;
export const TAG_DATA = { Key: "mc:data", Value: "true" } as const;
export const STOP_REASON_TAG_KEY = "mc:stop-reason";
export const DATA_DEVICE_NAME = "/dev/sdf";

export type StopReason = "manual" | "auto-idle" | "spot";

// ---------------------------------------------------------------------------
// 起動候補（AZ × インスタンスタイプ）
// ---------------------------------------------------------------------------

export interface LaunchCandidate {
  az: string;
  instanceType: string;
  /** スポット候補のみ price を持つ（オンデマンド候補は undefined） */
  price?: number | undefined;
  subnetId: string;
}

/**
 * DescribeSpotPriceHistory の結果から、AZ×インスタンスタイプごとの最新価格を取り出し、
 * 安い順にソートした起動候補リストを作る（純粋関数・テスト対象）。
 * サブネットを持たない AZ / 対象外タイプは除外する。
 * 同価格は INSTANCE_TYPES の並び順を優先する。
 */
export function buildSpotCandidates(
  prices: readonly Pick<
    SpotPrice,
    "AvailabilityZone" | "InstanceType" | "SpotPrice" | "Timestamp"
  >[],
  subnetsByAz: Record<string, string>,
  instanceTypes: readonly string[],
): LaunchCandidate[] {
  const latest = new Map<string, { price: number; timestamp: number }>();
  for (const p of prices) {
    if (!p.AvailabilityZone || !p.InstanceType || !p.SpotPrice) continue;
    if (!(p.AvailabilityZone in subnetsByAz)) continue;
    if (!instanceTypes.includes(p.InstanceType)) continue;
    const price = Number(p.SpotPrice);
    if (!Number.isFinite(price)) continue;
    const key = `${p.AvailabilityZone}|${p.InstanceType}`;
    const timestamp = p.Timestamp?.getTime() ?? 0;
    const existing = latest.get(key);
    if (!existing || timestamp > existing.timestamp) {
      latest.set(key, { price, timestamp });
    }
  }
  const candidates: LaunchCandidate[] = [];
  for (const [key, { price }] of latest) {
    const [az, instanceType] = key.split("|") as [string, string];
    const subnetId = subnetsByAz[az];
    if (!subnetId) continue;
    candidates.push({ az, instanceType, price, subnetId });
  }
  return candidates.sort(
    (a, b) =>
      (a.price ?? 0) - (b.price ?? 0) ||
      instanceTypes.indexOf(a.instanceType) - instanceTypes.indexOf(b.instanceType) ||
      a.az.localeCompare(b.az),
  );
}

/**
 * オンデマンド起動候補を作る（純粋関数・テスト対象）。
 * スポット価格 API に依存せず、INSTANCE_TYPES の設定順 × AZ 名昇順で列挙する。
 */
export function buildOndemandCandidates(
  instanceTypes: readonly string[],
  subnetsByAz: Record<string, string>,
): LaunchCandidate[] {
  const azs = Object.keys(subnetsByAz).sort();
  const candidates: LaunchCandidate[] = [];
  for (const instanceType of instanceTypes) {
    for (const az of azs) {
      const subnetId = subnetsByAz[az];
      if (!subnetId) continue;
      candidates.push({ az, instanceType, subnetId });
    }
  }
  return candidates;
}

/** SUBNET_IDS から AZ → サブネットID のマップを作る */
export async function getSubnetsByAz(
  subnetIds: readonly string[],
): Promise<Record<string, string>> {
  const res = await ec2.send(new DescribeSubnetsCommand({ SubnetIds: [...subnetIds] }));
  const map: Record<string, string> = {};
  for (const subnet of res.Subnets ?? []) {
    if (subnet.AvailabilityZone && subnet.SubnetId) {
      map[subnet.AvailabilityZone] = subnet.SubnetId;
    }
  }
  return map;
}

/** 現在のスポット価格を照会し、安い順の起動候補を返す */
export async function fetchSpotCandidates(
  instanceTypes: readonly string[],
  subnetsByAz: Record<string, string>,
): Promise<LaunchCandidate[]> {
  const res = await ec2.send(
    new DescribeSpotPriceHistoryCommand({
      InstanceTypes: instanceTypes as _InstanceType[],
      ProductDescriptions: ["Linux/UNIX"],
      StartTime: new Date(),
    }),
  );
  return buildSpotCandidates(res.SpotPriceHistory ?? [], subnetsByAz, instanceTypes);
}

/** 単一 AZ×タイプの現在スポット価格（/status 用） */
export async function getCurrentSpotPrice(
  instanceType: string,
  az: string,
): Promise<number | undefined> {
  const res = await ec2.send(
    new DescribeSpotPriceHistoryCommand({
      InstanceTypes: [instanceType as _InstanceType],
      AvailabilityZone: az,
      ProductDescriptions: ["Linux/UNIX"],
      StartTime: new Date(),
    }),
  );
  const sorted = (res.SpotPriceHistory ?? [])
    .filter((p) => p.SpotPrice)
    .sort((a, b) => (b.Timestamp?.getTime() ?? 0) - (a.Timestamp?.getTime() ?? 0));
  const price = Number(sorted[0]?.SpotPrice);
  return Number.isFinite(price) ? price : undefined;
}

// ---------------------------------------------------------------------------
// スナップショット / ボリューム検索
// ---------------------------------------------------------------------------

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
  const latest = (res.Snapshots ?? [])
    .filter((s): s is Snapshot & { SnapshotId: string } => Boolean(s.SnapshotId))
    .sort((a, b) => (b.StartTime?.getTime() ?? 0) - (a.StartTime?.getTime() ?? 0))[0];
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
  const volume = (res.Volumes ?? []).sort(
    (a, b) => (b.CreateTime?.getTime() ?? 0) - (a.CreateTime?.getTime() ?? 0),
  )[0];
  if (!volume?.VolumeId || !volume.AvailabilityZone) return undefined;
  return { volumeId: volume.VolumeId, az: volume.AvailabilityZone };
}

// ---------------------------------------------------------------------------
// 起動 / 停止
// ---------------------------------------------------------------------------

export interface LaunchOptions {
  candidate: LaunchCandidate;
  launchTemplateId: string;
  /** true ならオンデマンド起動（InstanceMarketOptions を付けない） */
  ondemand: boolean;
  /**
   * データボリュームの BDM 上書き。undefined の場合はデータボリュームを作らない
   * （孤児ボリューム再利用時: 起動後に AttachVolume する）。
   */
  dataVolume?: { snapshotId?: string | undefined; sizeGb: number } | undefined;
}

/**
 * Launch Template + 上書きパラメータで 1 台起動する。
 * LT 側は market options を持たない前提で、スポット時は毎回 InstanceMarketOptions を付与する。
 */
export async function launchInstance(options: LaunchOptions): Promise<string> {
  const input: RunInstancesCommandInput = {
    LaunchTemplate: { LaunchTemplateId: options.launchTemplateId },
    MinCount: 1,
    MaxCount: 1,
    InstanceType: options.candidate.instanceType as _InstanceType,
    SubnetId: options.candidate.subnetId,
    // インスタンスタグ (mc:role=server, Name) は Launch Template 側の
    // tag_specifications が付与する。ここで重複指定すると同一キーの衝突になる。
    // データボリュームの mc:data タグは、volume TagSpecifications だと
    // ルートボリュームにも付いてしまうため、起動後に tagDataVolume() で付ける。
  };
  if (!options.ondemand) {
    input.InstanceMarketOptions = {
      MarketType: "spot",
      SpotOptions: {
        SpotInstanceType: "one-time",
        InstanceInterruptionBehavior: "terminate",
      },
    };
  }
  if (options.dataVolume) {
    input.BlockDeviceMappings = [
      {
        DeviceName: DATA_DEVICE_NAME,
        Ebs: {
          ...(options.dataVolume.snapshotId ? { SnapshotId: options.dataVolume.snapshotId } : {}),
          VolumeSize: options.dataVolume.sizeGb,
          VolumeType: "gp3",
          DeleteOnTermination: false,
        },
      },
    ];
  }
  const res = await ec2.send(new RunInstancesCommand(input));
  const instanceId = res.Instances?.[0]?.InstanceId;
  if (!instanceId) throw new Error("RunInstances がインスタンス ID を返しませんでした");
  log("info", "instance launched", {
    instanceId,
    az: options.candidate.az,
    instanceType: options.candidate.instanceType,
    ...(options.candidate.price !== undefined ? { spotPrice: options.candidate.price } : {}),
    ondemand: options.ondemand,
  });
  return instanceId;
}

/** 容量系エラー（次の候補へフォールバックすべきエラー）か判定する */
export function isRetryableCapacityError(err: unknown): boolean {
  const code =
    (err as { name?: string; Code?: string }).name ?? (err as { Code?: string }).Code ?? "";
  if (code.startsWith("Unsupported")) return true;
  return [
    "InsufficientInstanceCapacity",
    "SpotMaxPriceTooLow",
    "MaxSpotInstanceCountExceeded",
    "SpotLimitExceeded",
    "InstanceLimitExceeded",
  ].includes(code);
}

export interface InstanceInfo {
  instance: Instance;
  publicIp?: string;
  launchTime?: Date | undefined;
  dataVolumeId?: string | undefined;
}

export async function describeInstance(instanceId: string): Promise<Instance | undefined> {
  try {
    const res = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    return res.Reservations?.[0]?.Instances?.[0];
  } catch (err) {
    if ((err as { name?: string }).name === "InvalidInstanceID.NotFound") return undefined;
    throw err;
  }
}

/** パブリック IP が付与されるまで DescribeInstances をポーリングする */
export async function waitForInstance(
  instanceId: string,
  { timeoutMs = 180_000, intervalMs = 5_000 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<InstanceInfo> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const instance = await describeInstance(instanceId);
    const stateName = instance?.State?.Name;
    if (stateName === "terminated" || stateName === "shutting-down") {
      throw new Error(`インスタンス ${instanceId} は起動前に終了しました (${stateName})`);
    }
    if (instance?.PublicIpAddress && stateName === "running") {
      const dataVolumeId = instance.BlockDeviceMappings?.find(
        (m) => m.DeviceName === DATA_DEVICE_NAME,
      )?.Ebs?.VolumeId;
      return {
        instance,
        publicIp: instance.PublicIpAddress,
        launchTime: instance.LaunchTime,
        dataVolumeId,
      };
    }
    if (Date.now() >= deadline) {
      throw new Error(`インスタンス ${instanceId} のパブリック IP 取得がタイムアウトしました`);
    }
    await sleep(intervalMs);
  }
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

export async function terminateInstance(instanceId: string): Promise<void> {
  await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
  log("info", "instance terminate requested", { instanceId });
}

/** インスタンスに mc:stop-reason タグを付与する */
export async function tagStopReason(instanceId: string, reason: StopReason): Promise<void> {
  await ec2.send(
    new CreateTagsCommand({
      Resources: [instanceId],
      Tags: [{ Key: STOP_REASON_TAG_KEY, Value: reason }],
    }),
  );
}

// ---------------------------------------------------------------------------
// ライフサイクル（スナップショット・ボリューム掃除）
// ---------------------------------------------------------------------------

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
  const sorted = (res.Snapshots ?? [])
    .filter((s): s is Snapshot & { SnapshotId: string } => Boolean(s.SnapshotId))
    .sort((a, b) => (b.StartTime?.getTime() ?? 0) - (a.StartTime?.getTime() ?? 0));
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
