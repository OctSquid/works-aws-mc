import { config, errorMessage, log, type Purchasing } from "../shared/config";
import { editOriginalResponse, sendFollowup } from "../shared/discord";
import {
  attachDataVolume,
  buildOndemandCandidates,
  describeInstance,
  fetchSpotCandidates,
  findLatestDataSnapshot,
  findOrphanDataVolume,
  getCurrentSpotPrice,
  getSubnetsByAz,
  isRetryableCapacityError,
  launchInstance,
  tagDataVolume,
  tagStopReason,
  terminateInstance,
  waitForInstance,
  type LaunchCandidate,
  type LaunchOptions,
} from "../shared/ec2";
import { upsertARecord } from "../shared/route53";
import { runShellCommand } from "../shared/ssm";
import { getServerRecord, transitionState, type ServerState } from "../shared/state";

export interface WorkerPayload {
  command?: string;
  options?: Record<string, unknown>;
  applicationId?: string;
  token?: string;
  channelId?: string | undefined;
  invokedBy?: string | undefined;
}

interface InteractionContext {
  applicationId: string;
  token: string;
  invokedBy?: string | undefined;
}

const STATE_LABELS: Record<ServerState, string> = {
  STOPPED: "停止済み (STOPPED)",
  STARTING: "起動処理中 (STARTING)",
  RUNNING: "稼働中 (RUNNING)",
  STOPPING: "停止処理中 (STOPPING)",
  SNAPSHOTTING: "バックアップ作成中 (SNAPSHOTTING)",
};

function stateLabel(state: ServerState | undefined): string {
  return state ? STATE_LABELS[state] : "不明";
}

export const handler = async (event: WorkerPayload): Promise<void> => {
  log("info", "worker invoked", { command: event.command, invokedBy: event.invokedBy });
  const { applicationId, token } = event;
  if (!applicationId || !token) {
    log("error", "missing interaction context", { command: event.command });
    return;
  }
  const ctx: InteractionContext = { applicationId, token, invokedBy: event.invokedBy };
  try {
    switch (event.command) {
      case "start":
        await handleStart(ctx);
        break;
      case "stop":
        await handleStop(ctx);
        break;
      case "status":
        await handleStatus(ctx);
        break;
      default:
        await editOriginalResponse(
          applicationId,
          token,
          `❓ 不明なコマンドです: ${event.command ?? "(なし)"}`,
        );
    }
  } catch (err) {
    log("error", "worker unhandled error", { command: event.command, error: errorMessage(err) });
    // Event Invoke のため、ここで throw すると Lambda が自動再実行してコマンドが
    // 二重実行される。通知の失敗も含めて必ずここで握り潰す。
    try {
      await editOriginalResponse(
        applicationId,
        token,
        `❌ 処理中にエラーが発生しました: ${errorMessage(err)}`,
      );
    } catch (notifyErr) {
      log("error", "failed to notify error to discord", { error: errorMessage(notifyErr) });
    }
  }
};

/** 中間経過の通知。Discord 障害で起動処理自体を止めないため、失敗は記録して続行する */
async function notifyBestEffort(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log("warn", "best-effort notification failed", { label, error: errorMessage(err) });
  }
}

// ---------------------------------------------------------------------------
// /start
// ---------------------------------------------------------------------------

const PURCHASING_LABELS: Record<Purchasing, string> = {
  spot: "スポット",
  ondemand: "オンデマンド",
  "spot-then-ondemand": "スポット（確保できない場合はオンデマンド）",
};

const EXHAUSTED_MESSAGES: Record<Purchasing, string> = {
  spot: '❌ スポットインスタンスを確保できませんでした。しばらく待って再試行するか、server.json の `ec2.purchasing` を `"spot-then-ondemand"` に変更してデプロイしてください。',
  ondemand: "❌ オンデマンドインスタンスを確保できませんでした。しばらく待って再試行してください。",
  "spot-then-ondemand":
    "❌ スポット・オンデマンドのいずれでもインスタンスを確保できませんでした。しばらく待って再試行してください。",
};

/** 候補を順に試し、容量系エラーなら次へフォールバックする。全滅なら undefined */
async function tryLaunchCandidates(
  candidates: readonly LaunchCandidate[],
  ondemand: boolean,
  dataVolume: LaunchOptions["dataVolume"],
): Promise<{ instanceId: string; candidate: LaunchCandidate } | undefined> {
  for (const candidate of candidates) {
    try {
      const instanceId = await launchInstance({
        candidate,
        launchTemplateId: config.launchTemplateId,
        ondemand,
        dataVolume,
      });
      return { instanceId, candidate };
    } catch (err) {
      if (isRetryableCapacityError(err)) {
        log("warn", "capacity error, falling back to next candidate", {
          az: candidate.az,
          instanceType: candidate.instanceType,
          ondemand,
          error: errorMessage(err),
        });
        continue;
      }
      throw err;
    }
  }
  return undefined;
}

