import { config, errorMessage, log, sleep } from "../shared/config";
import { editOriginalResponse, sendFollowup } from "../shared/discord";
import {
  attachDataVolume,
  buildOndemandCandidates,
  fetchSpotCandidates,
  findLatestDataSnapshot,
  findOrphanDataVolume,
  findRunningServerInstance,
  getSubnetsByAz,
  isRetryableCapacityError,
  launchInstance,
  tagDataVolume,
  terminateInstance,
  waitForInstance,
  type LaunchCandidate,
  type LaunchOptions,
} from "../shared/ec2";
import {
  EXHAUSTED_MESSAGES,
  NEW_WORLD_NOTE,
  busyMessage,
  degradedStartMessage,
  doubleLaunchAbortMessage,
  ondemandFallbackNotice,
  orphanVolumeNote,
  priceLabel,
  startFailedMessage,
  startProgressMessage,
  startedEmbed,
} from "../shared/messages";
import { upsertARecord } from "../shared/route53";
import { transitionState } from "../shared/state";
import type { InteractionContext } from "../shared/types";

/** 中間経過の通知。Discord 障害で起動処理自体を止めないため、失敗は記録して続行する */
async function notifyBestEffort(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log("warn", "best-effort notification failed", { label, error: errorMessage(err) });
  }
}

const POST_LAUNCH_RETRY_DELAY_MS = 2_000;

