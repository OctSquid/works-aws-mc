/**
 * ユーザー向けメッセージの単一ソース。
 * 文言・絵文字・embed の色はすべてここに集約する（ハンドラにはロジックだけを残す）。
 * 以前は状態ラベル・絵文字・停止文言が worker / lifecycle に重複していた。
 */
import type { Purchasing } from "./config";
import type { OutgoingMessage } from "./discord";
import type { StopReason } from "./ec2";
import type { ServerState } from "./state";

/** Discord の標準的なアクセントカラー */
export const COLOR = {
  green: 0x57f287,
  yellow: 0xfee75c,
  red: 0xed4245,
  blurple: 0x5865f2,
  grey: 0x99aab5,
} as const;

/** 短文通知の共通形: title なし・description のみの embed */
function notice(description: string, color: number): OutgoingMessage {
  return { embeds: [{ description, color }] };
}

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------

export const STATE_LABELS: Record<ServerState, string> = {
  STOPPED: "停止済み (STOPPED)",
  STARTING: "起動処理中 (STARTING)",
  RUNNING: "稼働中 (RUNNING)",
  STOPPING: "停止処理中 (STOPPING)",
  SNAPSHOTTING: "バックアップ作成中 (SNAPSHOTTING)",
};

export const STATE_EMOJI: Record<ServerState, string> = {
  STOPPED: "💤",
  STARTING: "🚀",
  RUNNING: "🟢",
  STOPPING: "🛑",
  SNAPSHOTTING: "💾",
};

export function stateLabel(state: ServerState | undefined): string {
  return state ? STATE_LABELS[state] : "不明";
}

export function busyMessage(currentState: ServerState | undefined): OutgoingMessage {
  return notice(`⏳ 既に操作が進行中です（現在: ${stateLabel(currentState)}）`, COLOR.yellow);
}

// ---------------------------------------------------------------------------
// /start
// ---------------------------------------------------------------------------

export const PURCHASING_LABELS: Record<Purchasing, string> = {
  spot: "スポット",
  ondemand: "オンデマンド",
  "spot-then-ondemand": "スポット（確保できない場合はオンデマンド）",
};

export const EXHAUSTED_MESSAGES: Record<Purchasing, OutgoingMessage> = {
  spot: notice(
    '❌ スポットインスタンスを確保できませんでした。しばらく待って再試行するか、server.json の `ec2.purchasing` を `"spot-then-ondemand"` に変更してデプロイしてください。',
    COLOR.red,
  ),
  ondemand: notice(
    "❌ オンデマンドインスタンスを確保できませんでした。しばらく待って再試行してください。",
    COLOR.red,
  ),
  "spot-then-ondemand": notice(
    "❌ スポット・オンデマンドのいずれでもインスタンスを確保できませんでした。しばらく待って再試行してください。",
    COLOR.red,
  ),
};

export function startProgressMessage(
  purchasing: Purchasing,
  notes: readonly string[],
): OutgoingMessage {
  return notice(
    [`⏳ サーバーを起動しています…（${PURCHASING_LABELS[purchasing]}）`, ...notes].join("\n"),
    COLOR.blurple,
  );
}

export function orphanVolumeNote(volumeId: string, az: string): string {
  return `⚠️ 前回のデータボリューム (\`${volumeId}\`) が残っていたため、スナップショットではなくこのボリュームを再利用します（AZ ${az} に限定して起動）。`;
}

export const NEW_WORLD_NOTE =
  "ℹ️ 既存のワールドデータが見つからないため、新規ワールドとして起動します。";

export const ONDEMAND_FALLBACK_NOTE =
  "⚠️ スポットを確保できなかったため、オンデマンドにフォールバックします…";

/** ONDEMAND_FALLBACK_NOTE を単独 followup として送るときの embed 版 */
export function ondemandFallbackNotice(): OutgoingMessage {
  return notice(ONDEMAND_FALLBACK_NOTE, COLOR.yellow);
}

