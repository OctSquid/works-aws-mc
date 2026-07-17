import {
  CreateSnapshotCommand,
  DeleteSnapshotCommand,
  DeleteVolumeCommand,
  DescribeInstancesCommand,
  DescribeSnapshotsCommand,
  DescribeVolumesCommand,
  EC2Client,
  type DescribeSnapshotsCommandInput,
} from "@aws-sdk/client-ec2";
import {
  ChangeResourceRecordSetsCommand,
  ListResourceRecordSetsCommand,
  Route53Client,
} from "@aws-sdk/client-route-53";
import { GetParameterCommand, SSMClient, SendCommandCommand } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "../lifecycle/handler";
import { clearSsmParameterCache } from "../shared/ssm";

const ec2Mock = mockClient(EC2Client);
const route53Mock = mockClient(Route53Client);
const ddbMock = mockClient(DynamoDBDocumentClient);
const ssmMock = mockClient(SSMClient);

const fetchMock = vi.fn<
  (
    url: string,
    init?: { body?: string },
  ) => Promise<{
    ok: boolean;
    status: number;
    headers: { get: (name: string) => string | null };
    text: () => Promise<string>;
  }>
>(async () => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  text: async () => "",
}));

function webhookBodies(): string[] {
  return fetchMock.mock.calls.map(([, init]) => init?.body ?? "");
}

const MC_TAGS = [
  { Key: "mc:role", Value: "server" },
  { Key: "mc:stop-reason", Value: "manual" },
];

const TERMINATED_EVENT = {
  "detail-type": "EC2 Instance State-change Notification",
  detail: { state: "terminated", "instance-id": "i-mc" },
};

function snapshotEvent(snapshotId: string, source = "arn:aws:ec2:ap-northeast-1::volume/vol-data") {
  return {
    "detail-type": "EBS Snapshot Notification",
    detail: {
      event: "createSnapshot",
      result: "succeeded",
      snapshot_id: `arn:aws:ec2:ap-northeast-1::snapshot/${snapshotId}`,
      source,
    },
  };
}

