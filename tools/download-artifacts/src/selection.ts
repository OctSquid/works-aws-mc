/**
 * バージョン・アセット選択の純粋ロジック（ネットワーク非依存・テスト対象）。
 * API 呼び出しと DL は resolvers.ts / http.ts が担当する。
 */

/**
 * server.json の minecraft_version を Fill API のバージョン一覧から具体バージョンに解決する。
 * versions は {"26.1": ["26.1.2", "26.1.1"], ...} のようにファミリーでグループ化されているため、
 * "26.1" のようなファミリー指定なら最新の安定版 (rc/pre を除く) を選ぶ。
 */
export function pickMinecraftVersion(
  requested: string,
  versions: Record<string, string[]>,
): string {
  const all = Object.values(versions).flat();
  if (all.includes(requested)) return requested;

  const family = versions[requested];
  if (family) {
    const stable = family.find((v) => !/-(rc|pre)/.test(v));
    if (stable) return stable;
  }
  throw new Error(
    `Minecraft version ${requested} not found on PaperMC. available families: ${Object.keys(versions).join(", ")}`,
  );
}

export interface ModrinthVersion {
  version_number: string;
  loaders: string[];
  files: { url: string; primary: boolean }[];
}

/** Modrinth のバージョン一覧（新しい順）から対象バージョンを選ぶ */
export function pickModrinthVersion(
  versions: readonly ModrinthVersion[],
  requested: string,
): ModrinthVersion | undefined {
  return requested === "latest"
    ? versions[0]
    : versions.find((v) => v.version_number === requested);
}

/** Modrinth バージョンの DL 対象ファイル（primary 優先、無ければ先頭） */
export function pickModrinthFile(
  version: ModrinthVersion,
): { url: string; primary: boolean } | undefined {
  return version.files.find((f) => f.primary) ?? version.files[0];
}

export interface GithubAsset {
  name: string;
  browser_download_url: string;
}

/** GitHub Release のアセットから assetPattern（正規表現）に一致する最初のものを選ぶ */
export function pickGithubAsset(
  assets: readonly GithubAsset[],
  assetPattern: string,
): GithubAsset | undefined {
  const pattern = new RegExp(assetPattern);
  return assets.find((a) => pattern.test(a.name));
}
