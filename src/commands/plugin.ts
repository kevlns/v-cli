import path from "node:path";
import type { Command } from "commander";
import type { CliCommand } from "../core/command";
import type { CliContext } from "../core/context";
import { loadAllCommands, loadLocalPlugins } from "../core/loader";
import { discoverAllOfficialPlugins } from "../core/official";

/** 插件管理：列出内置/本地/官方命令、查看本地插件目录 */
export const plugin: CliCommand = {
  name: "plugin",
  description: "插件管理：list 列出命令，path 显示本地插件目录",
  apiVersion: 1,

  register(program: Command, ctx: CliContext) {
    program
      .command("list")
      .description("列出内置命令、本地插件与官方插件状态")
      .option("--json", "输出机器可读 JSON")
      .action(async (opts: { json?: boolean }) => {
        const json = ctx.json || opts.json;
        const all = await loadAllCommands(ctx);
        const rows = all.map((item) => ({
          source: item.source,
          name: item.command?.name ?? "(加载失败)",
          description: item.command?.description ?? item.error ?? "",
          file: item.file ?? "",
        }));
        const official = discoverAllOfficialPlugins().map((o) => ({
          source: "official" as const,
          name: o.name,
          description: o.description,
          package: o.package,
          version: o.version,
          status: o.status,
          platform: o.platform,
          error: o.error,
        }));
        if (json) {
          ctx.log.result([...rows, ...official]);
        } else {
          for (const row of rows) {
            ctx.log.result(`[${row.source}] ${row.name}: ${row.description}`);
          }
          for (const row of official) {
            ctx.log.result(
              `[${row.source}] ${row.name}: ${row.description} [${row.status}]${
                row.error ? ` ${row.error}` : ""
              }`,
            );
          }
        }
      });

    program
      .command("path")
      .description("打印本地插件目录（放入 .mjs 文件即生效）")
      .option("--json", "输出机器可读 JSON")
      .action((opts: { json?: boolean }) => {
        const dir = path.join(ctx.homeDir, "commands");
        if (ctx.json || opts.json) {
          ctx.log.result({ dir });
        } else {
          ctx.log.result(dir);
        }
      });
  },
};