export function doubleLaunchAbortMessage(instanceId: string): OutgoingMessage {
  return notice(
    `⚠️ 既に稼働中/起動中のインスタンス (\`${instanceId}\`) が見つかったため、二重起動を防ぐため起動を中止しました。\`/status\` で状態を確認してください。`,
    COLOR.yellow,
  );
}

export function priceLabel(
  usedMarket: "spot" | "ondemand",
  purchasing: Purchasing,
  price: number | undefined,
): string {
  if (usedMarket === "ondemand") {
    return purchasing === "spot-then-ondemand"
      ? "オンデマンド（スポットからフォールバック）"
      : "オンデマンド";
  }
  return `$${price?.toFixed(4) ?? "?"}/時（スポット）`;
}

export function startedEmbed(params: {
  fqdn: string;
  ip: string;
  az: string;
  instanceType: string;
  priceLabel: string;
}): OutgoingMessage {
  return {
    embeds: [
      {
        title: "🚀 サーバー起動中",
        description: "ワールドの読込が完了したら改めて通知されます。",
        color: COLOR.green,
        fields: [
          { name: "接続先", value: `\`${params.fqdn}\` (${params.ip})`, inline: false },
          { name: "AZ / タイプ", value: `${params.az} / ${params.instanceType}`, inline: true },
          { name: "単価", value: params.priceLabel, inline: true },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

export function degradedStartMessage(reason: string, ip: string): OutgoingMessage {
  return {
    embeds: [
      {
        title: "⚠️ 起動は完了、後処理に失敗",
        description: [
          `サーバーは起動しましたが、後処理に失敗しました: ${reason}`,
          `IP 直打ちで接続できます: \`${ip}\``,
          "DNS や状態表示が復旧しない場合は `/status` で確認してください（アイドル自動停止は機能します）。",
        ].join("\n"),
        color: COLOR.yellow,
      },
    ],
  };
}

export function startFailedMessage(reason: string): OutgoingMessage {
  return {
    embeds: [
      {
        title: "❌ 起動に失敗しました",
        description: reason,
        color: COLOR.red,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// /stop
// ---------------------------------------------------------------------------

export const STOP_STARTED_MESSAGE: OutgoingMessage = notice(
  "🛑 停止処理を開始しました。バックアップ完了後に通知します。",
  COLOR.blurple,
);

export const STOP_NO_INSTANCE_MESSAGE: OutgoingMessage = notice(
  "⚠️ 稼働中のインスタンスが記録されていませんでした。状態を停止済みに戻しました。",
  COLOR.yellow,
);

// ---------------------------------------------------------------------------
// /status
// ---------------------------------------------------------------------------

export const STATUS_STOPPED_MESSAGE: OutgoingMessage = notice(
  "💤 サーバーは停止中です。`/start` で起動できます。",
  COLOR.grey,
);

export function statusEmbed(params: {
  state: ServerState;
  fqdn?: string | undefined;
  ip?: string | undefined;
  instanceId?: string | undefined;
  az?: string | undefined;
  instanceType?: string | undefined;
  uptime?: string | undefined;
  purchasingLine?: string | undefined;
  updatedAt: string;
  warning?: string | undefined;
}): OutgoingMessage {
  const fields: { name: string; value: string; inline?: boolean }[] = [];
  if (params.fqdn && params.ip) {
    fields.push({ name: "接続先", value: `\`${params.fqdn}\` (${params.ip})` });
  }
  if (params.instanceId) {
    fields.push({
      name: "インスタンス",
      value: `${params.instanceId} / AZ: ${params.az ?? "?"} / タイプ: ${params.instanceType ?? "?"}`,
    });
  }
  if (params.uptime) fields.push({ name: "稼働時間", value: params.uptime, inline: true });
  if (params.purchasingLine) {
    fields.push({ name: "購入方式", value: params.purchasingLine, inline: true });
  }
  return {
    embeds: [
      {
        title: `${STATE_EMOJI[params.state]} 状態: ${stateLabel(params.state)}`,
        ...(params.warning ? { description: params.warning } : {}),
        color:
          params.state === "RUNNING"
            ? COLOR.green
            : params.state === "SNAPSHOTTING"
              ? COLOR.blurple
              : COLOR.yellow,
        fields,
        footer: { text: `最終更新: ${params.updatedAt}` },
      },
    ],
  };
}

export function statusTerminatedWarning(instanceId: string): string {
  return `⚠️ 記録上のインスタンス (${instanceId}) は既に終了しています。まもなくバックアップ処理が始まります。`;
}

// ---------------------------------------------------------------------------
// /admin
// ---------------------------------------------------------------------------

export function serverNotRunningMessage(state: ServerState | undefined): OutgoingMessage {
  return notice(
    `⚠️ サーバーが稼働していないため実行できません（現在: ${stateLabel(state)}）。\`/start\` で起動してください。`,
    COLOR.yellow,
  );
}

export function adminResultEmbed(params: {
  title: string;
  output: string;
  ok: boolean;
}): OutgoingMessage {
  const output = params.output.trim() || "（出力なし）";
  return {
    embeds: [
      {
        title: `${params.ok ? "✅" : "❌"} ${params.title}`,
        description: `\`\`\`\n${output}\n\`\`\``,
        color: params.ok ? COLOR.green : COLOR.red,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

export function adminBlockedCommandMessage(command: string): OutgoingMessage {
  return notice(
    `⛔ \`${command}\` はここでは実行できません。サーバー停止は \`/stop\` を使ってください（バックアップと状態管理が正しく行われます）。`,
    COLOR.red,
  );
}

export function invalidPlayerNameMessage(name: string): OutgoingMessage {
  return notice(
    `❌ プレイヤー名が不正です: \`${name}\`（英数字とアンダースコア、1〜16文字）`,
    COLOR.red,
  );
}

// ---------------------------------------------------------------------------
// /health
// ---------------------------------------------------------------------------

export function healthEmbed(params: {
  state: ServerState;
  players?: string | undefined;
  tps?: string | undefined;
  load?: string | undefined;
  memory?: string | undefined;
  disk?: string | undefined;
  warning?: string | undefined;
}): OutgoingMessage {
  const fields: { name: string; value: string; inline?: boolean }[] = [];
  if (params.players) fields.push({ name: "👥 プレイヤー", value: params.players });
  if (params.tps) fields.push({ name: "⚡ TPS", value: params.tps });
  if (params.load) fields.push({ name: "🧮 CPU 負荷", value: params.load, inline: true });
  if (params.memory) fields.push({ name: "🧠 メモリ", value: params.memory, inline: true });
  if (params.disk) fields.push({ name: "💽 ディスク", value: params.disk, inline: true });
  return {
    embeds: [
      {
        title: `${STATE_EMOJI[params.state]} ヘルス: ${stateLabel(params.state)}`,
        ...(params.warning ? { description: params.warning } : {}),
        color: params.state === "RUNNING" ? COLOR.green : COLOR.yellow,
        fields,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

export function healthUnavailableMessage(reason: string): string {
  return `⚠️ ヘルス情報の取得に失敗しました: ${reason}`;
}

// ---------------------------------------------------------------------------
// /logs
// ---------------------------------------------------------------------------

/** embed description 上限 4096 からコードフェンス分を引いた実効上限 */
export const LOGS_MAX_CONTENT_LENGTH = 3980;

export function logsMessage(lines: number, content: string): OutgoingMessage {
  const body = content.trimEnd() || "（ログは空です）";
  return {
    embeds: [
      {
        title: `📜 latest.log（末尾 ${lines} 行）`,
        description: `\`\`\`\n${body}\n\`\`\``,
        color: COLOR.grey,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 共通エラー
// ---------------------------------------------------------------------------

export function workerErrorMessage(reason: string): OutgoingMessage {
  return notice(`❌ 処理中にエラーが発生しました: ${reason}`, COLOR.red);
}

export function unknownCommandMessage(command: string | undefined): OutgoingMessage {
  return notice(`❓ 不明なコマンドです: ${command ?? "(なし)"}`, COLOR.red);
}

/** interactions 側で worker の Invoke 自体に失敗したときの即時応答 */
export function workerDispatchFailedMessage(reason: string): OutgoingMessage {
  return notice(`❌ コマンドの受付に失敗しました: ${reason}`, COLOR.red);
}

// ---------------------------------------------------------------------------
// ライフサイクル通知（webhook）
// ---------------------------------------------------------------------------

export const STOP_MESSAGES: Record<StopReason, string> = {
  manual: "🛑 サーバーを手動停止しました。",
  "auto-idle": "🛑 15分間プレイヤー不在のため自動停止しました。",
  spot: "⚠️ スポット中断により停止しました。",
  "max-runtime": "⏱️ 最大稼働時間を超えたため強制停止しました。",
};

export function stopMessage(reason: string | undefined): string {
  if (reason && reason in STOP_MESSAGES) return STOP_MESSAGES[reason as StopReason];
  return "🛑 サーバーが停止しました（理由: spot または不明）。";
}

export function snapshotStartedNotice(stopReason: string | undefined): OutgoingMessage {
  return notice(
    `${stopMessage(stopReason)}\n💾 バックアップ（スナップショット）を作成しています…`,
    COLOR.blurple,
  );
}

export function backupSkippedNotice(stopReason: string | undefined): OutgoingMessage {
  return notice(
    `${stopMessage(stopReason)}\n⚠️ データボリュームが見つからなかったため、バックアップは作成されませんでした。`,
    COLOR.red,
  );
}

export function volumeNotAvailableNotice(
  stopReason: string | undefined,
  volumeId: string,
): OutgoingMessage {
  return notice(
    `${stopMessage(stopReason)}\n❌ データボリューム (\`${volumeId}\`) が available になりませんでした。次回 \`/start\` 時にこのボリュームを再利用して復旧を試みます。`,
    COLOR.red,
  );
}

export function volumeDeleteFailedNotice(volumeId: string, reason: string): OutgoingMessage {
  return notice(
    `⚠️ バックアップ後のボリューム削除に失敗しました (\`${volumeId}\`): ${reason}`,
    COLOR.yellow,
  );
}

export function backupCompleteNotice(): OutgoingMessage {
  return notice("✅ バックアップ完了。`/start` で再開できます。", COLOR.green);
}

// ---------------------------------------------------------------------------
// watchdog tick / スポット中断
// ---------------------------------------------------------------------------

export function maxRuntimeStopNotice(maxRuntimeHours: number): OutgoingMessage {
  return notice(
    `⏱️ 稼働時間が上限（${maxRuntimeHours}時間）を超えたため、サーバーを強制停止します。`,
    COLOR.yellow,
  );
}

export const INSTANCE_GONE_NOTICE: OutgoingMessage = notice(
  "⚠️ 記録上は稼働中でしたが、インスタンスが見つかりませんでした。状態を停止済みに戻しました。`/start` で再起動できます。",
  COLOR.yellow,
);

export function stalledStateNotice(state: ServerState, stalledMinutes: number): OutgoingMessage {
  return notice(
    `⚠️ 状態 \`${state}\` が ${stalledMinutes} 分以上停滞しています。\`/status\` で確認してください（15 分経過後は \`/start\`・\`/stop\` で回復できます）。`,
    COLOR.yellow,
  );
}

export function spotInterruptionNotice(): OutgoingMessage {
  return notice("⚠️ スポット中断予告: 約2分後にサーバーが停止します。", COLOR.yellow);
}
