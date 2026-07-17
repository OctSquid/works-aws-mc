/** タグ・デバイス名などの規約（Terraform 側・インスタンス側スクリプトと合意済み） */

export const TAG_PROJECT = { Key: "Project", Value: "mc-server" } as const;
export const TAG_ROLE = { Key: "mc:role", Value: "server" } as const;
export const TAG_DATA = { Key: "mc:data", Value: "true" } as const;
export const STOP_REASON_TAG_KEY = "mc:stop-reason";
export const DATA_DEVICE_NAME = "/dev/sdf";

export type StopReason = "manual" | "auto-idle" | "spot" | "max-runtime";
