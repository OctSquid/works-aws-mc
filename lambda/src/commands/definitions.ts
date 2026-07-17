/**
 * Slash Command 定義の単一ソース（純データ。AWS SDK 等への依存を持たないこと）。
 * - tools/register-commands がこれを Discord へ登録する
 * - command-worker がこれをキーにハンドラを引く（Record<CommandName, …> により
 *   定義とハンドラの過不足はコンパイルエラーで検出される）
 * コマンドの追加 = ここに 1 エントリ + command-worker にハンドラ 1 つ。
 */

export interface CommandOptionDefinition {
  /** Discord の ApplicationCommandOptionType（5 = BOOLEAN など） */
  type: number;
  name: string;
  description: string;
  required?: boolean;
}

export interface CommandDefinition {
  name: string;
  description: string;
  options?: readonly CommandOptionDefinition[];
}

export const COMMAND_DEFINITIONS = [
  {
    name: "start",
    description: "Minecraft サーバーを起動する",
  },
  {
    name: "stop",
    description: "Minecraft サーバーを停止する（ワールドは自動バックアップされます）",
  },
  {
    name: "status",
    description: "Minecraft サーバーの稼働状況を確認する",
  },
] as const satisfies readonly CommandDefinition[];

export type CommandName = (typeof COMMAND_DEFINITIONS)[number]["name"];

export function isKnownCommand(name: string | undefined): name is CommandName {
  return COMMAND_DEFINITIONS.some((definition) => definition.name === name);
}
