/**
 * Slash Command の実処理（interactions から非同期 Invoke される）。
 * ディスパッチのみ担当し、各コマンドの実装は start / stop / status に分離。
 * COMMAND_DEFINITIONS（登録定義）と COMMANDS（ハンドラ）は Record<CommandName, …>
 * で結ばれており、定義とハンドラの過不足は型エラーになる。
 */
import { isKnownCommand, type CommandName } from "../commands/definitions";
import { errorMessage, log, setLogContext } from "../shared/config";
import { editOriginalResponse } from "../shared/discord";
import { unknownCommandMessage, workerErrorMessage } from "../shared/messages";
import type { InteractionContext, WorkerPayload } from "../shared/types";
import { handleStart } from "./start";
import { handleStatus } from "./status";
import { handleStop } from "./stop";

type CommandHandler = (ctx: InteractionContext) => Promise<void>;

const COMMANDS: Record<CommandName, CommandHandler> = {
  start: handleStart,
  stop: handleStop,
  status: handleStatus,
};

export const handler = async (event: WorkerPayload): Promise<void> => {
  setLogContext({
    ...(event.correlationId ? { correlationId: event.correlationId } : {}),
    ...(event.command ? { command: event.command } : {}),
  });
  log("info", "worker invoked", { invokedBy: event.invokedBy });
  const { applicationId, token } = event;
  if (!applicationId || !token) {
    log("error", "missing interaction context", {});
    return;
  }
  const ctx: InteractionContext = { applicationId, token, invokedBy: event.invokedBy };
  try {
    if (isKnownCommand(event.command)) {
      await COMMANDS[event.command](ctx);
    } else {
      await editOriginalResponse(applicationId, token, unknownCommandMessage(event.command));
    }
  } catch (err) {
    log("error", "worker unhandled error", { error: errorMessage(err) });
    // Event Invoke のため、ここで throw すると Lambda が自動再実行してコマンドが
    // 二重実行される。通知の失敗も含めて必ずここで握り潰す。
    try {
      await editOriginalResponse(applicationId, token, workerErrorMessage(errorMessage(err)));
    } catch (notifyErr) {
      log("error", "failed to notify error to discord", { error: errorMessage(notifyErr) });
    }
  }
};