async function handleStart(ctx: InteractionContext): Promise<void> {
  const purchasing = config.purchasing;

  const takeover = await transitionState({ from: "STOPPED", to: "STARTING" });
  if (!takeover.ok) {
    await editOriginalResponse(
      ctx.applicationId,
      ctx.token,
      `⏳ 既に操作が進行中です（現在: ${stateLabel(takeover.currentState)}）`,
    );
    return;
  }

  let instanceId: string | undefined;
  try {
    const [orphan, snapshot, subnetsByAz] = await Promise.all([
      findOrphanDataVolume(),
      findLatestDataSnapshot(),
      getSubnetsByAz(config.subnetIds),
    ]);

    const notes: string[] = [];
    if (orphan) {
      notes.push(
        `⚠️ 前回のデータボリューム (\`${orphan.volumeId}\`) が残っていたため、スナップショットではなくこのボリュームを再利用します（AZ ${orphan.az} に限定して起動）。`,
      );
    } else if (!snapshot) {
      notes.push("ℹ️ 既存のワールドデータが見つからないため、新規ワールドとして起動します。");
    }
    await notifyBestEffort("start-progress", () =>
      editOriginalResponse(
        ctx.applicationId,
        ctx.token,
        [`⏳ サーバーを起動しています…（${PURCHASING_LABELS[purchasing]}）`, ...notes].join("\n"),
      ),
    );

    const dataVolume = orphan
      ? undefined
      : { snapshotId: snapshot?.snapshotId, sizeGb: config.dataVolumeSizeGb };

    let launched: { instanceId: string; candidate: LaunchCandidate } | undefined;
    let usedMarket: "spot" | "ondemand" = "spot";

    if (purchasing !== "ondemand") {
      let candidates = await fetchSpotCandidates(config.instanceTypes, subnetsByAz);
      if (orphan) {
        candidates = candidates.filter((c) => c.az === orphan.az);
      }
      // spot-then-ondemand なら価格履歴が空（候補ゼロ）でもオンデマンドへ進む
      if (candidates.length === 0 && purchasing === "spot") {
        throw new Error("利用可能な AZ / インスタンスタイプの候補が見つかりませんでした");
      }
      log("info", "spot candidates", {
        candidates: candidates.map((c) => `${c.az}/${c.instanceType}@$${c.price}`),
      });
      launched = await tryLaunchCandidates(candidates, false, dataVolume);
    }

    if (!launched && purchasing !== "spot") {
      if (purchasing === "spot-then-ondemand") {
        await notifyBestEffort("ondemand-fallback", () =>
          sendFollowup(
            ctx.applicationId,
            ctx.token,
            "⚠️ スポットを確保できなかったため、オンデマンドにフォールバックします…",
          ),
        );
      }
      let candidates = buildOndemandCandidates(config.instanceTypes, subnetsByAz);
      if (orphan) {
        candidates = candidates.filter((c) => c.az === orphan.az);
      }
      if (candidates.length === 0) {
        throw new Error("利用可能な AZ / インスタンスタイプの候補が見つかりませんでした");
      }
      log("info", "ondemand candidates", {
        candidates: candidates.map((c) => `${c.az}/${c.instanceType}`),
      });
      launched = await tryLaunchCandidates(candidates, true, dataVolume);
      usedMarket = "ondemand";
    }

    if (!launched) {
      await transitionState({ from: "STARTING", to: "STOPPED", clear: ["instance_id"] });
      await sendFollowup(ctx.applicationId, ctx.token, EXHAUSTED_MESSAGES[purchasing]);
      return;
    }
    instanceId = launched.instanceId;
    const chosen = launched.candidate;

    const info = await waitForInstance(instanceId);
    let volumeId = info.dataVolumeId;
    if (orphan) {
      await attachDataVolume(orphan.volumeId, instanceId);
      volumeId = orphan.volumeId;
    } else if (volumeId) {
      // 新規作成 (またはスナップショット復元) されたデータボリュームにタグ付け。
      // lifecycle Lambda がこのタグを頼りにスナップショット化・削除する。
      await tagDataVolume(volumeId);
    }
    if (!info.publicIp) {
      throw new Error("パブリック IP を取得できませんでした");
    }

    await upsertARecord(config.hostedZoneId, config.serverFqdn, info.publicIp);

    await transitionState({
      from: "STARTING",
      to: "RUNNING",
      set: {
        instance_id: instanceId,
        az: chosen.az,
        instance_type: chosen.instanceType,
        purchasing: usedMarket,
        ...(usedMarket === "spot" && chosen.price !== undefined
          ? { spot_price: chosen.price }
          : {}),
        ...(volumeId ? { volume_id: volumeId } : {}),
      },
      clear: ["snapshot_id"],
    });

    const priceLabel =
      usedMarket === "ondemand"
        ? purchasing === "spot-then-ondemand"
          ? "オンデマンド（スポットからフォールバック）"
          : "オンデマンド"
        : `$${chosen.price?.toFixed(4) ?? "?"}/時（スポット）`;
    // 起動は既に成功している。通知失敗で catch に落ちるとインスタンスを
    // 巻き戻し（terminate）してしまうため、ここはベストエフォートにする。
    await notifyBestEffort("start-success", () =>
      sendFollowup(
        ctx.applicationId,
        ctx.token,
        [
          `🚀 サーバー起動中: \`${config.serverFqdn}\` (${info.publicIp})`,
          `AZ: ${chosen.az} / タイプ: ${chosen.instanceType} / 単価: ${priceLabel}`,
          "ワールドの読込が完了したら改めて通知されます。",
        ].join("\n"),
      ),
    );
  } catch (err) {
    log("error", "start failed", { error: errorMessage(err), instanceId });
    if (instanceId) {
      try {
        await terminateInstance(instanceId);
      } catch (terminateErr) {
        log("error", "failed to terminate instance after start failure", {
          instanceId,
          error: errorMessage(terminateErr),
        });
      }
    }
    try {
      await transitionState({ from: "STARTING", to: "STOPPED", clear: ["instance_id"] });
    } catch (revertErr) {
      log("error", "failed to revert state to STOPPED", { error: errorMessage(revertErr) });
    }
    await sendFollowup(ctx.applicationId, ctx.token, `❌ 起動に失敗しました: ${errorMessage(err)}`);
  }
}

