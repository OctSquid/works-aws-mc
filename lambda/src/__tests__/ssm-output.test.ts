import { GetCommandInvocationCommand, SSMClient, SendCommandCommand } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runShellCommandWithOutput } from "../shared/ssm";

const ssmMock = mockClient(SSMClient);

describe("runShellCommandWithOutput", () => {
  beforeEach(() => {
    ssmMock.reset();
    ssmMock.on(SendCommandCommand).resolves({ Command: { CommandId: "cmd-1" } });
  });

  afterEach(() => {
    ssmMock.restore();
  });

  it("Success まで待って stdout/stderr を返す", async () => {
    ssmMock.on(GetCommandInvocationCommand).resolvesOnce({ Status: "InProgress" }).resolves({
      Status: "Success",
      StandardOutputContent: "hello\n",
      StandardErrorContent: "",
      ResponseCode: 0,
    });

    const result = await runShellCommandWithOutput("i-run", ["echo hello"], {
      timeoutMs: 1_000,
      intervalMs: 1,
    });

    expect(result).toEqual({ status: "Success", stdout: "hello\n", stderr: "", exitCode: 0 });
    const send = ssmMock.commandCalls(SendCommandCommand)[0]!.args[0].input;
    expect(send.InstanceIds).toEqual(["i-run"]);
    expect(send.Parameters?.["commands"]).toEqual(["echo hello"]);
  });

  it("InvocationDoesNotExist はまだ Pending として続行する", async () => {
    ssmMock
      .on(GetCommandInvocationCommand)
      .rejectsOnce(Object.assign(new Error("does not exist"), { name: "InvocationDoesNotExist" }))
      .resolves({ Status: "Success", StandardOutputContent: "ok", ResponseCode: 0 });

    const result = await runShellCommandWithOutput("i-run", ["true"], {
      timeoutMs: 1_000,
      intervalMs: 1,
    });

    expect(result.status).toBe("Success");
    expect(result.stdout).toBe("ok");
  });

  it("Failed は stderr と exitCode を返す", async () => {
    ssmMock.on(GetCommandInvocationCommand).resolves({
      Status: "Failed",
      StandardOutputContent: "",
      StandardErrorContent: "boom",
      ResponseCode: 1,
    });

    const result = await runShellCommandWithOutput("i-run", ["false"], {
      timeoutMs: 1_000,
      intervalMs: 1,
    });

    expect(result).toEqual({ status: "Failed", stdout: "", stderr: "boom", exitCode: 1 });
  });

  it("完了しないまま期限が来たら throw する", async () => {
    ssmMock.on(GetCommandInvocationCommand).resolves({ Status: "InProgress" });

    await expect(
      runShellCommandWithOutput("i-run", ["sleep 999"], { timeoutMs: 20, intervalMs: 1 }),
    ).rejects.toThrow("タイムアウト");
  });

  it("InvocationDoesNotExist 以外のエラーはそのまま throw する", async () => {
    ssmMock
      .on(GetCommandInvocationCommand)
      .rejects(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));

    await expect(
      runShellCommandWithOutput("i-run", ["true"], { timeoutMs: 1_000, intervalMs: 1 }),
    ).rejects.toThrow("denied");
  });
});