describe("lifecycle handler", () => {
  beforeEach(() => {
    vi.stubEnv("TABLE_NAME", "mc-state");
    vi.stubEnv("HOSTED_ZONE_ID", "Z123");
    vi.stubEnv("SERVER_FQDN", "mc.example.com");
    vi.stubEnv("SNAPSHOT_RETENTION", "3");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
    clearSsmParameterCache();

    ec2Mock.reset();
    route53Mock.reset();
    ddbMock.reset();
    ssmMock.reset();

    ssmMock
      .on(GetParameterCommand)
      .resolves({ Parameter: { Value: "https://discord.example/webhook" } });

    // DNS: A レコードが存在し、削除できる
    route53Mock.on(ListResourceRecordSetsCommand).resolves({
      ResourceRecordSets: [{ Name: "mc.example.com.", Type: "A", TTL: 60 }],
    });
    route53Mock.on(ChangeResourceRecordSetsCommand).resolves({});

    ddbMock
      .on(UpdateCommand)
      .callsFake((input: { ExpressionAttributeValues?: Record<string, unknown> }) => ({
        Attributes: {
          pk: "server",
          state: input.ExpressionAttributeValues?.[":to"],
          updated_at: new Date().toISOString(),
        },
      }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    ec2Mock.restore();
    route53Mock.restore();
    ddbMock.restore();
    ssmMock.restore();
  });

  // -------------------------------------------------------------------------
  // terminated イベント
  // -------------------------------------------------------------------------

  it("terminated: DNS 削除 → スナップショット作成 → SNAPSHOTTING 遷移 → 通知", async () => {
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [{ Instances: [{ InstanceId: "i-mc", Tags: MC_TAGS }] }],
    });
    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: "server",
        state: "RUNNING",
        instance_id: "i-mc",
        volume_id: "vol-data",
        updated_at: new Date().toISOString(),
      },
    });
    ec2Mock.on(DescribeVolumesCommand).resolves({ Volumes: [{ State: "available" }] });
    ec2Mock.on(CreateSnapshotCommand).resolves({ SnapshotId: "snap-new" });

    await handler(TERMINATED_EVENT);

    // DNS レコード削除
    const r53Calls = route53Mock.commandCalls(ChangeResourceRecordSetsCommand);
    expect(r53Calls).toHaveLength(1);
    expect(r53Calls[0]!.args[0].input.ChangeBatch?.Changes?.[0]?.Action).toBe("DELETE");

    // スナップショット作成（mc:data タグ付き）
    const snapCalls = ec2Mock.commandCalls(CreateSnapshotCommand);
    expect(snapCalls).toHaveLength(1);
    expect(snapCalls[0]!.args[0].input.VolumeId).toBe("vol-data");
    expect(snapCalls[0]!.args[0].input.TagSpecifications?.[0]?.Tags).toContainEqual({
      Key: "mc:data",
      Value: "true",
    });

    // SNAPSHOTTING へ遷移（snapshot_id / volume_id / instance_id を記録）
    const updates = ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    const toSnapshotting = updates.find(
      (u) => u.ExpressionAttributeValues?.[":to"] === "SNAPSHOTTING",
    );
    expect(toSnapshotting?.ExpressionAttributeValues).toMatchObject({
      ":set_snapshot_id": "snap-new",
      ":set_volume_id": "vol-data",
      ":set_instance_id": "i-mc",
    });

    // 停止理由（manual）に応じた通知
    const bodies = webhookBodies();
    expect(bodies.some((b) => b.includes("手動停止") && b.includes("バックアップ"))).toBe(true);
  });

  it("terminated: mc-server 以外のインスタンスは無視する", async () => {
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [
        { Instances: [{ InstanceId: "i-other", Tags: [{ Key: "Name", Value: "web" }] }] },
      ],
    });

    await handler({
      "detail-type": "EC2 Instance State-change Notification",
      detail: { state: "terminated", "instance-id": "i-other" },
    });

    expect(ec2Mock.commandCalls(CreateSnapshotCommand)).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("terminated: 既に SNAPSHOTTING なら重複イベントとして無視する", async () => {
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [{ Instances: [{ InstanceId: "i-mc", Tags: MC_TAGS }] }],
    });
    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: "server",
        state: "SNAPSHOTTING",
        instance_id: "i-mc",
        updated_at: new Date().toISOString(),
      },
    });

    await handler(TERMINATED_EVENT);

    expect(ec2Mock.commandCalls(CreateSnapshotCommand)).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("terminated: データボリュームが見つからなければ STOPPED に戻し警告を通知する", async () => {
    // record にも BDM にも volume が無く、孤児ボリューム検索も空
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [{ Instances: [{ InstanceId: "i-mc", Tags: MC_TAGS }] }],
    });
    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: "server",
        state: "RUNNING",
        instance_id: "i-mc",
        updated_at: new Date().toISOString(),
      },
    });
    ec2Mock.on(DescribeVolumesCommand).resolves({ Volumes: [] });

    await handler(TERMINATED_EVENT);

    expect(ec2Mock.commandCalls(CreateSnapshotCommand)).toHaveLength(0);
    const updates = ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    const toStopped = updates.find((u) => u.ExpressionAttributeValues?.[":to"] === "STOPPED");
    expect(toStopped?.UpdateExpression).toContain("REMOVE");
    const bodies = webhookBodies();
    expect(bodies.some((b) => b.includes("バックアップは作成されませんでした"))).toBe(true);
  });

  it("terminated: ボリュームが available にならなければ volume_id を保持して STOPPED に戻す", async () => {
    vi.useFakeTimers();
    try {
      ec2Mock.on(DescribeInstancesCommand).resolves({
        Reservations: [{ Instances: [{ InstanceId: "i-mc", Tags: MC_TAGS }] }],
      });
      ddbMock.on(GetCommand).resolves({
        Item: {
          pk: "server",
          state: "RUNNING",
          instance_id: "i-mc",
          volume_id: "vol-stuck",
          updated_at: new Date().toISOString(),
        },
      });
      // ずっと in-use のまま → waitForVolumeAvailable がタイムアウトする
      ec2Mock.on(DescribeVolumesCommand).resolves({ Volumes: [{ State: "in-use" }] });

      const promise = handler(TERMINATED_EVENT);
      await vi.runAllTimersAsync();
      await promise;

      expect(ec2Mock.commandCalls(CreateSnapshotCommand)).toHaveLength(0);
      const updates = ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input);
      const toStopped = updates.find((u) => u.ExpressionAttributeValues?.[":to"] === "STOPPED");
      // 次回 /start が孤児ボリュームとして再利用できるよう volume_id を残す
      expect(toStopped?.ExpressionAttributeValues).toMatchObject({ ":set_volume_id": "vol-stuck" });
      const bodies = webhookBodies();
      expect(bodies.some((b) => b.includes("available になりませんでした"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // -------------------------------------------------------------------------
  // snapshot completed イベント
  // -------------------------------------------------------------------------

  it("snapshot 完了: ボリューム削除 → 世代整理 → STOPPED 遷移 → 完了通知", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: "server",
        state: "SNAPSHOTTING",
        snapshot_id: "snap-new",
        volume_id: "vol-data",
        instance_id: "i-mc",
        updated_at: new Date().toISOString(),
      },
    });
    ec2Mock.on(DeleteVolumeCommand).resolves({});
    // 世代整理: 新しい順に 5 世代 → retention 3 で最古の 2 つを削除
    const day = 24 * 60 * 60 * 1000;
    ec2Mock.on(DescribeSnapshotsCommand).resolves({
      Snapshots: [0, 1, 2, 3, 4].map((i) => ({
        SnapshotId: i === 0 ? "snap-new" : `snap-old${i}`,
        StartTime: new Date(Date.now() - i * day),
      })),
    });
    ec2Mock.on(DeleteSnapshotCommand).resolves({});

    await handler(snapshotEvent("snap-new"));

    expect(ec2Mock.commandCalls(DeleteVolumeCommand).map((c) => c.args[0].input.VolumeId)).toEqual([
      "vol-data",
    ]);
    expect(
      ec2Mock.commandCalls(DeleteSnapshotCommand).map((c) => c.args[0].input.SnapshotId),
    ).toEqual(["snap-old3", "snap-old4"]);

    const updates = ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    const toStopped = updates.find((u) => u.ExpressionAttributeValues?.[":to"] === "STOPPED");
    expect(toStopped?.ExpressionAttributeValues).toMatchObject({ ":set_snapshot_id": "snap-new" });
    expect(toStopped?.UpdateExpression).toContain("REMOVE");

    const bodies = webhookBodies();
    expect(bodies.some((b) => b.includes("バックアップ完了"))).toBe(true);
  });

  it("snapshot 完了: 既に STOPPED 済みなら重複イベントとして無視する", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: "server",
        state: "STOPPED",
        snapshot_id: "snap-new",
        updated_at: new Date().toISOString(),
      },
    });

    await handler(snapshotEvent("snap-new"));

    expect(ec2Mock.commandCalls(DeleteVolumeCommand)).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("snapshot 完了: mc:data スナップショットでなければ無視する", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    // isDataSnapshot: タグ無し → 対象外
    ec2Mock
      .on(DescribeSnapshotsCommand)
      .callsFake((input: DescribeSnapshotsCommandInput) =>
        input.SnapshotIds
          ? { Snapshots: [{ SnapshotId: "snap-foreign", Tags: [] }] }
          : { Snapshots: [] },
      );

    await handler(snapshotEvent("snap-foreign"));

    expect(ec2Mock.commandCalls(DeleteVolumeCommand)).toHaveLength(0);
    expect(ec2Mock.commandCalls(DeleteSnapshotCommand)).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // watchdog tick（AWS 側バックストップ）
  // -------------------------------------------------------------------------

  const TICK_EVENT = { "detail-type": "MC Watchdog Tick" };

  it("tick: 最大稼働時間を超えていたら graceful shutdown を実行して通知する", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: "server",
        state: "RUNNING",
        instance_id: "i-mc",
        updated_at: new Date().toISOString(),
      },
    });
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: "i-mc",
              State: { Name: "running" },
              LaunchTime: new Date(Date.now() - 13 * 60 * 60 * 1000), // 13時間前（上限12時間）
            },
          ],
        },
      ],
    });
    ssmMock.on(SendCommandCommand).resolves({ Command: { CommandId: "cmd-1" } });

    await handler(TICK_EVENT);

    const cmdCalls = ssmMock.commandCalls(SendCommandCommand);
    expect(cmdCalls).toHaveLength(1);
    expect(cmdCalls[0]!.args[0].input.Parameters?.["commands"]?.[0]).toContain("max-runtime");
    expect(webhookBodies().some((b) => b.includes("上限") && b.includes("強制停止"))).toBe(true);
  });

  it("tick: 稼働時間が上限内なら何もしない", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: "server",
        state: "RUNNING",
        instance_id: "i-mc",
        updated_at: new Date().toISOString(),
      },
    });
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: "i-mc",
              State: { Name: "running" },
              LaunchTime: new Date(Date.now() - 60 * 60 * 1000),
            },
          ],
        },
      ],
    });

    await handler(TICK_EVENT);

    expect(ssmMock.commandCalls(SendCommandCommand)).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tick: RUNNING なのにインスタンスが存在しなければ STOPPED に戻して通知する", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: "server",
        state: "RUNNING",
        instance_id: "i-gone",
        updated_at: new Date().toISOString(),
      },
    });
    ec2Mock
      .on(DescribeInstancesCommand)
      .rejects(Object.assign(new Error("not found"), { name: "InvalidInstanceID.NotFound" }));

    await handler(TICK_EVENT);

    const updates = ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    expect(updates.some((u) => u.ExpressionAttributeValues?.[":to"] === "STOPPED")).toBe(true);
    expect(webhookBodies().some((b) => b.includes("インスタンスが見つかりませんでした"))).toBe(
      true,
    );
  });

  it("tick: RUNNING でインスタンスが terminated 済みなら terminated 経路を再駆動する", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: "server",
        state: "RUNNING",
        instance_id: "i-mc",
        volume_id: "vol-data",
        updated_at: new Date().toISOString(),
      },
    });
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [
        { Instances: [{ InstanceId: "i-mc", State: { Name: "terminated" }, Tags: MC_TAGS }] },
      ],
    });
    ec2Mock.on(DescribeVolumesCommand).resolves({ Volumes: [{ State: "available" }] });
    ec2Mock.on(CreateSnapshotCommand).resolves({ SnapshotId: "snap-recovered" });

    await handler(TICK_EVENT);

    // 取りこぼした terminated イベントの代わりにスナップショット作成まで進む
    expect(ec2Mock.commandCalls(CreateSnapshotCommand)).toHaveLength(1);
  });

  it("tick: SNAPSHOTTING が停滞していて snapshot が完了済みなら完了経路を駆動する", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: "server",
        state: "SNAPSHOTTING",
        snapshot_id: "snap-new",
        volume_id: "vol-data",
        updated_at: new Date(Date.now() - 40 * 60 * 1000).toISOString(), // 40分停滞
      },
    });
    ec2Mock
      .on(DescribeSnapshotsCommand)
      .callsFake((input: DescribeSnapshotsCommandInput) =>
        input.SnapshotIds
          ? { Snapshots: [{ SnapshotId: "snap-new", State: "completed" }] }
          : { Snapshots: [] },
      );
    ec2Mock.on(DeleteVolumeCommand).resolves({});

    await handler(TICK_EVENT);

    expect(ec2Mock.commandCalls(DeleteVolumeCommand).map((c) => c.args[0].input.VolumeId)).toEqual([
      "vol-data",
    ]);
    const updates = ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    expect(updates.some((u) => u.ExpressionAttributeValues?.[":to"] === "STOPPED")).toBe(true);
    expect(webhookBodies().some((b) => b.includes("バックアップ完了"))).toBe(true);
  });

  it("tick: STARTING の長時間停滞は警告のみ通知する", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: "server",
        state: "STARTING",
        updated_at: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
      },
    });

    await handler(TICK_EVENT);

    expect(webhookBodies().some((b) => b.includes("停滞しています"))).toBe(true);
    expect(ec2Mock.commandCalls(CreateSnapshotCommand)).toHaveLength(0);
  });

  it("snapshot 完了: ボリューム削除に失敗しても世代整理と STOPPED 遷移は行う", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: "server",
        state: "SNAPSHOTTING",
        snapshot_id: "snap-new",
        volume_id: "vol-data",
        updated_at: new Date().toISOString(),
      },
    });
    ec2Mock
      .on(DeleteVolumeCommand)
      .rejects(Object.assign(new Error("in use"), { name: "VolumeInUse" }));
    ec2Mock.on(DescribeSnapshotsCommand).resolves({ Snapshots: [] });

    await handler(snapshotEvent("snap-new"));

    const updates = ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    expect(updates.some((u) => u.ExpressionAttributeValues?.[":to"] === "STOPPED")).toBe(true);
    const bodies = webhookBodies();
    expect(bodies.some((b) => b.includes("ボリューム削除に失敗"))).toBe(true);
    expect(bodies.some((b) => b.includes("バックアップ完了"))).toBe(true);
  });
});
