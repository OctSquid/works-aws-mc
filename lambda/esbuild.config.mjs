import { build } from "esbuild";
import { rmSync } from "node:fs";

const functions = ["interactions", "command-worker", "lifecycle", "spot-interruption"];

rmSync("dist", { recursive: true, force: true });

// CJS 依存 (tweetnacl 等) を ESM バンドルへ取り込むための shim
const banner = {
  js: [
    "import { createRequire as __createRequire } from 'node:module';",
    "const require = __createRequire(import.meta.url);",
  ].join("\n"),
};

await Promise.all(
  functions.map((name) =>
    build({
      entryPoints: [`src/${name}/handler.ts`],
      outfile: `dist/${name}/index.mjs`,
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      sourcemap: false,
      minify: false,
      banner,
      logLevel: "info",
    }),
  ),
);
