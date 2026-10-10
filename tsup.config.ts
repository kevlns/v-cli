import { defineConfig } from "tsup";

export default defineConfig({
  // cli 是 bin（src/cli.ts 首行 shebang 由 esbuild 保留）；
  // sdk 是模块出口（package.json exports["."] → dist/sdk.mjs + dist/sdk.d.ts）。
  entry: { cli: "src/cli.ts", sdk: "src/sdk.ts" },
  format: ["esm"],
  target: "node20",
  clean: true,
  dts: true,
  // 每个入口自包含：dist/cli.mjs 与 dist/sdk.mjs 都可直接单独分发（与单文件分发约定一致）
  splitting: false,
  outExtension: () => ({ js: ".mjs" }),
});
