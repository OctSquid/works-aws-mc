// Discord ギルドコマンドとして Slash Commands を一括登録（PUT = 洗い替え）する。
// コマンド定義は lambda/src/commands/definitions.ts が単一ソース
// （worker のハンドラ表と同じ型で結ばれており、登録と実装の乖離は型エラーになる）。
// 必要な環境変数: DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, DISCORD_GUILD_ID
import { COMMAND_DEFINITIONS } from "../../../lambda/src/commands/definitions";

const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!applicationId || !botToken || !guildId) {
  console.error(
    "DISCORD_APPLICATION_ID / DISCORD_BOT_TOKEN / DISCORD_GUILD_ID を環境変数で指定してください",
  );
  process.exit(1);
}

const res = await fetch(
  `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`,
  {
    method: "PUT",
    headers: {
      authorization: `Bot ${botToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(COMMAND_DEFINITIONS),
  },
);

if (!res.ok) {
  console.error(`登録失敗: ${res.status} ${res.statusText}`, await res.text());
  process.exit(1);
}

const registered = (await res.json()) as { name: string }[];
console.log(`登録完了: ${registered.map((c) => c.name).join(", ")}`);
