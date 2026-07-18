import { GetCommandInvocationCommand, SSMClient, SendCommandCommand } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "../command-worker/handler";
import { parseHealthOutput } from "../command-worker/health";
import { clampLines } from "../command-worker/logs";

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

const RUNNING_ITEM = {
  pk: "server",
  state: "RUNNING",
  instance_id: "i-run",
  updated_at: new Date().toISOString(),
};

const HEALTH_STDOUT = [
  "===PLAYERS===",
  "There are 2 of a max of 20 players online: steve, alex",
  "===TPS===",
  "§6TPS from last 1m, 5m, 15m: §a20.0, §a20.0, §a19.9",
  "===LOAD===",
  "0.52 0.48 0.40 / 2 cores",
  "===MEM===",
  "2900 / 7800 MB (37%)",
  "===DISK===",
  "5.1G / 20G (26%)",
].join("\n");

describe("parseHealthOutput", () => {
  it("マーカーで各セクションに分解しカラーコードを除去する", () => {
    expect(parseHealthOutput(HEALTH_STDOUT)).toEqual({
      players: "There are 2 of a max of 20 players online: steve, alex",
      tps: "TPS from last 1m, 5m, 15m: 20.0, 20.0, 19.9",
      load: "0.52 0.48 0.40 / 2 cores",
      memory: "2900 / 7800 MB (37%)",
      disk: "5.1G / 20G (26%)",
    });
  });

  it("空のセクションは undefined のまま", () => {
    expect(parseHealthOutput("===PLAYERS===\n\n===TPS===\n20.0")).toEqual({ tps: "20.0" });
  });
});

describe("clampLines", () => {
  it.each([
    [undefined, 50],
    [20, 20],
    [0, 50],
    [-5, 50],
    [999, 200],
    ["30", 30],
    ["abc", 50],
  ])("%s → %s", (input, expected) => {
    expect(clampLines(input)).toBe(expected);
  });
});

describe("/health と /logs", () => {
  beforeEach(() => {
    vi.stubEnv("TABLE_NAME", "mc-state");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
    ddbMock.reset();
    ssmMock.reset();

    ddbMock.on(GetCommand).resolves({ Item: RUNNING_ITEM });
    ssmMock.on(SendCommandCommand).resolves({ Command: { CommandId: "cmd-1" } });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    ddbMock.restore();
    ssmMock.restore();
  });

  it("health: 稼働中は各メトリクスを embed で返す", async () => {
    ssmMock.on(GetCommandInvocationCommand).resolves({
      Status: "Success",
      StandardOutputContent: HEALTH_STDOUT,
      ResponseCode: 0,
    });

    await handler({ command: "health", applicationId: "app-1", token: "tok-1" });

    const body = fetchBodies().find((b) => b.includes("ヘルス"));
    expect(body).toBeDefined();
    expect(body).toContain("2 of a max of 20");
    expect(body).toContain("19.9");
    expect(body).toContain("2 cores");
    expect(body).toContain("7800 MB");
    expect(body).toContain("20G");
  });

  it("health: 停止中は状態のみ返し SSM を呼ばない", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    await handler({ command: "health", applicationId: "app-1", token: "tok-1" });

    expect(ssmMock.commandCalls(SendCommandCommand)).toHaveLength(0);
    expect(fetchBodies().some((b) => b.includes("停止済み"))).toBe(true);
  });

  it("health: 取得失敗時は警告付き embed を返す", async () => {
    ssmMock.on(GetCommandInvocationCommand).resolves({
      Status: "Failed",
      StandardErrorContent: "agent error",
      ResponseCode: 1,
    });

    await handler({ command: "health", applicationId: "app-1", token: "tok-1" });

    expect(fetchBodies().some((b) => b.includes("取得に失敗"))).toBe(true);
  });

  it("logs: 指定行数で tail を実行し出力を返す", async () => {
    ssmMock.on(GetCommandInvocationCommand).resolves({
      Status: "Success",
      StandardOutputContent: "[12:00:00] [Server thread/INFO]: steve joined the game",
      ResponseCode: 0,
    });

    await handler({
      command: "logs",
      options: { lines: 20 },
      applicationId: "app-1",
      token: "tok-1",
    });

    const commands = ssmMock
      .commandCalls(SendCommandCommand)
      .flatMap((c) => c.args[0].input.Parameters?.["commands"] ?? []);
    expect(commands[0]).toContain("tail -n 20 /srv/minecraft/logs/latest.log");
    expect(fetchBodies().some((b) => b.includes("steve joined the game"))).toBe(true);
  });

  it("logs: 長大な出力は末尾優先で切り詰める", async () => {
    const longOutput = Array.from({ length: 500 }, (_, i) => `line-${i}`).join("\n");
    ssmMock.on(GetCommandInvocationCommand).resolves({
      Status: "Success",
      StandardOutputContent: longOutput,
      ResponseCode: 0,
    });

    await handler({ command: "logs", applicationId: "app-1", token: "tok-1" });

    const body = fetchBodies().find((b) => b.includes("latest.log"));
    expect(body).toBeDefined();
    expect(body).toContain("line-499");
    expect(body).not.toContain("line-0\\n");
    expect(body).toContain("切り詰め");
  });

  it("logs: サーバー未稼働なら実行しない", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { pk: "server", state: "STOPPED", updated_at: new Date().toISOString() },
    });

    await handler({ command: "logs", applicationId: "app-1", token: "tok-1" });

    expect(ssmMock.commandCalls(SendCommandCommand)).toHaveLength(0);
    expect(fetchBodies().some((b) => b.includes("稼働していない"))).toBe(true);
  });
});
