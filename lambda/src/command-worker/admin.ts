/**
 * /admin — サーバー管理サブコマンド（op/deop/ban/pardon/banlist/whitelist/cmd）。
 * Discord 側の default_member_permissions で管理者に限定される前提だが、
 * player 引数の検証と stop 等のブロックは Lambda 側でも行う（defense in depth）。
 */
import { editOriginalResponse } from "../shared/discord";
import {
  adminBlockedCommandMessage,
  adminResultEmbed,
  invalidPlayerNameMessage,
  unknownCommandMessage,
} from "../shared/messages";
import type { InteractionContext } from "../shared/types";
import {
  isValidPlayerName,
  normalizeConsoleCommand,
  requireRunningInstance,
  runRcon,
} from "./rcon";

/** サブコマンドから Minecraft コンソールコマンドを組み立てる。不正入力はエラー文字列で返す */
export function buildAdminCommand(
  ctx: Pick<InteractionContext, "subcommandGroup" | "subcommand" | "args">,
): { command: string; title: string } | { error: string } {
  const player = typeof ctx.args["player"] === "string" ? ctx.args["player"] : undefined;
  const requirePlayer = (): string | undefined => {
    if (player === undefined || !isValidPlayerName(player)) return player ?? "(未指定)";
    return undefined;
  };

  if (ctx.subcommandGroup === "whitelist") {
    switch (ctx.subcommand) {
      case "on":
      case "off":
      case "list":
        return { command: `whitelist ${ctx.subcommand}`, title: `whitelist ${ctx.subcommand}` };
      case "add":
      case "remove": {
        const bad = requirePlayer();
        if (bad !== undefined) return { error: invalidPlayerNameMessage(bad) };
        return {
          command: `whitelist ${ctx.subcommand} ${player}`,
          title: `whitelist ${ctx.subcommand} ${player}`,
        };
      }
      default:
        return { error: unknownCommandMessage(`admin whitelist ${ctx.subcommand ?? "(なし)"}`) };
    }
  }

  switch (ctx.subcommand) {
    case "op":
    case "deop":
    case "pardon": {
      const bad = requirePlayer();
      if (bad !== undefined) return { error: invalidPlayerNameMessage(bad) };
      return { command: `${ctx.subcommand} ${player}`, title: `${ctx.subcommand} ${player}` };
    }
    case "ban": {
      const bad = requirePlayer();
      if (bad !== undefined) return { error: invalidPlayerNameMessage(bad) };
      const reason = typeof ctx.args["reason"] === "string" ? ctx.args["reason"] : undefined;
      return {
        command: reason ? `ban ${player} ${reason}` : `ban ${player}`,
        title: `ban ${player}`,
      };
    }
    case "banlist":
      return { command: "banlist", title: "banlist" };
    case "cmd": {
      const input = typeof ctx.args["command"] === "string" ? ctx.args["command"] : "";
      const command = normalizeConsoleCommand(input);
      if (command === undefined) return { error: adminBlockedCommandMessage(input) };
      if (command === "") return { error: unknownCommandMessage("(空のコマンド)") };
      return { command, title: command };
    }
    default:
      return { error: unknownCommandMessage(`admin ${ctx.subcommand ?? "(なし)"}`) };
  }
}

export async function handleAdmin(ctx: InteractionContext): Promise<void> {
  const built = buildAdminCommand(ctx);
  if ("error" in built) {
    await editOriginalResponse(ctx.applicationId, ctx.token, built.error);
    return;
  }

  const instanceId = await requireRunningInstance(ctx);
  if (!instanceId) return;

  const result = await runRcon(instanceId, built.command);
  const ok = result.status === "Success";
  await editOriginalResponse(
    ctx.applicationId,
    ctx.token,
    adminResultEmbed({
      title: built.title,
      output: ok ? result.stdout : result.stderr || result.stdout || `status: ${result.status}`,
      ok,
    }),
  );
}
