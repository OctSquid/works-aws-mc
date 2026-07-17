/** 起動候補（AZ × インスタンスタイプ）の構築とスポット価格照会 */
import {
  DescribeSpotPriceHistoryCommand,
  DescribeSubnetsCommand,
  type SpotPrice,
  type _InstanceType,
} from "@aws-sdk/client-ec2";
import { sortLatestFirst } from "../util";
import { ec2 } from "./client";

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
  const latest = sortLatestFirst(
    (res.SpotPriceHistory ?? []).filter((p) => p.SpotPrice),
    (p) => p.Timestamp,
  )[0];
  const price = Number(latest?.SpotPrice);
  return Number.isFinite(price) ? price : undefined;
}
