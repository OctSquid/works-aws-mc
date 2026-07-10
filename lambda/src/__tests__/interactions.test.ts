import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { mockClient } from "aws-sdk-client-mock";
import nacl from "tweetnacl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handler, resetPublicKeyCache, type FunctionUrlEvent } from "../interactions/handler";
import { clearSsmParameterCache } from "../shared/ssm";

const keyPair = nacl.sign.keyPair();
const publicKeyHex = Buffer.from(keyPair.publicKey).toString("hex");

const ssmMock = mockClient(SSMClient);
const lambdaMock = mockClient(LambdaClient);

function signedEvent(body: unknown, tamper = false): FunctionUrlEvent {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = nacl.sign.detached(
    new TextEncoder().encode(timestamp + rawBody),
    keyPair.secretKey,
  );
  if (tamper) signature[0] = signature[0]! ^ 0xff;
  return {
    headers: {
      "x-signature-ed25519": Buffer.from(signature).toString("hex"),
      "x-signature-timestamp": timestamp,
    },
    body: rawBody,
    isBase64Encoded: false,
  };
}

describe("interactions handler", () => {
  beforeEach(() => {
    vi.stubEnv("WORKER_FUNCTION_NAME", "mc-command-worker");
    ssmMock.reset();
    lambdaMock.reset();
    clearSsmParameterCache();
    resetPublicKeyCache();
    ssmMock
      .on(GetParameterCommand, { Name: "/mc/discord/public-key" })
      .resolves({ Parameter: { Value: publicKeyHex } });
    lambdaMock.on(InvokeCommand).resolves({ StatusCode: 202 });
  });

  afterEach(() => {
    ssmMock.restore();
    lambdaMock.restore();
  });

  it("正しい署名の PING に {type:1} を返す", async () => {
    const res = await handler(signedEvent({ type: 1 }));
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(res.body)).toEqual({ type: 1 });
  });

  it("不正な署名に 401 を返す", async () => {
    const res = await handler(signedEvent({ type: 1 }, true));
    expect(res.statusCode).toBe(401);
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  it("署名ヘッダが無ければ 401 を返す", async () => {
    const res = await handler({ headers: {}, body: JSON.stringify({ type: 1 }) });
    expect(res.statusCode).toBe(401);
  });

  it("ボディを改竄した場合は 401 を返す", async () => {
    const event = signedEvent({ type: 1 });
    event.body = JSON.stringify({ type: 2 });
    const res = await handler(event);
    expect(res.statusCode).toBe(401);
  });

  it("base64 エンコードされたボディも検証できる", async () => {
    const event = signedEvent({ type: 1 });
    event.body = Buffer.from(event.body!, "utf8").toString("base64");
    event.isBase64Encoded = true;
    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ type: 1 });
  });

  it("APPLICATION_COMMAND で worker を非同期 Invoke し {type:5} を返す", async () => {
    const interaction = {
      type: 2,
      application_id: "app-123",
      token: "tok-abc",
      channel_id: "ch-1",
      member: { user: { username: "steve" } },
      data: { name: "start", options: [{ name: "ondemand", value: true, type: 5 }] },
    };
    const res = await handler(signedEvent(interaction));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ type: 5 });

    const calls = lambdaMock.commandCalls(InvokeCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.FunctionName).toBe("mc-command-worker");
    expect(input.InvocationType).toBe("Event");
    const payload = JSON.parse(Buffer.from(input.Payload as Uint8Array).toString("utf8"));
    expect(payload).toMatchObject({
      command: "start",
      options: { ondemand: true },
      applicationId: "app-123",
      token: "tok-abc",
      invokedBy: "steve",
    });
  });

  it("SSM の公開鍵はキャッシュされる（2回目の呼び出しで GetParameter しない）", async () => {
    await handler(signedEvent({ type: 1 }));
    await handler(signedEvent({ type: 1 }));
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(1);
  });
});
