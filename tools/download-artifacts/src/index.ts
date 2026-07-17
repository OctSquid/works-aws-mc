import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { downloadPaper, downloadPlugin } from "./resolvers.js";
import type { Manifest, PluginsSpec, ServerSpec } from "./types.js";

/**
 * server.json の ec2 設定を検証する。AMI (architecture) とインスタンスタイプの
 * 不整合は起動時まで発覚しないため、ami-build CI の入口で落とす。
 * Graviton 系はファミリー名が "<英字><世代>g" で始まる（例: m6g, m7g, t4g, m6gd）。
 */
function validateServerSpec(spec: ServerSpec): void {
  const ec2 = spec.ec2;
  if (!ec2 || (ec2.architecture !== "arm64" && ec2.architecture !== "x86_64")) {
    throw new Error('server.json: ec2.architecture は "arm64" か "x86_64" を指定してください');
  }
  if (!Array.isArray(ec2.instance_types) || ec2.instance_types.length === 0) {
    throw new Error("server.json: ec2.instance_types は 1 つ以上指定してください");
  }
  for (const type of ec2.instance_types) {
    const isGraviton = /^[a-z]+\d+g/.test(type);
    if (isGraviton !== (ec2.architecture === "arm64")) {
      throw new Error(
        `server.json: インスタンスタイプ ${type} は architecture=${ec2.architecture} と整合しません`,
      );
    }
  }
  if (
    ec2.purchasing !== undefined &&
    !["spot", "ondemand", "spot-then-ondemand"].includes(ec2.purchasing)
  ) {
    throw new Error(
      'server.json: ec2.purchasing は "spot" / "ondemand" / "spot-then-ondemand" のいずれかを指定してください',
    );
  }
}

const { values } = parseArgs({
  options: {
    "repo-root": { type: "string", default: path.resolve(import.meta.dirname, "../../..") },
    out: { type: "string" },
  },
});

const repoRoot = path.resolve(values["repo-root"]!);
const outDir = path.resolve(values.out ?? path.join(repoRoot, "artifacts"));

const server = JSON.parse(await readFile(path.join(repoRoot, "server.json"), "utf8")) as ServerSpec;
validateServerSpec(server);
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
