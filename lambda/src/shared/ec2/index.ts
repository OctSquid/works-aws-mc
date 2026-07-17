/**
 * EC2 操作のバレル。以前は 500 行弱の単一 ec2.ts だったものを
 * candidates（起動候補・価格）/ instances（起動・停止・監視）/
 * volumes（ボリューム・スナップショット）に分割した。
 * 既存の import パス（"../shared/ec2"）はそのまま使える。
 */
export * from "./candidates";
export * from "./constants";
export * from "./instances";
export * from "./volumes";
