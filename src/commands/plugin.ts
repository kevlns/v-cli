import path from "node:path";
import type { Command } from "commander";
import type { CliCommand } from "../core/command";
import type { CliContext } from "../core/context";
import { loadAllCommands, loadLocalPlugins } from "../core/loader";

/** 插件管理：列出内置与本地命令、查看本地插件目录 */
export const plugin: CliCommand = {
  name: "plugin",
  description: "插件管理：list 列出命令，path 显示本地插件目录",

  register(program: Command, ctx: CliContext) {
    program
      .command("list")
      .description("列出内置命令与本地插件")
      .action(async () => {
        const all = await loadAllCommands(ctx);
        const rows = all.map((item) => ({
          source: item.source,
          name: item.command?.name ?? "(加载失败)",
          description: item.command?.description ?? item.error ?? "",
          file: item.file ?? "",
        }));
        if (ctx.json) {
          ctx.log.result(rows);
        } else {
          for (const row of rows) {
            ctx.log.result(`[${row.source}] ${row.name}: ${row.description}`);
          }
        }
      });

    program
      .command("path")
      .description("打印本地插件目录（放入 .mjs 文件即生效）")
      .action(() => {
        const dir = path.join(ctx.homeDir, "commands");
        if (ctx.json) {
          ctx.log.result({ dir });
        } else {
          ctx.log.result(dir);
        }
      });
  },
};