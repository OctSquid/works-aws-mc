import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

const USER_AGENT = "aws-mc-server/1.0 (https://github.com; artifact downloader)";

export async function fetchJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT, ...headers } });
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export async function downloadFile(
  url: string,
  dest: string,
  opts: { sha256?: string; headers?: Record<string, string> } = {},
): Promise<void> {
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT, ...opts.headers },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (opts.sha256) {
    const actual = createHash("sha256").update(buf).digest("hex");
    if (actual !== opts.sha256.toLowerCase()) {
      throw new Error(`sha256 mismatch for ${url}: expected ${opts.sha256}, got ${actual}`);
    }
  }
  await writeFile(dest, buf);
}
