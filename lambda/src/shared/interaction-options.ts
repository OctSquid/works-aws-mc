/**
 * Discord interaction の options パース（純関数）。
 * サブコマンド構造は type 2 (SUB_COMMAND_GROUP) > type 1 (SUB_COMMAND) > 実引数
 * のネストで届くため、階層を降りて leaf 引数をフラットな map に展開する。
 */

/** Discord ApplicationCommandInteractionDataOption（必要なフィールドのみ） */
export interface InteractionDataOption {
  /** ApplicationCommandOptionType（1=SUB_COMMAND, 2=SUB_COMMAND_GROUP, 3=STRING, …） */
  type?: number;
  name: string;
  value?: unknown;
  options?: InteractionDataOption[];
}

export type OptionValue = string | number | boolean;

export interface ParsedOptions {
  subcommandGroup?: string | undefined;
  subcommand?: string | undefined;
  args: Record<string, OptionValue>;
}

const SUB_COMMAND = 1;
const SUB_COMMAND_GROUP = 2;

// type が欠落していても、ネスト構造（value なし + options あり）からコンテナと判定する
function isContainer(option: InteractionDataOption): boolean {
  if (option.type !== undefined) {
    return option.type === SUB_COMMAND || option.type === SUB_COMMAND_GROUP;
  }
  return option.value === undefined && option.options !== undefined;
}

export function parseInteractionOptions(options?: InteractionDataOption[]): ParsedOptions {
  // コンテナを最大2段（GROUP > SUB_COMMAND）降りながら名前を集める。
  // 1段だけならサブコマンド、2段ならグループ + サブコマンド。
  const containerNames: string[] = [];
  let current = options ?? [];
  while (
    containerNames.length < 2 &&
    current.length === 1 &&
    current[0] &&
    isContainer(current[0])
  ) {
    containerNames.push(current[0].name);
    current = current[0].options ?? [];
  }

  const args: Record<string, OptionValue> = {};
  for (const option of current) {
    const value = option.value;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      args[option.name] = value;
    }
  }
  return {
    subcommandGroup: containerNames.length === 2 ? containerNames[0] : undefined,
    subcommand: containerNames.length === 2 ? containerNames[1] : containerNames[0],
    args,
  };
}
