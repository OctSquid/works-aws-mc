import {
  CreateTagsCommand,
  DescribeInstancesCommand,
  DescribeSpotPriceHistoryCommand,
  EC2Client,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import { SSMClient, SendCommandCommand } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "../command-worker/handler";

const ec2Mock = mockClient(EC2Client);
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

function fetchBodies(): string[] {
  return fetchMock.mock.calls.map(([, init]) => init?.body ?? "");
}

function conditionalFailure(): Error {
  return Object.assign(new Error("conditional check failed"), {
    name: "ConditionalCheckFailedException",
  });
}

const STOP_EVENT = {
  command: "stop",
  options: {},
  applicationId: "app-1",
  token: "tok-1",
  invokedBy: "steve",
};

const STATUS_EVENT = { ...STOP_EVENT, command: "status" };

describe("/stop と /status", () => {
  beforeEach(() => {
    vi.stubEnv("TABLE_NAME", "mc-state");
    vi.stubEnv("SERVER_FQDN", "mc.example.com");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();

    ec2Mock.reset();
    ddbMock.reset();
    ssmMock.reset();

    // RUNNING → STOPPING が成功し、記録に instance_id がある状態
    ddbMock
      .on(UpdateCommand)
      .callsFake((input: { ExpressionAttributeValues?: Record<string, unknown> }) => ({
        Attributes: {
          pk: "server",
          state: input.ExpressionAttributeValues?.[":to"],
          instance_id: "i-run",
          updated_at: new Date().toISOString(),
        },
      }));
    ssmMock.on(SendCommandCommand).resolves({ Command: { CommandId: "cmd-1" } });
    ec2Mock.on(CreateTagsCommand).resolves({});
    ec2Mock.on(TerminateInstancesCommand).resolves({});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    ec2Mock.restore();
    ddbMock.restore();
    ssmMock.restore();
  });

  // -------------------------------------------------------------------------
  // /stop
  // -------------------------------------------------------------------------

  it("stop: インスタンス上のシャットダウンスクリプトを実行して応答する", async () => {
    await handler(STOP_EVENT);

    const cmdCalls = ssmMock.commandCalls(SendCommandCommand);
    expect(cmdCalls).toHaveLength(1);
    expect(cmdCalls[0]!.args[0].input.InstanceIds).toEqual(["i-run"]);
    expect(cmdCalls[0]!.args[0].input.Parameters?.["commands"]?.[0]).toContain(
      "mc-shutdown.sh manual",
    );
    // SSM 経由の正常経路では直接 terminate しない
    expect(ec2Mock.commandCalls(TerminateInstancesCommand)).toHaveLength(0);
    expect(fetchBodies().some((b) => b.includes("停止処理を開始しました"))).toBe(true);
  });

  it("stop: RUNNING でなければ現在の状態を伝えて何もしない", async () => {
    ddbMock.on(UpdateCommand).rejects(conditionalFailure());
    ddbMock.on(GetCommand).resolves({
      Item: { pk: "server", state: "STARTING", updated_at: new Date().toISOString() },
    });

    await handler(STOP_EVENT);

    expect(ssmMock.commandCalls(SendCommandCommand)).toHaveLength(0);
    expect(fetchBodies().some((b) => b.includes("既に操作が進行中"))).toBe(true);
  });

  it("stop: instance_id 未記録なら STOPPED に戻して知らせる", async () => {
    ddbMock
      .on(UpdateCommand)
      .callsFake((input: { ExpressionAttributeValues?: Record<string, unknown> }) => ({
        Attributes: {
          pk: "server",
          state: input.ExpressionAttributeValues?.[":to"],
          updated_at: new Date().toISOString(),
        },
      }));

    await handler(STOP_EVENT);

    const updates = ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    expect(updates.some((u) => u.ExpressionAttributeValues?.[":to"] === "STOPPED")).toBe(true);
    expect(ssmMock.commandCalls(SendCommandCommand)).toHaveLength(0);
    expect(fetchBodies().some((b) => b.includes("記録されていませんでした"))).toBe(true);
  });

  it("stop: SSM 実行に失敗したら停止理由をタグ付けして直接 terminate する", async () => {
    ssmMock.on(SendCommandCommand).rejects(new Error("SSM agent offline"));

    await handler(STOP_EVENT);

    const tagCalls = ec2Mock.commandCalls(CreateTagsCommand);
    expect(tagCalls[0]!.args[0].input.Tags).toEqual([{ Key: "mc:stop-reason", Value: "manual" }]);
    expect(ec2Mock.commandCalls(TerminateInstancesCommand)).toHaveLength(1);
    expect(fetchBodies().some((b) => b.includes("停止処理を開始しました"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // /status
  // -------------------------------------------------------------------------

  it("status: 記録が無ければ停止中と答える", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    await handler(STATUS_EVENT);

    expect(fetchBodies().some((b) => b.includes("停止中"))).toBe(true);
  });

  it("status: 稼働中は接続先・稼働時間・スポット価格を返す", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: "server",
        state: "RUNNING",
        instance_id: "i-run",
        az: "ap-northeast-1a",
        instance_type: "m6g.large",
        spot_price: 0.04,
        updated_at: new Date().toISOString(),
      },
    });
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: "i-run",
              State: { Name: "running" },
              PublicIpAddress: "203.0.113.10",
              LaunchTime: new Date(Date.now() - 90 * 60 * 1000),
            },
          ],
        },
      ],
    });
    ec2Mock.on(DescribeSpotPriceHistoryCommand).resolves({
      SpotPriceHistory: [
        {
          AvailabilityZone: "ap-northeast-1a",
          InstanceType: "m6g.large",
          SpotPrice: "0.0450",
          Timestamp: new Date(),
        },
      ],
    });

    await handler(STATUS_EVENT);

    const body = fetchBodies().find((b) => b.includes("状態"));
    expect(body).toBeDefined();
    expect(body).toContain("mc.example.com");
    expect(body).toContain("203.0.113.10");
    expect(body).toContain("1時間30分");
    expect(body).toContain("0.0450");
  });

  it("status: 記録上のインスタンスが終了済みならその旨を伝える", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: "server",
        state: "RUNNING",
        instance_id: "i-run",
        updated_at: new Date().toISOString(),
      },
    });
    ec2Mock.on(DescribeInstancesCommand).resolves({
      Reservations: [{ Instances: [{ InstanceId: "i-run", State: { Name: "terminated" } }] }],
    });

    await handler(STATUS_EVENT);

    expect(fetchBodies().some((b) => b.includes("既に終了しています"))).toBe(true);
  });

  it("不明なコマンドはエラーメッセージを返す", async () => {
    await handler({ ...STOP_EVENT, command: "restart" });

    expect(fetchBodies().some((b) => b.includes("不明なコマンド"))).toBe(true);
  });
});
