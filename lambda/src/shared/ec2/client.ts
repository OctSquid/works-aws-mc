import { EC2Client } from "@aws-sdk/client-ec2";

/** モジュール間で共有する EC2 クライアント（テストは aws-sdk-client-mock で差し替える） */
export const ec2 = new EC2Client({});
