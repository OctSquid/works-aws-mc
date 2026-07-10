import {
  ChangeResourceRecordSetsCommand,
  ListResourceRecordSetsCommand,
  Route53Client,
} from "@aws-sdk/client-route-53";
import { log } from "./config";

const route53 = new Route53Client({});

function normalizeFqdn(fqdn: string): string {
  return fqdn.endsWith(".") ? fqdn : `${fqdn}.`;
}

/** SERVER_FQDN の A レコードを UPSERT する（TTL 60） */
export async function upsertARecord(hostedZoneId: string, fqdn: string, ip: string, ttl = 60): Promise<void> {
  await route53.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: hostedZoneId,
      ChangeBatch: {
        Comment: "mc-server: upsert A record on start",
        Changes: [
          {
            Action: "UPSERT",
            ResourceRecordSet: {
              Name: normalizeFqdn(fqdn),
              Type: "A",
              TTL: ttl,
              ResourceRecords: [{ Value: ip }],
            },
          },
        ],
      },
    }),
  );
  log("info", "route53 A record upserted", { fqdn, ip });
}

/**
 * SERVER_FQDN の A レコードを削除する。
 * 現在値はレコード照会で取得（存在しなければ何もしない: 冪等）。
 */
export async function deleteARecord(hostedZoneId: string, fqdn: string): Promise<boolean> {
  const name = normalizeFqdn(fqdn);
  const res = await route53.send(
    new ListResourceRecordSetsCommand({
      HostedZoneId: hostedZoneId,
      StartRecordName: name,
      StartRecordType: "A",
      MaxItems: 1,
    }),
  );
  const record = res.ResourceRecordSets?.[0];
  if (!record || record.Name !== name || record.Type !== "A") {
    log("info", "route53 A record not found, skip delete", { fqdn });
    return false;
  }
  await route53.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: hostedZoneId,
      ChangeBatch: {
        Comment: "mc-server: delete A record on terminate",
        Changes: [{ Action: "DELETE", ResourceRecordSet: record }],
      },
    }),
  );
  log("info", "route53 A record deleted", { fqdn });
  return true;
}
