import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STALE_TAKEOVER_MS,
  canTransition,
  transitionState,
  type ServerRecord,
} from "../shared/state";

const ddbMock = mockClient(DynamoDBDocumentClient);

const NOW = new Date("2026-07-10T12:00:00.000Z");

function record(
  state: ServerRecord["state"],
  ageMs: number,
): Pick<ServerRecord, "state" | "updated_at"> {
  return { state, updated_at: new Date(NOW.getTime() - ageMs).toISOString() };
}

describe("canTransition（状態遷移の意味論）", () => {
  it("アイテム未作成は STOPPED とみなす", () => {
    expect(canTransition(undefined, ["STOPPED"], NOW)).toBe(true);
    expect(canTransition(undefined, ["RUNNING"], NOW)).toBe(false);
  });

  it("現在状態が from に一致すれば遷移できる", () => {
    expect(canTransition(record("STOPPED", 0), ["STOPPED"], NOW)).toBe(true);
    expect(canTransition(record("RUNNING", 0), ["RUNNING"], NOW)).toBe(true);
  });

  it("状態が不一致なら遷移できない（/start 連打の二重起動防止）", () => {
    expect(canTransition(record("STARTING", 60_000), ["STOPPED"], NOW)).toBe(false);
    expect(canTransition(record("RUNNING", 60_000), ["STOPPED"], NOW)).toBe(false);
  });

  it("STARTING/STOPPING/SNAPSHOTTING は15分以上前なら奪取できる", () => {
    for (const state of ["STARTING", "STOPPING", "SNAPSHOTTING"] as const) {
      expect(canTransition(record(state, STALE_TAKEOVER_MS), ["STOPPED"], NOW)).toBe(true);
      expect(canTransition(record(state, STALE_TAKEOVER_MS + 1), ["STOPPED"], NOW)).toBe(true);
    }
  });

  it("15分未満のスタック候補状態は奪取できない", () => {
    expect(canTransition(record("STARTING", STALE_TAKEOVER_MS - 1), ["STOPPED"], NOW)).toBe(false);
    expect(canTransition(record("STOPPING", 60_000), ["RUNNING"], NOW)).toBe(false);
  });

  it("RUNNING / STOPPED は古くても奪取できない", () => {
    expect(canTransition(record("RUNNING", STALE_TAKEOVER_MS * 10), ["STOPPED"], NOW)).toBe(false);
    expect(canTransition(record("STOPPED", STALE_TAKEOVER_MS * 10), ["RUNNING"], NOW)).toBe(false);
  });
});

describe("transitionState（DynamoDB 条件付き更新）", () => {
  beforeEach(() => {
    vi.stubEnv("TABLE_NAME", "mc-state");
    ddbMock.reset();
  });

  afterEach(() => {
    ddbMock.restore();
  });

  it("成功時に更新後レコードを返し、条件式に奪取条件を含む", async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { pk: "server", state: "STARTING", updated_at: NOW.toISOString() },
    });

    const result = await transitionState({ from: "STOPPED", to: "STARTING", now: NOW });
    assert(result.ok, "transitionState は成功するはず");
    expect(result.record.state).toBe("STARTING");

    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.TableName).toBe("mc-state");
    expect(input.Key).toEqual({ pk: "server" });
    // STOPPED からの遷移はアイテム未作成でも成立する
    expect(input.ConditionExpression).toContain("attribute_not_exists(pk)");
    // 奪取条件（stale 状態 + 15分前のカットオフ）が含まれる
    expect(input.ConditionExpression).toContain("#updated_at < :staleBefore");
    expect(input.ExpressionAttributeValues?.[":staleBefore"]).toBe(
      new Date(NOW.getTime() - STALE_TAKEOVER_MS).toISOString(),
    );
    expect(input.ExpressionAttributeValues?.[":from0"]).toBe("STOPPED");
  });

  it("STOPPED を含まない遷移では attribute_not_exists を条件にしない", async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { pk: "server", state: "STOPPING", updated_at: NOW.toISOString() },
    });
    await transitionState({ from: "RUNNING", to: "STOPPING", now: NOW });
    const input = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.ConditionExpression).not.toContain("attribute_not_exists");
  });

  it("set / clear が UpdateExpression に反映される", async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { pk: "server", state: "RUNNING", updated_at: NOW.toISOString() },
    });
    await transitionState({
      from: "STARTING",
      to: "RUNNING",
      set: { instance_id: "i-123", spot_price: 0.05 },
      clear: ["snapshot_id"],
      now: NOW,
    });
    const input = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.UpdateExpression).toContain("#set_instance_id = :set_instance_id");
    expect(input.UpdateExpression).toContain("REMOVE #rm_snapshot_id");
    expect(input.ExpressionAttributeValues?.[":set_spot_price"]).toBe(0.05);
  });

  it("条件不成立なら ok:false と現在状態を返す", async () => {
    ddbMock.on(UpdateCommand).rejects(
      Object.assign(new Error("conditional check failed"), {
        name: "ConditionalCheckFailedException",
      }),
    );
    ddbMock.on(GetCommand).resolves({
      Item: { pk: "server", state: "STARTING", updated_at: NOW.toISOString() },
    });

    const result = await transitionState({ from: "STOPPED", to: "STARTING", now: NOW });
    expect(result).toEqual({ ok: false, currentState: "STARTING" });
  });

  it("条件エラー以外の例外はそのまま投げる", async () => {
    ddbMock.on(UpdateCommand).rejects(new Error("network down"));
    await expect(transitionState({ from: "STOPPED", to: "STARTING" })).rejects.toThrow(
      "network down",
    );
  });
});
