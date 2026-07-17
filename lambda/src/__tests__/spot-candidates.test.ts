import { describe, expect, it } from "vitest";
import { buildOndemandCandidates, buildSpotCandidates } from "../shared/ec2";

const SUBNETS: Record<string, string> = {
  "ap-northeast-1a": "subnet-a",
  "ap-northeast-1c": "subnet-c",
  "ap-northeast-1d": "subnet-d",
};

const TYPES = ["m6g.large", "m7g.large"];

function price(az: string, type: string, value: string, minutesAgo = 0) {
  return {
    AvailabilityZone: az,
    InstanceType: type as never,
    SpotPrice: value,
    Timestamp: new Date(Date.now() - minutesAgo * 60_000),
  };
}

describe("buildSpotCandidates（スポット価格ソート）", () => {
  it("安い順にソートした候補を返す", () => {
    const candidates = buildSpotCandidates(
      [
        price("ap-northeast-1a", "m6g.large", "0.0700"),
        price("ap-northeast-1c", "m6g.large", "0.0400"),
        price("ap-northeast-1d", "m7g.large", "0.0550"),
      ],
      SUBNETS,
      TYPES,
    );
    expect(candidates.map((c) => `${c.az}/${c.instanceType}`)).toEqual([
      "ap-northeast-1c/m6g.large",
      "ap-northeast-1d/m7g.large",
      "ap-northeast-1a/m6g.large",
    ]);
    expect(candidates[0]).toEqual({
      az: "ap-northeast-1c",
      instanceType: "m6g.large",
      price: 0.04,
      subnetId: "subnet-c",
    });
  });

  it("AZ×タイプごとに最新タイムスタンプの価格のみ採用する", () => {
    const candidates = buildSpotCandidates(
      [
        price("ap-northeast-1a", "m6g.large", "0.0100", 120), // 古い安値は無視される
        price("ap-northeast-1a", "m6g.large", "0.0800", 1),
        price("ap-northeast-1c", "m6g.large", "0.0500", 5),
      ],
      SUBNETS,
      TYPES,
    );
    expect(candidates.map((c) => c.price)).toEqual([0.05, 0.08]);
  });

  it("サブネットを持たない AZ と対象外タイプは除外する", () => {
    const candidates = buildSpotCandidates(
      [
        price("ap-northeast-1b", "m6g.large", "0.0100"), // サブネット無し AZ
        price("ap-northeast-1a", "t3.micro", "0.0010"), // 対象外タイプ
        price("ap-northeast-1a", "m7g.large", "0.0600"),
      ],
      SUBNETS,
      TYPES,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ az: "ap-northeast-1a", instanceType: "m7g.large" });
  });

  it("同価格なら INSTANCE_TYPES の並び順を優先する", () => {
    const candidates = buildSpotCandidates(
      [
        price("ap-northeast-1a", "m7g.large", "0.0500"),
        price("ap-northeast-1a", "m6g.large", "0.0500"),
      ],
      SUBNETS,
      TYPES,
    );
    expect(candidates.map((c) => c.instanceType)).toEqual(["m6g.large", "m7g.large"]);
  });

  it("価格が空・不正なエントリは無視する", () => {
    const candidates = buildSpotCandidates(
      [
        {
          AvailabilityZone: "ap-northeast-1a",
          InstanceType: "m6g.large" as never,
          SpotPrice: undefined,
        },
        {
          AvailabilityZone: "ap-northeast-1a",
          InstanceType: "m6g.large" as never,
          SpotPrice: "abc",
        },
      ],
      SUBNETS,
      TYPES,
    );
    expect(candidates).toEqual([]);
  });
});

describe("buildOndemandCandidates（オンデマンド候補）", () => {
  it("INSTANCE_TYPES の設定順 × AZ 名昇順で列挙する（価格 API 非依存）", () => {
    const candidates = buildOndemandCandidates(TYPES, SUBNETS);
    expect(candidates.map((c) => `${c.az}/${c.instanceType}`)).toEqual([
      "ap-northeast-1a/m6g.large",
      "ap-northeast-1c/m6g.large",
      "ap-northeast-1d/m6g.large",
      "ap-northeast-1a/m7g.large",
      "ap-northeast-1c/m7g.large",
      "ap-northeast-1d/m7g.large",
    ]);
    expect(candidates[0]).toEqual({
      az: "ap-northeast-1a",
      instanceType: "m6g.large",
      subnetId: "subnet-a",
    });
    expect(candidates.every((c) => c.price === undefined)).toBe(true);
  });

  it("サブネットが無ければ空配列を返す", () => {
    expect(buildOndemandCandidates(TYPES, {})).toEqual([]);
  });
});
