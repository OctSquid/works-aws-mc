import { GetCommandInvocationCommand, SSMClient, SendCommandCommand } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "../command-worker/handler";

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

function sentShellCommands(): string[] {
  return ssmMock
    .commandCalls(SendCommandCommand)
    .flatMap((c) => c.args[0].input.Parameters?.["commands"] ?? []);
}

const BASE_EVENT = {
  command: "admin",
  applicationId: "app-1",
  token: "tok-1",
  invokedBy: "steve",
};

describe("/admin", () => {
  beforeEach(() => {
    vi.stubEnv("TABLE_NAME", "mc-state");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
    ddbMock.reset();
    ssmMock.reset();

    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: "server",
        state: "RUNNING",
        instance_id: "i-run",
        updated_at: new Date().toISOString(),
      },
    });
    ssmMock.on(SendCommandCommand).resolves({ Command: { CommandId: "cmd-1" } });
    ssmMock.on(GetCommandInvocationCommand).resolves({
      Status: "Success",
      StandardOutputContent: "Made steve a server operator",
      ResponseCode: 0,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    ddbMock.restore();
    ssmMock.restore();
  });

  it("op: rcon.sh をクォート済み引数で実行し出力を返す", async () => {
    await handler({ ...BASE_EVENT, subcommand: "op", options: { player: "steve" } });

    expect(sentShellCommands()).toEqual(["/opt/minecraft/bin/rcon.sh 'op steve'"]);
    expect(fetchBodies().some((b) => b.includes("Made steve a server operator"))).toBe(true);
  });

  it("ban: reason 付きでもシェルインジェクションできない", async () => {
    await handler({
      ...BASE_EVENT,
      subcommand: "ban",
      options: { player: "griefer_1", reason: "griefing'; rm -rf / #" },
    });

    expect(sentShellCommands()).toEqual([
      `/opt/minecraft/bin/rcon.sh 'ban griefer_1 griefing'\\''; rm -rf / #'`,
    ]);
  });

  it("不正なプレイヤー名は SSM を呼ばずにエラーを返す", async () => {
    await handler({
      ...BASE_EVENT,
      subcommand: "op",
      options: { player: "bad name; reboot" },
    });

    expect(ssmMock.commandCalls(SendCommandCommand)).toHaveLength(0);
    expect(fetchBodies().some((b) => b.includes("プレイヤー名が不正"))).toBe(true);
  });

  it("whitelist グループのサブコマンドをディスパッチする", async () => {
    await handler({
      ...BASE_EVENT,
      subcommandGroup: "whitelist",
      subcommand: "add",
      options: { player: "alex" },
    });

    expect(sentShellCommands()).toEqual(["/opt/minecraft/bin/rcon.sh 'whitelist add alex'"]);
  });

  it("cmd: 任意コマンドを実行できる（先頭の / は除去）", async () => {
    await handler({ ...BASE_EVENT, subcommand: "cmd", options: { command: "/say hello" } });

    expect(sentShellCommands()).toEqual(["/opt/minecraft/bin/rcon.sh 'say hello'"]);
  });

  it("cmd: stop はブロックして /stop へ誘導する", async () => {
    await handler({ ...BASE_EVENT, subcommand: "cmd", options: { command: "stop" } });

    expect(ssmMock.commandCalls(SendCommandCommand)).toHaveLength(0);
    expect(fetchBodies().some((b) => b.includes("/stop"))).toBe(true);
  });

  it("サーバー未稼働なら実行せずその旨を伝える", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { pk: "server", state: "STOPPED", updated_at: new Date().toISOString() },
    });

    await handler({ ...BASE_EVENT, subcommand: "op", options: { player: "steve" } });

    expect(ssmMock.commandCalls(SendCommandCommand)).toHaveLength(0);
    expect(fetchBodies().some((b) => b.includes("稼働していない"))).toBe(true);
  });

  it("RCON 失敗時は stderr を赤 embed で返す", async () => {
    ssmMock.on(GetCommandInvocationCommand).resolves({
      Status: "Failed",
      StandardErrorContent: "connection refused",
      ResponseCode: 1,
    });

    await handler({ ...BASE_EVENT, subcommand: "banlist", options: {} });

    expect(fetchBodies().some((b) => b.includes("connection refused"))).toBe(true);
  });
});
