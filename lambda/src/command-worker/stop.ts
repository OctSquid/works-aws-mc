import { errorMessage, log } from "../shared/config";
import { editOriginalResponse } from "../shared/discord";
import { tagStopReason, terminateInstance } from "../shared/ec2";
import { STOP_NO_INSTANCE_MESSAGE, STOP_STARTED_MESSAGE, busyMessage } from "../shared/messages";
import { runShellCommand } from "../shared/ssm";
import { transitionState } from "../shared/state";
import type { InteractionContext } from "../shared/types";

export async function handleStop(ctx: InteractionContext): Promise<void> {
  const result = await transitionState({ from: "RUNNING", to: "STOPPING" });
  if (!result.ok) {
    await editOriginalResponse(ctx.applicationId, ctx.token, busyMessage(result.currentState));
    return;
  }

  const instanceId = result.record.instance_id;
  if (!instanceId) {
    await transitionState({ from: "STOPPING", to: "STOPPED" });
    await editOriginalResponse(ctx.applicationId, ctx.token, STOP_NO_INSTANCE_MESSAGE);
    return;
  }

  try {
    // インスタンス側スクリプト: RCON 告知 → save-all → systemctl stop → mc:stop-reason タグ → poweroff
    await runShellCommand(instanceId, ["/opt/minecraft/bin/mc-shutdown.sh manual"]);
  } catch (err) {
    log("warn", "ssm send-command failed, terminating directly", {
      instanceId,
      error: errorMessage(err),
    });
    try {
      await tagStopReason(instanceId, "manual");
    } catch (tagErr) {
      log("warn", "failed to tag stop reason", { instanceId, error: errorMessage(tagErr) });
    }
    await terminateInstance(instanceId);
  }

  await editOriginalResponse(ctx.applicationId, ctx.token, STOP_STARTED_MESSAGE);
}
