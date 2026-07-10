import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { config, log } from "./config";

export type ServerState = "STOPPED" | "STARTING" | "RUNNING" | "STOPPING" | "SNAPSHOTTING";

/** 15分以上更新が無ければ奪取可能な（スタックし得る）状態 */
export const STEALABLE_STATES: readonly ServerState[] = ["STARTING", "STOPPING", "SNAPSHOTTING"];
export const STALE_TAKEOVER_MS = 15 * 60 * 1000;

export const PK_VALUE = "server";

export interface ServerRecord {
  pk: string;
  state: ServerState;
  updated_at: string;
  instance_id?: string;
  az?: string;
  instance_type?: string;
  spot_price?: number;
  volume_id?: string;
  snapshot_id?: string;
}

export type TransitionResult =
  | { ok: true; record: ServerRecord }
  | { ok: false; currentState: ServerState | undefined };

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export async function getServerRecord(): Promise<ServerRecord | undefined> {
  const res = await ddb.send(
    new GetCommand({ TableName: config.tableName, Key: { pk: PK_VALUE }, ConsistentRead: true }),
  );
  return res.Item as ServerRecord | undefined;
}

/**
 * 遷移可否の純粋関数（DynamoDB の ConditionExpression と同じ意味論）。
 * - 現在状態が from に含まれる → 可
 * - アイテム未作成は STOPPED と同義
 * - STARTING/STOPPING/SNAPSHOTTING が15分以上前 → 奪取可能
 */
export function canTransition(
  current: Pick<ServerRecord, "state" | "updated_at"> | undefined,
  from: readonly ServerState[],
  now: Date = new Date(),
): boolean {
  if (!current) return from.includes("STOPPED");
  if (from.includes(current.state)) return true;
  if (STEALABLE_STATES.includes(current.state)) {
    const updatedAt = Date.parse(current.updated_at);
    if (!Number.isFinite(updatedAt)) return true; // 壊れたタイムスタンプは奪取可
    return now.getTime() - updatedAt >= STALE_TAKEOVER_MS;
  }
  return false;
}

export interface TransitionInput {
  from: ServerState | readonly ServerState[];
  to: ServerState;
  /** 遷移と同時に SET する属性 */
  set?: Record<string, string | number>;
  /** 遷移と同時に REMOVE する属性 */
  clear?: readonly string[];
  now?: Date;
}

/**
 * DynamoDB 単一アイテムの条件付き更新で状態遷移する。
 * 条件: state が from のいずれか（STOPPED を含む場合はアイテム未作成も可）、
 * または stealable 状態かつ updated_at が15分以上前（スタック回復）。
 */
export async function transitionState(input: TransitionInput): Promise<TransitionResult> {
  const fromStates = Array.isArray(input.from) ? (input.from as ServerState[]) : [input.from as ServerState];
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - STALE_TAKEOVER_MS).toISOString();

  const names: Record<string, string> = { "#state": "state", "#updated_at": "updated_at" };
  const values: Record<string, unknown> = { ":to": input.to, ":now": nowIso, ":staleBefore": staleBefore };

  const setParts = ["#state = :to", "#updated_at = :now"];
  for (const [key, value] of Object.entries(input.set ?? {})) {
    names[`#set_${key}`] = key;
    values[`:set_${key}`] = value;
    setParts.push(`#set_${key} = :set_${key}`);
  }
  const removeParts = (input.clear ?? []).map((key) => {
    names[`#rm_${key}`] = key;
    return `#rm_${key}`;
  });
  let updateExpression = `SET ${setParts.join(", ")}`;
  if (removeParts.length > 0) updateExpression += ` REMOVE ${removeParts.join(", ")}`;

  const conditions: string[] = [];
  if (fromStates.includes("STOPPED")) conditions.push("attribute_not_exists(pk)");
  const fromRefs = fromStates.map((s, i) => {
    values[`:from${i}`] = s;
    return `:from${i}`;
  });
  conditions.push(`#state IN (${fromRefs.join(", ")})`);
  const staleRefs = STEALABLE_STATES.map((s, i) => {
    values[`:stale${i}`] = s;
    return `:stale${i}`;
  });
  conditions.push(`(#state IN (${staleRefs.join(", ")}) AND #updated_at < :staleBefore)`);

  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: config.tableName,
        Key: { pk: PK_VALUE },
        UpdateExpression: updateExpression,
        ConditionExpression: conditions.join(" OR "),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      }),
    );
    const record = res.Attributes as ServerRecord;
    log("info", "state transition succeeded", { from: fromStates, to: input.to });
    return { ok: true, record };
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
      const current = await getServerRecord().catch(() => undefined);
      log("warn", "state transition rejected", { from: fromStates, to: input.to, currentState: current?.state });
      return { ok: false, currentState: current?.state };
    }
    throw err;
  }
}
