import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { downloadPaper, downloadPlugin } from "./resolvers.js";
import type { Manifest, PluginsSpec, ServerSpec } from "./types.js";

const { values } = parseArgs({
  options: {
    "repo-root": { type: "string", default: path.resolve(import.meta.dirname, "../../..") },
    out: { type: "string" },
  },
});

const repoRoot = path.resolve(values["repo-root"]!);
const outDir = path.resolve(values.out ?? path.join(repoRoot, "artifacts"));

const server = JSON.parse(await readFile(path.join(repoRoot, "server.json"), "utf8")) as ServerSpec;
const plugins = JSON.parse(
  await readFile(path.join(repoRoot, "plugins.json"), "utf8"),
) as PluginsSpec;

await mkdir(path.join(outDir, "plugins"), { recursive: true });

console.log(`Paper ${server.minecraft_version} (build: ${server.paper_build}) をダウンロード中...`);
const paperBuild = await downloadPaper(server, path.join(outDir, "paper.jar"));
console.log(`  -> paper.jar (build ${paperBuild})`);

const resolvedPlugins: Manifest["plugins"] = [];
for (const plugin of plugins.plugins) {
  console.log(`プラグイン ${plugin.name} (${plugin.source}) をダウンロード中...`);
  const resolved = await downloadPlugin(plugin, path.join(outDir, "plugins"), repoRoot);
  console.log(`  -> plugins/${plugin.name}.jar (${resolved})`);
  resolvedPlugins.push({ name: plugin.name, source: plugin.source, resolved });
}

const manifest: Manifest = {
  minecraft_version: server.minecraft_version,
  paper_build: paperBuild,
  jvm: server.jvm,
  preserve: plugins.plugins.flatMap((p) => p.preserve ?? []),
  plugins: resolvedPlugins,
  generated_at: new Date().toISOString(),
};
await writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`manifest.json を生成しました: ${path.join(outDir, "manifest.json")}`);
