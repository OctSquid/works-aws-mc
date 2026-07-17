import { copyFile } from "node:fs/promises";
import path from "node:path";
import { downloadFile, fetchJson } from "./http.js";
import {
  pickGithubAsset,
  pickMinecraftVersion,
  pickModrinthFile,
  pickModrinthVersion,
  type ModrinthVersion,
} from "./selection.js";
import type { PluginSpec, ServerSpec } from "./types.js";

const FILL_API = "https://fill.papermc.io/v3/projects/paper";

/** server.json の minecraft_version を Fill API 上の具体バージョンに解決する */
async function resolveMinecraftVersion(requested: string): Promise<string> {
  const project = await fetchJson<{ versions: Record<string, string[]> }>(FILL_API);
  const version = pickMinecraftVersion(requested, project.versions);
  if (version !== requested) {
    console.log(`  バージョンファミリー ${requested} -> ${version} に解決`);
  }
  return version;
}

/** Paper 本体を DL し、解決した「バージョン/ビルド番号」を返す (PaperMC Fill API v3) */
export async function downloadPaper(spec: ServerSpec, dest: string): Promise<string> {
  const version = await resolveMinecraftVersion(spec.minecraft_version);
  const buildPath = spec.paper_build === "latest" ? "latest" : String(spec.paper_build);
  const build = await fetchJson<{
    id?: number;
    downloads?: Record<string, { url?: string; checksums?: { sha256?: string } }>;
  }>(`${FILL_API}/versions/${version}/builds/${buildPath}`);
  const dl = build.downloads?.["server:default"];
  if (!dl?.url) throw new Error("Fill API: server:default download not found");
  await downloadFile(dl.url, dest, { sha256: dl.checksums?.sha256 });
  return `${version}/${build.id ?? buildPath}`;
}

/** プラグイン1つを DL し、解決したバージョン/URL を返す */
export async function downloadPlugin(
  plugin: PluginSpec,
  destDir: string,
  repoRoot: string,
): Promise<string> {
  const dest = path.join(destDir, `${plugin.name}.jar`);

  switch (plugin.source) {
    case "geysermc": {
      const url = `https://download.geysermc.org/v2/projects/${plugin.project}/versions/latest/builds/latest/downloads/spigot`;
      await downloadFile(url, dest);
      return "latest";
    }

    case "hangar": {
      let version = plugin.version;
      if (version === "latest") {
        const res = await fetch(
          `https://hangar.papermc.io/api/v1/projects/${plugin.id}/latestrelease`,
          { headers: { "user-agent": "aws-mc-server/1.0" } },
        );
        if (!res.ok) throw new Error(`Hangar latestrelease for ${plugin.id}: ${res.status}`);
        version = (await res.text()).trim();
      }
      await downloadFile(
        `https://hangar.papermc.io/api/v1/projects/${plugin.id}/versions/${version}/PAPER/download`,
        dest,
      );
      return version;
    }

    case "modrinth": {
      const versions = await fetchJson<ModrinthVersion[]>(
        `https://api.modrinth.com/v2/project/${plugin.id}/version?loaders=${encodeURIComponent('["paper","spigot"]')}`,
      );
      const target = pickModrinthVersion(versions, plugin.version);
      if (!target) throw new Error(`Modrinth version ${plugin.version} not found for ${plugin.id}`);
      const file = pickModrinthFile(target);
      if (!file) throw new Error(`Modrinth: no files for ${plugin.id} ${target.version_number}`);
      await downloadFile(file.url, dest);
      return target.version_number;
    }

    case "github": {
      const headers: Record<string, string> = process.env.GITHUB_TOKEN
        ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
        : {};
      const releasePath =
        plugin.version === "latest" ? "releases/latest" : `releases/tags/${plugin.version}`;
      const release = await fetchJson<{
        tag_name: string;
        assets: { name: string; browser_download_url: string }[];
      }>(`https://api.github.com/repos/${plugin.repo}/${releasePath}`, headers);
      const asset = pickGithubAsset(release.assets, plugin.assetPattern);
      if (!asset) {
        throw new Error(
          `GitHub ${plugin.repo}@${release.tag_name}: no asset matching ${plugin.assetPattern}`,
        );
      }
      await downloadFile(asset.browser_download_url, dest, { sha256: plugin.sha256, headers });
      return release.tag_name;
    }

    case "curseforge": {
      const apiKey = process.env.CURSEFORGE_API_KEY;
      if (!apiKey) throw new Error(`CURSEFORGE_API_KEY is required for plugin ${plugin.name}`);
      const res = await fetchJson<{ data: string }>(
        `https://api.curseforge.com/v1/mods/${plugin.projectId}/files/${plugin.fileId}/download-url`,
        { "x-api-key": apiKey },
      );
      await downloadFile(res.data, dest);
      return `file:${plugin.fileId}`;
    }

    case "url": {
      await downloadFile(plugin.url, dest, { sha256: plugin.sha256 });
      return plugin.url;
    }

    case "local": {
      await copyFile(path.resolve(repoRoot, plugin.path), dest);
      return plugin.path;
    }
  }
}
