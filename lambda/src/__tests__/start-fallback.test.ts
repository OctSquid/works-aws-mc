import {
  DescribeInstancesCommand,
  DescribeSnapshotsCommand,
  DescribeSpotPriceHistoryCommand,
  DescribeSubnetsCommand,
  DescribeVolumesCommand,
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import { ChangeResourceRecordSetsCommand, Route53Client } from "@aws-sdk/client-route-53";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "../command-worker/handler";

const ec2Mock = mockClient(EC2Client);
const route53Mock = mockClient(Route53Client);
const ddbMock = mockClient(DynamoDBDocumentClient);

const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => "" }));

function capacityError(code: string): Error {
  return Object.assign(new Error(`capacity: ${code}`), { name: code });
}

function fetchBodies(): string[] {
  return fetchMock.mock.calls.map((call) => {
    const init = (call as unknown as [string, { body?: string }])[1];
    return init?.body ?? "";
  });
}

const START_EVENT = {
  command: "start",
  options: {},
  applicationId: "app-1",
  token: "tok-1",
  invokedBy: "steve",
};

describe("/start の候補フォールバック", () => {
  beforeEach(() => {
    vi.stubEnv("TABLE_NAME", "mc-state");
    vi.stubEnv("LAUNCH_TEMPLATE_ID", "lt-123");
    vi.stubEnv("SUBNET_IDS", "subnet-a,subnet-c,subnet-d");
    vi.stubEnv("HOSTED_ZONE_ID", "Z123");
    vi.stubEnv("SERVER_FQDN", "mc.example.com");
    vi.stubEnv("INSTANCE_TYPES", "m7a.large,m7i.large,m6a.large");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();

    ec2Mock.reset();
    route53Mock.reset();
    ddbMock.reset();

    // 状態遷移は常に成功させる（排他は state.test.ts で検証済み）
    ddbMock.on(UpdateCommand).callsFake((input: { ExpressionAttributeValues?: Record<string, unknown> }) => ({
      Attributes: {
        pk: "server",
        state: input.ExpressionAttributeValues?.[":to"],
        updated_at: new Date().toISOString(),
      },
    }));

    // 孤児ボリューム: 無し
    ec2Mock.on(DescribeVolumesCommand).resolves({ Volumes: [] });
    // 最新スナップショット
    ec2Mock.on(DescribeSnapshotsCommand).resolves({
      Snapshots: [{ SnapshotId: "snap-latest", State: "completed", StartTime: new Date() }],
    });
    ec2Mock.on(DescribeSubnetsCommand).resolves({
      Subnets: [
        { SubnetId: "subnet-a", AvailabilityZone: "ap-northeast-1a" },
        { SubnetId: "subnet-c", AvailabilityZone: "ap-northeast-1c" },
        { SubnetId: "subnet-d", AvailabilityZone: "ap-northeast-1d" },
      ],
    });
    // 価格: 1a/m7a が最安、次点 1c/m7i
    ec2Mock.on(DescribeSpotPriceHistoryCommand).resolves({
      SpotPriceHistory: [
        { AvailabilityZone: "ap-northeast-1a", InstanceType: "m7a.large", SpotPrice: "0.0400", Timestamp: new Date() },
        { AvailabilityZone: "ap-northeast-1c", InstanceType: "m7i.large", SpotPrice: "0.0500", Timestamp: new Date() },
        { AvailabilityZone: "ap-northeast-1d", InstanceType: "m6a.large", SpotPrice: "0.0600", Timestamp: new Date() },
      ],
    });
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: "i-ok",
              State: { Name: "running" },
              PublicIpAddress: "203.0.113.10",
              LaunchTime: new Date(),
              BlockDeviceMappings: [{ DeviceName: "/dev/sdf", Ebs: { VolumeId: "vol-new" } }],
            },
          ],
        },
      ],
    });
    route53Mock.on(ChangeResourceRecordSetsCommand).resolves({});
  });

  afterEach(() => {
    ec2Mock.restore();
    route53Mock.restore();
    ddbMock.restore();
  });

  it("最安候補が容量不足なら次候補で起動する", async () => {
    ec2Mock
      .on(RunInstancesCommand)
      .rejectsOnce(capacityError("InsufficientInstanceCapacity"))
      .resolves({ Instances: [{ InstanceId: "i-ok" }] });

    await handler(START_EVENT);

    const runCalls = ec2Mock.commandCalls(RunInstancesCommand);
    expect(runCalls).toHaveLength(2);
    // 1回目: 最安の 1a/m7a.large
    expect(runCalls[0]!.args[0].input).toMatchObject({
      SubnetId: "subnet-a",
      InstanceType: "m7a.large",
    });
    // 2回目: 次点の 1c/m7i.large
    expect(runCalls[1]!.args[0].input).toMatchObject({
      SubnetId: "subnet-c",
      InstanceType: "m7i.large",
    });
    // スポット指定は worker が毎回付与する（LT は market options を持たない前提）
    expect(runCalls[1]!.args[0].input.InstanceMarketOptions).toMatchObject({ MarketType: "spot" });
    // スナップショットから BDM 上書き
    expect(runCalls[1]!.args[0].input.BlockDeviceMappings?.[0]).toMatchObject({
      DeviceName: "/dev/sdf",
      Ebs: { SnapshotId: "snap-latest", VolumeType: "gp3", DeleteOnTermination: false },
    });

    // Route53 UPSERT
    const r53Calls = route53Mock.commandCalls(ChangeResourceRecordSetsCommand);
    expect(r53Calls).toHaveLength(1);
    expect(r53Calls[0]!.args[0].input.ChangeBatch?.Changes?.[0]).toMatchObject({
      Action: "UPSERT",
      ResourceRecordSet: {
        Name: "mc.example.com.",
        Type: "A",
        TTL: 60,
        ResourceRecords: [{ Value: "203.0.113.10" }],
      },
    });

    // state: STARTING → RUNNING（instance_id 等を記録）
    const updates = ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    const toRunning = updates.find((u) => u.ExpressionAttributeValues?.[":to"] === "RUNNING");
    expect(toRunning?.ExpressionAttributeValues).toMatchObject({
      ":set_instance_id": "i-ok",
      ":set_az": "ap-northeast-1c",
      ":set_instance_type": "m7i.large",
      ":set_spot_price": 0.05,
      ":set_volume_id": "vol-new",
    });

    // followup に接続情報が含まれる
    const bodies = fetchBodies();
    expect(bodies.some((b) => b.includes("mc.example.com") && b.includes("203.0.113.10"))).toBe(true);
  });

  it("SpotMaxPriceTooLow / Unsupported 系も次候補へフォールバックする", async () => {
    ec2Mock
      .on(RunInstancesCommand)
      .rejectsOnce(capacityError("SpotMaxPriceTooLow"))
      .rejectsOnce(capacityError("UnsupportedOperation"))
      .resolves({ Instances: [{ InstanceId: "i-ok" }] });

    await handler(START_EVENT);

    const runCalls = ec2Mock.commandCalls(RunInstancesCommand);
    expect(runCalls).toHaveLength(3);
    expect(runCalls[2]!.args[0].input).toMatchObject({
      SubnetId: "subnet-d",
      InstanceType: "m6a.large",
    });
  });

  it("全候補が失敗したら STOPPED に戻し ondemand を案内する", async () => {
    ec2Mock.on(RunInstancesCommand).rejects(capacityError("InsufficientInstanceCapacity"));

    await handler(START_EVENT);

    expect(ec2Mock.commandCalls(RunInstancesCommand)).toHaveLength(3);
    expect(ec2Mock.commandCalls(TerminateInstancesCommand)).toHaveLength(0);

    const updates = ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    expect(updates.some((u) => u.ExpressionAttributeValues?.[":to"] === "STOPPED")).toBe(true);

    const bodies = fetchBodies();
    expect(bodies.some((b) => b.includes("ondemand"))).toBe(true);
  });

  it("容量系以外のエラーは即中断し、state を戻してエラー通知する", async () => {
    ec2Mock.on(RunInstancesCommand).rejects(Object.assign(new Error("認証エラー"), { name: "UnauthorizedOperation" }));

    await handler(START_EVENT);

    // Unauthorized は Unsupported 系ではないのでフォールバックしない
    expect(ec2Mock.commandCalls(RunInstancesCommand)).toHaveLength(1);
    const updates = ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    expect(updates.some((u) => u.ExpressionAttributeValues?.[":to"] === "STOPPED")).toBe(true);
    const bodies = fetchBodies();
    expect(bodies.some((b) => b.includes("起動に失敗しました"))).toBe(true);
  });

  it("ondemand:true なら InstanceMarketOptions を付けない", async () => {
    ec2Mock.on(RunInstancesCommand).resolves({ Instances: [{ InstanceId: "i-ok" }] });

    await handler({ ...START_EVENT, options: { ondemand: true } });

    const runCalls = ec2Mock.commandCalls(RunInstancesCommand);
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]!.args[0].input.InstanceMarketOptions).toBeUndefined();
  });

  it("起動後の失敗（IP 取得不可）は terminate して STOPPED に戻す", async () => {
    ec2Mock.on(RunInstancesCommand).resolves({ Instances: [{ InstanceId: "i-ok" }] });
    // terminated として返す → waitForInstance が失敗する
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [{ Instances: [{ InstanceId: "i-ok", State: { Name: "terminated" as const } }] }],
    });

    await handler(START_EVENT);

    expect(ec2Mock.commandCalls(TerminateInstancesCommand)).toHaveLength(1);
    const updates = ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    expect(updates.some((u) => u.ExpressionAttributeValues?.[":to"] === "STOPPED")).toBe(true);
    const bodies = fetchBodies();
    expect(bodies.some((b) => b.includes("起動に失敗しました"))).toBe(true);
  });
});
