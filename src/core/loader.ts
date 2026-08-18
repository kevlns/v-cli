import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateLocalCommand, type CliCommand } from "./command";
import type { CliContext } from "./context";
import { builtinCommands } from "../commands";

/** 已加载命令记录：source 区分内置/本地，error 记录单个插件加载失败原因 */
export interface LoadedCommand {
  command?: CliCommand;
  source: "builtin" | "local";
  file?: string;
  error?: string;
}

export async function loadBuiltinCommands(): Promise<LoadedCommand[]> {
  return builtinCommands.map((command) => ({ command, source: "builtin" as const }));
}

/**
 * 扫描 <home>/commands/*.mjs，动态 import；单个失败只记录不中断。
 * 每插件独立通过 validateLocalCommand（apiVersion 1 + 保留名 + 重复名），
 * 失败项进入 error 列表，其余插件不受影响。
 */
export async function loadLocalPlugins(ctx: CliContext): Promise<LoadedCommand[]> {
  const dir = path.join(ctx.homeDir, "commands");
  const loaded: LoadedCommand[] = [];
  if (!fs.existsSync(dir)) return loaded;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort();
  for (const file of files) {
    const abs = path.join(dir, file);
    try {
      // @vite-ignore：外部文件运行时导入，阻止 vite 拦截（vitest 用 forks 池，见 vitest.config.ts）
      const mod = await import(/* @vite-ignore */ pathToFileURL(abs).href);
      const candidate = mod.default ?? mod;
      // 完整契约校验（apiVersion 1 + 形状 + 保留名/重复名 + agent 元数据），
      // 失败项带解释性错误进入 error 列表；旧版插件在此得到 apiVersion 指引。
      const acceptedNames = loaded
        .map((l) => l.command?.name)
        .filter((n): n is string => typeof n === "string");
      const validation = validateLocalCommand(candidate, { existingNames: acceptedNames });
      if (!validation.ok || !validation.command) {
        loaded.push({ source: "local", file: abs, error: validation.errors.join("；") });
        continue;
      }
      loaded.push({ command: validation.command, source: "local", file: abs });
    } catch (err) {
      loaded.push({
        source: "local",
        file: abs,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return loaded;
}

/** 合并内置 + 本地插件 */
export async function loadAllCommands(ctx: CliContext): Promise<LoadedCommand[]> {
  return [...(await loadBuiltinCommands()), ...(await loadLocalPlugins(ctx))];
}