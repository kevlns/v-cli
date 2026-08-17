import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import type { CliCommand } from "../core/command";
import type { CliContext } from "../core/context";
import { loadLocalPlugins } from "../core/loader";
import { VERSION } from "../version";

/** 环境体检：永远成功退出，问题体现在数据里 */
export const doctor: CliCommand = {
  name: "doctor",
  description: "体检：node/vcli 版本、homeDir、config、插件状态",

  register(program: Command, ctx: CliContext) {
    program.action(async () => {
      const homeDir = ctx.homeDir;
      const exists = fs.existsSync(homeDir);
      let configWritable = false;
      try {
        ctx.config.set((cfg) => cfg);
        configWritable = true;
      } catch {
        configWritable = false;
      }
      const plugins = await loadLocalPlugins(ctx);
      const list = plugins.map((p) => ({
        source: p.source,
        file: p.file,
        error: p.error ?? null,
      }));
      const report = {
        version: VERSION,
        node: process.version,
        homeDir,
        homeDirExists: exists,
        configWritable,
        localPluginCount: plugins.length,
        localPlugins: list,
      };
      if (ctx.json) {
        ctx.log.result(report);
      } else {
        ctx.log.result(`vcli ${VERSION} (node ${process.version})`);
        ctx.log.result(`homeDir: ${homeDir} ${exists ? "(存在)" : "(不存在)"}`);
        ctx.log.result(`config: ${configWritable ? "可读写" : "不可写"}`);
        ctx.log.result(`本地插件: ${plugins.length} 个`);
        for (const p of plugins) {
          ctx.log.result(`  - ${p.file}${p.error ? `  [失败: ${p.error}]` : ""}`);
        }
      }
    });
  },
};