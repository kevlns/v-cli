import { Command, CommanderError } from "commander";
import { createContext, defaultHomeDir } from "./core/context";
import { loadAllCommands } from "./core/loader";
import { mapExitCode, runPluginBin } from "./core/runner";
import {
  OFFICIAL_PLUGINS,
  discoverOfficialPlugin,
  isOfficialCommand,
} from "./core/official";
import { VERSION } from "./version";

/**
 * 前置扫描：只消费“连续开头的精确 `--json`”（可重复）。
 * 一旦出现任何其他词元（--bogus/-V/--help/命令名/位置参数），扫描立即停止——
 * 其余词元原样交给 commander 或官方拦截路由，绝不静默吞掉。
 * 因此：
 *   `--bogus xlmerge` → commander 拒绝未知选项（不路由）；
 *   `-V xlmerge`      → commander 输出版本（不路由）；
 *   `--json xlmerge`  → 全局 --json 消费、xlmerge 路由（剩余词元转发给插件）。
 */
function scanLeadingJson(rawArgs: string[]): { json: boolean; args: string[]; commandIndex: number } {
  let i = 0;
  while (i < rawArgs.length && rawArgs[i] === "--json") i++;
  return { json: i > 0, args: rawArgs.slice(i), commandIndex: i };
}

/** 官方插件拦截：`v-cli <xlmerge|unity> …` 时把剩余词元原样转交给插件子进程 */
async function interceptOfficialCommand(
  rawArgs: string[],
  commandIndex: number,
): Promise<number | undefined> {
  const token = rawArgs[commandIndex];
  if (!isOfficialCommand(token)) return undefined;
  const spec = OFFICIAL_PLUGINS.find((p) => p.command === token);
  if (!spec) return undefined;

  const info = discoverOfficialPlugin(spec);
  if (info.status !== "available" || !info.bin) {
    process.stderr.write(
      `[v-cli] 错误: 官方插件 ${spec.package}（命令 ${spec.command}）不可用：${
        info.error ?? info.status
      }\n`,
    );
    return 1;
  }

  // 剩余词元（含 --json / -- / --help / 插件自有选项）一律 verbatim 转发
  const result = await runPluginBin({ bin: info.bin, argv: rawArgs.slice(commandIndex + 1) });
  return mapExitCode(result);
}

async function main(): Promise<number> {
  const rawArgs = process.argv.slice(2);
  const span = scanLeadingJson(rawArgs);
  const ctx = createContext(defaultHomeDir(), span.json);

  // 官方插件命令拦截：必须在 commander 解析之前，保证 --help/--json 等落到插件。
  // 仅在第一个非 --json 词元就是官方命令时触发；其他前置标志（--bogus/-V/--help…）
  // 保持原样交给 commander。
  const intercepted = await interceptOfficialCommand(rawArgs, span.commandIndex);
  if (intercepted !== undefined) return intercepted;

  const program = new Command();
  program
    .name("v-cli")
    .description("kevlns 的个人工具箱")
    // 注意：不在此声明全局 --json —— 避免 commander 吞掉子命令自有的 --json。
    // 全局前置 --json 已由 scanLeadingJson 在解析前消费进 ctx.json。
    .version(VERSION)
    .showHelpAfterError();

  // AI Agent 快速开始：位于内置帮助末尾（"after" 只作用于顶层帮助，不泄漏到子命令）
  program.addHelpText(
    "after",
    [
      "AI Agent 快速开始（推荐顺序）：",
      "  1. v-cli agent docs",
      "  2. v-cli agent index --json",
      "  3. v-cli agent describe <name> --json",
      "  4. v-cli agent init .            （可选：写入工作区 AGENTS.md，AI Agent 自动读取）",
      "",
      "详情见 `v-cli agent --help`；单命令说明书：`v-cli agent docs --help` / `v-cli agent init --help`。",
    ].join("\n"),
  );

  const loaded = await loadAllCommands(ctx);
  for (const item of loaded) {
    if (!item.command) {
      ctx.log.warn(`${item.file ?? "?"} 加载失败: ${item.error ?? "未知错误"}`);
      continue;
    }
    const cmd = item.command;
    if (cmd.hidden) continue;
    // register 隔离：先在“悬挂”子命令上调用 register，成功后才挂上 program；
    // register 抛异常不会留下幽灵命令（--help 列表不受污染），也不阻断其他命令。
    const sub = new Command(cmd.name).description(cmd.description);
    try {
      cmd.register(sub, ctx);
      program.addCommand(sub);
    } catch (err) {
      ctx.log.warn(
        `${item.file ?? cmd.name} register 失败: ${
          err instanceof Error ? err.message : String(err)
        }；已跳过`,
      );
    }
  }

  // 静态注册官方命令（帮助可见；实际执行一律走上面的拦截，因此不给 action）
  for (const spec of OFFICIAL_PLUGINS) {
    program.command(spec.command).description(`${spec.description}（官方插件：安装后可用）`);
  }

  try {
    await program.parseAsync(span.args, { from: "user" });
    // 动作内设置的 process.exitCode（如 agent describe 未找到命令）优先于默认 0
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      return err.exitCode ?? 1;
    }
    ctx.log.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`[v-cli] 未捕获异常: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  },
);