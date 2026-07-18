/**
 * Slash Command 定義の単一ソース（純データ。AWS SDK 等への依存を持たないこと）。
 * - tools/register-commands がこれを Discord へ登録する
 * - command-worker がこれをキーにハンドラを引く（Record<CommandName, …> により
 *   定義とハンドラの過不足はコンパイルエラーで検出される）
 * コマンドの追加 = ここに 1 エントリ + command-worker にハンドラ 1 つ。
 */

export interface CommandOptionDefinition {
  /** Discord の ApplicationCommandOptionType（1 = SUB_COMMAND, 2 = SUB_COMMAND_GROUP, 3 = STRING, 4 = INTEGER, 5 = BOOLEAN など） */
  type: number;
  name: string;
  description: string;
  required?: boolean;
  /** SUB_COMMAND / SUB_COMMAND_GROUP のネスト */
  options?: readonly CommandOptionDefinition[];
  min_value?: number;
  max_value?: number;
}

export interface CommandDefinition {
  name: string;
  description: string;
  options?: readonly CommandOptionDefinition[];
  /**
   * 表示・実行を許可する権限の bitfield（文字列）。"8" = Administrator。
   * ギルドの サーバー設定 > 連携サービス でロール別に上書きできる。
   */
  default_member_permissions?: string;
}

/** ApplicationCommandOptionType の別名（定義の可読性のため） */
const SUB_COMMAND = 1;
const SUB_COMMAND_GROUP = 2;
const STRING = 3;
const INTEGER = 4;

const playerOption = {
  type: STRING,
  name: "player",
  description: "対象プレイヤー名",
  required: true,
} as const;

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
  {
    name: "admin",
    description: "サーバー管理コマンド（OP・BAN・ホワイトリスト・コンソール）",
    default_member_permissions: "8",
    options: [
      {
        type: SUB_COMMAND,
        name: "op",
        description: "プレイヤーに OP 権限を付与する",
        options: [playerOption],
      },
      {
        type: SUB_COMMAND,
        name: "deop",
        description: "プレイヤーの OP 権限を剥奪する",
        options: [playerOption],
      },
      {
        type: SUB_COMMAND,
        name: "ban",
        description: "プレイヤーを BAN する",
        options: [
          playerOption,
          { type: STRING, name: "reason", description: "BAN 理由", required: false },
        ],
      },
      {
        type: SUB_COMMAND,
        name: "pardon",
        description: "プレイヤーの BAN を解除する",
        options: [playerOption],
      },
      {
        type: SUB_COMMAND,
        name: "banlist",
        description: "BAN 一覧を表示する",
      },
      {
        type: SUB_COMMAND_GROUP,
        name: "whitelist",
        description: "ホワイトリストを管理する",
        options: [
          { type: SUB_COMMAND, name: "on", description: "ホワイトリストを有効にする" },
          { type: SUB_COMMAND, name: "off", description: "ホワイトリストを無効にする" },
          {
            type: SUB_COMMAND,
            name: "add",
            description: "プレイヤーをホワイトリストに追加する",
            options: [playerOption],
          },
          {
            type: SUB_COMMAND,
            name: "remove",
            description: "プレイヤーをホワイトリストから削除する",
            options: [playerOption],
          },
          { type: SUB_COMMAND, name: "list", description: "ホワイトリストを表示する" },
        ],
      },
      {
        type: SUB_COMMAND,
        name: "cmd",
        description: "任意のコンソールコマンドを実行する（stop 等は不可）",
        options: [
          {
            type: STRING,
            name: "command",
            description: "実行するコンソールコマンド（先頭の / は不要）",
            required: true,
          },
        ],
      },
    ],
  },
  {
    name: "health",
    description: "サーバーのヘルス（プレイヤー数・TPS・CPU・メモリ・ディスク）を確認する",
  },
  {
    name: "logs",
    description: "サーバーログ（latest.log）の末尾を表示する",
    options: [
      {
        type: INTEGER,
        name: "lines",
        description: "表示する行数（1〜200、既定 50）",
        required: false,
        min_value: 1,
        max_value: 200,
      },
    ],
  },
] as const satisfies readonly CommandDefinition[];

export type CommandName = (typeof COMMAND_DEFINITIONS)[number]["name"];

export function isKnownCommand(name: string | undefined): name is CommandName {
  return COMMAND_DEFINITIONS.some((definition) => definition.name === name);
}
