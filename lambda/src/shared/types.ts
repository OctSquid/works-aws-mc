/**
 * ハンドラ間で受け渡すペイロードの共有型。
 * 以前は interactions / command-worker / lifecycle / spot-interruption が
 * それぞれ独自定義しており optionality がドリフトしていたため一本化した。
 */

/** interactions → command-worker の非同期 Invoke ペイロード */
export interface WorkerPayload {
  command?: string;
  options?: Record<string, unknown>;
  applicationId?: string;
  token?: string;
  channelId?: string | undefined;
  invokedBy?: string | undefined;
  /** interactions の awsRequestId。ログを非同期ホップ越しに突き合わせるための相関 ID */
  correlationId?: string | undefined;
}

/** コマンドハンドラへ渡す応答用コンテキスト */
export interface InteractionContext {
  applicationId: string;
  token: string;
  invokedBy?: string | undefined;
}

/** EventBridge イベント（必要なフィールドのみ） */
export interface EventBridgeEvent {
  "detail-type"?: string;
  detail?: Record<string, unknown>;
}
