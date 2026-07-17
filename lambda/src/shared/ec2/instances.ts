/** インスタンスの起動・監視・停止・タグ付け */
import {
  CreateTagsCommand,
  DescribeInstancesCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
  type Instance,
  type RunInstancesCommandInput,
  type _InstanceType,
} from "@aws-sdk/client-ec2";
import { log, sleep } from "../config";
import type { LaunchCandidate } from "./candidates";
import { ec2 } from "./client";
import { DATA_DEVICE_NAME, STOP_REASON_TAG_KEY, TAG_ROLE, type StopReason } from "./constants";

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

/**
 * mc:role=server タグ付きで pending / running のインスタンスを探す。
 * /start の二重起動ガード用: stale-takeover 後も前回のインスタンスが
 * 生きているケースを RunInstances 前に検出する。
 */
export async function findRunningServerInstance(): Promise<
  { instanceId: string; state: string } | undefined
> {
  const res = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: `tag:${TAG_ROLE.Key}`, Values: [TAG_ROLE.Value] },
        { Name: "instance-state-name", Values: ["pending", "running"] },
      ],
    }),
  );
  const instance = res.Reservations?.flatMap((r) => r.Instances ?? [])[0];
  if (!instance?.InstanceId) return undefined;
  return { instanceId: instance.InstanceId, state: instance.State?.Name ?? "unknown" };
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
