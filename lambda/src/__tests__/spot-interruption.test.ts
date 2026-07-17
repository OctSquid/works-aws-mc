import { CreateTagsCommand, EC2Client } from "@aws-sdk/client-ec2";
import { GetParameterCommand, SSMClient, SendCommandCommand } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSsmParameterCache } from "../shared/ssm";
import { handler } from "../spot-interruption/handler";

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

const WARNING_EVENT = {
  "detail-type": "EC2 Spot Instance Interruption Warning",
  detail: { "instance-id": "i-mc" },
};

describe("spot-interruption handler", () => {
  beforeEach(() => {
    vi.stubEnv("TABLE_NAME", "mc-state");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
    clearSsmParameterCache();

    ec2Mock.reset();
    ddbMock.reset();
    ssmMock.reset();

    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: "server",
        state: "RUNNING",
        instance_id: "i-mc",
        updated_at: new Date().toISOString(),
      },
    });
    ssmMock
      .on(GetParameterCommand)
      .resolves({ Parameter: { Value: "https://discord.example/webhook" } });
    ssmMock.on(SendCommandCommand).resolves({ Command: { CommandId: "cmd-1" } });
    ec2Mock.on(CreateTagsCommand).resolves({});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    ec2Mock.restore();
    ddbMock.restore();
    ssmMock.restore();
  });

  it("中断予告: 通知 → mc:stop-reason=spot タグ → 高速シャットダウン実行", async () => {
    await handler(WARNING_EVENT);

    const bodies = fetchMock.mock.calls.map(([, init]) => init?.body ?? "");
    expect(bodies.some((b) => b.includes("スポット中断予告"))).toBe(true);

    const tagCalls = ec2Mock.commandCalls(CreateTagsCommand);
    expect(tagCalls).toHaveLength(1);
    expect(tagCalls[0]!.args[0].input).toMatchObject({
      Resources: ["i-mc"],
      Tags: [{ Key: "mc:stop-reason", Value: "spot" }],
    });

    const cmdCalls = ssmMock.commandCalls(SendCommandCommand);
    expect(cmdCalls).toHaveLength(1);
    expect(cmdCalls[0]!.args[0].input.Parameters?.["commands"]?.[0]).toContain("spot --fast");
  });

  it("記録上のインスタンスと一致しなければ何もしない", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: "server",
        state: "RUNNING",
        instance_id: "i-another",
        updated_at: new Date().toISOString(),
      },
    });

    await handler(WARNING_EVENT);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(ec2Mock.commandCalls(CreateTagsCommand)).toHaveLength(0);
    expect(ssmMock.commandCalls(SendCommandCommand)).toHaveLength(0);
  });

  it("対象外の detail-type は無視する", async () => {
    await handler({ "detail-type": "EC2 Instance State-change Notification", detail: {} });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(ssmMock.commandCalls(SendCommandCommand)).toHaveLength(0);
  });

  it("SSM 実行が失敗しても throw しない（ベストエフォート）", async () => {
    ssmMock.on(SendCommandCommand).rejects(new Error("instance not reachable"));

    await expect(handler(WARNING_EVENT)).resolves.toBeUndefined();

    // 通知とタグ付けは実施済み
    expect(fetchMock).toHaveBeenCalled();
    expect(ec2Mock.commandCalls(CreateTagsCommand)).toHaveLength(1);
  });
});
