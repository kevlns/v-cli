import { Command, CommanderError } from "commander";
import { createContext, defaultHomeDir } from "./core/context";
import { loadAllCommands } from "./core/loader";
import { VERSION } from "./version";

async function main(): Promise<number> {
  const rawArgs = process.argv.slice(2);
  const json = rawArgs.includes("--json");
  // 剥离 --json，避免子命令把它当成未知选项（支持任意位置书写）
  const args = rawArgs.filter((a) => a !== "--json");
  const ctx = createContext(defaultHomeDir(), json);

  const program = new Command();
  program
    .name("vcli")
    .description("kevlns 的个人工具箱")
    .version(VERSION)
    .option("--json", "输出机器可读 JSON")
    .showHelpAfterError();

  const loaded = await loadAllCommands(ctx);
  for (const item of loaded) {
    if (!item.command) {
      ctx.log.warn(`${item.file ?? "?"} 加载失败: ${item.error ?? "未知错误"}`);
      continue;
    }
    const cmd = item.command;
    if (cmd.hidden) continue;
    const sub = program.command(cmd.name).description(cmd.description);
    cmd.register(sub, ctx);
  }

  try {
    await program.parseAsync(args, { from: "user" });
    return 0;
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
    process.stderr.write(`[vcli] 未捕获异常: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  },
);