/** 一時障害向けの単純リトライ。全滅したら最後のエラーを throw する */
async function withRetries<T>(fn: () => Promise<T>, label: string, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      log("warn", "retryable step failed", { label, attempt, error: errorMessage(err) });
      if (attempt < attempts) await sleep(POST_LAUNCH_RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}

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

interface DataSource {
  orphan: { volumeId: string; az: string } | undefined;
  snapshot: { snapshotId: string } | undefined;
  subnetsByAz: Record<string, string>;
  notes: string[];
  /** RunInstances の BDM 上書き（孤児ボリューム再利用時は undefined） */
  dataVolume: LaunchOptions["dataVolume"];
}

/** 復元元（孤児ボリューム / 最新スナップショット / 新規）とサブネットを解決する */
async function resolveDataSource(): Promise<DataSource> {
  const [orphan, snapshot, subnetsByAz] = await Promise.all([
    findOrphanDataVolume(),
    findLatestDataSnapshot(),
    getSubnetsByAz(config.subnetIds),
  ]);
  const notes: string[] = [];
  if (orphan) {
    notes.push(orphanVolumeNote(orphan.volumeId, orphan.az));
  } else if (!snapshot) {
    notes.push(NEW_WORLD_NOTE);
  }
  const dataVolume = orphan
    ? undefined
    : { snapshotId: snapshot?.snapshotId, sizeGb: config.dataVolumeSizeGb };
  return { orphan, snapshot, subnetsByAz, notes, dataVolume };
}

/**
 * purchasing 設定に従ってインスタンスを確保する（スポット→オンデマンドの
 * フォールバックを含む）。全候補が容量系エラーで枯渇したら undefined。
 */
async function acquireInstance(
  ctx: InteractionContext,
  source: DataSource,
): Promise<
  { instanceId: string; candidate: LaunchCandidate; market: "spot" | "ondemand" } | undefined
> {
  const purchasing = config.purchasing;

  if (purchasing !== "ondemand") {
    let candidates = await fetchSpotCandidates(config.instanceTypes, source.subnetsByAz);
    if (source.orphan) {
      const orphanAz = source.orphan.az;
      candidates = candidates.filter((c) => c.az === orphanAz);
    }
    // spot-then-ondemand なら価格履歴が空（候補ゼロ）でもオンデマンドへ進む
    if (candidates.length === 0 && purchasing === "spot") {
      throw new Error("利用可能な AZ / インスタンスタイプの候補が見つかりませんでした");
    }
    log("info", "spot candidates", {
      candidates: candidates.map((c) => `${c.az}/${c.instanceType}@$${c.price}`),
    });
    const launched = await tryLaunchCandidates(candidates, false, source.dataVolume);
    if (launched) return { ...launched, market: "spot" };
  }

  if (purchasing === "spot") return undefined;

  if (purchasing === "spot-then-ondemand") {
    await notifyBestEffort("ondemand-fallback", () =>
      sendFollowup(ctx.applicationId, ctx.token, ondemandFallbackNotice()),
    );
  }
  let candidates = buildOndemandCandidates(config.instanceTypes, source.subnetsByAz);
  if (source.orphan) {
    const orphanAz = source.orphan.az;
    candidates = candidates.filter((c) => c.az === orphanAz);
  }
  if (candidates.length === 0) {
    throw new Error("利用可能な AZ / インスタンスタイプの候補が見つかりませんでした");
  }
  log("info", "ondemand candidates", {
    candidates: candidates.map((c) => `${c.az}/${c.instanceType}`),
  });
  const launched = await tryLaunchCandidates(candidates, true, source.dataVolume);
  return launched ? { ...launched, market: "ondemand" } : undefined;
}

export async function handleStart(ctx: InteractionContext): Promise<void> {
  const purchasing = config.purchasing;

  const takeover = await transitionState({ from: "STOPPED", to: "STARTING" });
  if (!takeover.ok) {
    await editOriginalResponse(ctx.applicationId, ctx.token, busyMessage(takeover.currentState));
    return;
  }

  let instanceId: string | undefined;
  try {
    // stale-takeover 等で前回のインスタンスがまだ生きている場合の二重起動ガード。
    // 状態機械（DynamoDB）は文字列しか見ていないため、EC2 側の実態を確認する。
    const existing = await findRunningServerInstance();
    if (existing) {
      log("warn", "running server instance found before launch, aborting", { ...existing });
      await transitionState({ from: "STARTING", to: "STOPPED" }).catch((err) =>
        log("error", "state revert failed", { error: errorMessage(err) }),
      );
      await editOriginalResponse(
        ctx.applicationId,
        ctx.token,
        doubleLaunchAbortMessage(existing.instanceId),
      );
      return;
    }

    const source = await resolveDataSource();
    await notifyBestEffort("start-progress", () =>
      editOriginalResponse(
        ctx.applicationId,
        ctx.token,
        startProgressMessage(purchasing, source.notes),
      ),
    );

    const launched = await acquireInstance(ctx, source);
    if (!launched) {
      await transitionState({ from: "STARTING", to: "STOPPED", clear: ["instance_id"] });
      await sendFollowup(ctx.applicationId, ctx.token, EXHAUSTED_MESSAGES[purchasing]);
      return;
    }
    instanceId = launched.instanceId;
    const chosen = launched.candidate;
    const usedMarket = launched.market;

    const info = await waitForInstance(instanceId);
    let volumeId = info.dataVolumeId;
    if (source.orphan) {
      await attachDataVolume(source.orphan.volumeId, instanceId);
      volumeId = source.orphan.volumeId;
    } else if (volumeId) {
      // 新規作成 (またはスナップショット復元) されたデータボリュームにタグ付け。
      // lifecycle Lambda がこのタグを頼りにスナップショット化・削除する。
      await tagDataVolume(volumeId);
    }
    if (!info.publicIp) {
      throw new Error("パブリック IP を取得できませんでした");
    }
    const publicIp = info.publicIp;

    // --- ここから先はインスタンスもデータボリュームも健全 ---
    // DNS 登録や状態記録の一時障害で稼働中のサーバーを terminate しないよう、
    // リトライした上で、それでも失敗したら IP 直結の劣化モードで案内する。
    const runningSet = {
      instance_id: instanceId,
      az: chosen.az,
      instance_type: chosen.instanceType,
      purchasing: usedMarket,
      ...(usedMarket === "spot" && chosen.price !== undefined ? { spot_price: chosen.price } : {}),
      ...(volumeId ? { volume_id: volumeId } : {}),
    };
    const transitionToRunning = async (): Promise<void> => {
      const result = await transitionState({
        from: "STARTING",
        to: "RUNNING",
        set: runningSet,
        clear: ["snapshot_id"],
      });
      if (!result.ok) {
        log("warn", "transition to RUNNING rejected", { currentState: result.currentState });
      }
    };

    try {
      await withRetries(
        () => upsertARecord(config.hostedZoneId, config.serverFqdn, publicIp),
        "route53-upsert",
      );
      await withRetries(transitionToRunning, "transition-to-running");
    } catch (postErr) {
      log("error", "post-launch finalization failed", {
        instanceId,
        error: errorMessage(postErr),
      });
      // DNS 失敗後でも状態記録は試みる（片方の失敗でもう片方を巻き添えにしない）
      await transitionToRunning().catch((err) =>
        log("error", "best-effort transition to RUNNING failed", { error: errorMessage(err) }),
      );
      await notifyBestEffort("start-degraded", () =>
        sendFollowup(
          ctx.applicationId,
          ctx.token,
          degradedStartMessage(errorMessage(postErr), publicIp),
        ),
      );
      return;
    }

    // 起動は既に成功している。通知失敗で catch に落ちるとインスタンスを
    // 巻き戻し（terminate）してしまうため、ここはベストエフォートにする。
    await notifyBestEffort("start-success", () =>
      sendFollowup(
        ctx.applicationId,
        ctx.token,
        startedEmbed({
          fqdn: config.serverFqdn,
          ip: publicIp,
          az: chosen.az,
          instanceType: chosen.instanceType,
          priceLabel: priceLabel(usedMarket, purchasing, chosen.price),
        }),
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
    await sendFollowup(ctx.applicationId, ctx.token, startFailedMessage(errorMessage(err)));
  }
}