// ---------------------------------------------------------------------------
// /stop
// ---------------------------------------------------------------------------

async function handleStop(ctx: InteractionContext): Promise<void> {
  const result = await transitionState({ from: "RUNNING", to: "STOPPING" });
  if (!result.ok) {
    await editOriginalResponse(
      ctx.applicationId,
      ctx.token,
      `⏳ 既に操作が進行中です（現在: ${stateLabel(result.currentState)}）`,
    );
    return;
  }

  const instanceId = result.record.instance_id;
  if (!instanceId) {
    await transitionState({ from: "STOPPING", to: "STOPPED" });
    await editOriginalResponse(
      ctx.applicationId,
      ctx.token,
      "⚠️ 稼働中のインスタンスが記録されていませんでした。状態を停止済みに戻しました。",
    );
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

  await editOriginalResponse(
    ctx.applicationId,
    ctx.token,
    "🛑 停止処理を開始しました。バックアップ完了後に通知します。",
  );
}

// ---------------------------------------------------------------------------
// /status
// ---------------------------------------------------------------------------

function formatUptime(launchTime: Date, now: Date = new Date()): string {
  const totalMinutes = Math.max(0, Math.floor((now.getTime() - launchTime.getTime()) / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}時間${minutes}分` : `${minutes}分`;
}

async function handleStatus(ctx: InteractionContext): Promise<void> {
  const record = await getServerRecord();

  if (!record || record.state === "STOPPED") {
    await editOriginalResponse(
      ctx.applicationId,
      ctx.token,
      "💤 サーバーは停止中です。`/start` で起動できます。",
    );
    return;
  }

  const emoji: Record<ServerState, string> = {
    STOPPED: "💤",
    STARTING: "🚀",
    RUNNING: "🟢",
    STOPPING: "🛑",
    SNAPSHOTTING: "💾",
  };
  const lines: string[] = [`${emoji[record.state]} 状態: ${stateLabel(record.state)}`];

  if (
    record.instance_id &&
    (record.state === "RUNNING" || record.state === "STARTING" || record.state === "STOPPING")
  ) {
    const instance = await describeInstance(record.instance_id);
    const instanceState = instance?.State?.Name;
    if (instance && instanceState !== "terminated" && instanceState !== "shutting-down") {
      if (instance.PublicIpAddress) {
        lines.push(`接続先: \`${config.serverFqdn}\` (${instance.PublicIpAddress})`);
      }
      lines.push(
        `インスタンス: ${record.instance_id} / AZ: ${record.az ?? "?"} / タイプ: ${record.instance_type ?? "?"}`,
      );
      if (instance.LaunchTime) {
        lines.push(`稼働時間: ${formatUptime(instance.LaunchTime)}`);
      }
      if (record.purchasing === "ondemand") {
        lines.push("購入方式: オンデマンド");
      } else if (record.az && record.instance_type) {
        // purchasing 未記録の旧レコードはスポットとして扱う（後方互換）
        const price = await getCurrentSpotPrice(record.instance_type, record.az).catch(
          () => undefined,
        );
        if (price !== undefined) {
          lines.push(
            `現在のスポット価格: $${price.toFixed(4)}/時（起動時: $${record.spot_price?.toFixed(4) ?? "?"}/時）`,
          );
        }
      }
    } else {
      lines.push(
        `⚠️ 記録上のインスタンス (${record.instance_id}) は既に終了しています。まもなくバックアップ処理が始まります。`,
      );
    }
  }
  lines.push(`最終更新: ${record.updated_at}`);

  await editOriginalResponse(ctx.applicationId, ctx.token, lines.join("\n"));
}
