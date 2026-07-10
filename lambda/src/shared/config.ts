/**
 * 環境変数（Terraform 側が注入）と構造化ログのヘルパー。
 * 各値は Lambda 関数ごとに必要なものだけアクセスされるよう遅延評価にする。
 */

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`環境変数 ${name} が設定されていません`);
  }
  return value;
}

function csv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function intEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) ? n : defaultValue;
}

export const DEFAULT_INSTANCE_TYPES = "m7a.large,m7i.large,m6a.large";

export const config = {
  get tableName(): string {
    return requireEnv("TABLE_NAME");
  },
  get launchTemplateId(): string {
    return requireEnv("LAUNCH_TEMPLATE_ID");
  },
  get subnetIds(): string[] {
    return csv(requireEnv("SUBNET_IDS"));
  },
  get hostedZoneId(): string {
    return requireEnv("HOSTED_ZONE_ID");
  },
  get serverFqdn(): string {
    return requireEnv("SERVER_FQDN");
  },
  get workerFunctionName(): string {
    return requireEnv("WORKER_FUNCTION_NAME");
  },
  get instanceTypes(): string[] {
    return csv(process.env["INSTANCE_TYPES"] ?? DEFAULT_INSTANCE_TYPES);
  },
  get dataVolumeSizeGb(): number {
    return intEnv("DATA_VOLUME_SIZE_GB", 20);
  },
  get snapshotRetention(): number {
    return intEnv("SNAPSHOT_RETENTION", 7);
  },
};

export type LogLevel = "info" | "warn" | "error";

export function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...data,
    }),
  );
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
