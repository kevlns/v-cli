import { discoverToolSkills, readRuntimeSkill, exportToolSkill } from "../core/skills";
import type { Command } from "commander";
import type { CliCommand } from "../core/command";
import type { CliContext } from "../core/context";
import { builtinCommands } from "./index";
import { loadLocalPlugins, type LoadedCommand } from "../core/loader";
import { discoverAllOfficialPlugins, type OfficialPluginInfo } from "../core/official";
import { VERSION } from "../version";

/** agent index 行：统一 builtin/local/official 三类命令的索引记录 */
export interface AgentRowCommandMeta {
  path: string[];
  description: string;
  usage?: string;
  arguments?: { name: string; required: boolean; description: string }[];
  options?: { flags: string; description: string }[];
  output?: { format: string; description: string };
  exitCodes?: Record<string, string>;
  safety?: string[];
}

export interface AgentIndexRow {
  name: string;
  type: "builtin" | "local" | "official";
  description: string;
  metadataStatus: "full" | "minimal";
  package?: string;
  version?: string;
  status?: string;
  platform?: string;
  requiredPlatforms?: string[];
  error?: string;
  whenToUse?: string;
  globalOptions?: { flags: string; description: string }[];
  commands?: AgentRowCommandMeta[];
  runtime?: Record<string, unknown>;
  environment?: { name: string; description: string }[];
}

/** 纯函数：构建全量 agent 索引（测试友好，无 IO） */
export function buildAgentIndex(
  builtin: readonly CliCommand[],
  local: readonly LoadedCommand[],
  official: readonly OfficialPluginInfo[],
): AgentIndexRow[] {
  const rows: AgentIndexRow[] = [];

  for (const cmd of builtin) {
    rows.push({
      name: cmd.name,
      type: "builtin",
      description: cmd.description,
      metadataStatus: cmd.agent ? "full" : "minimal",
      whenToUse: cmd.agent?.whenToUse,
    globalOptions: cmd.agent?.globalOptions,
      commands: cmd.agent?.commands,
    });
  }

  for (const item of local) {
    const cmd = item.command;
    if (!cmd) {
      rows.push({
        name: item.file ? item.file.split(/[\\/]/).pop()?.replace(/\.mjs$/, "") ?? "(加载失败)" : "(加载失败)",
        type: "local",
        description: item.error ?? "加载失败",
        metadataStatus: "minimal",
        error: item.error,
      });
      continue;
    }
    rows.push({
      name: cmd.name,
      type: "local",
      description: cmd.description,
      metadataStatus: cmd.agent ? "full" : "minimal",
      whenToUse: cmd.agent?.whenToUse,
      globalOptions: cmd.agent?.globalOptions,
      commands: cmd.agent?.commands,
    });
  }

  for (const info of official) {
    rows.push({
      name: info.name,
      type: "official",
      description: info.description,
      metadataStatus: info.status === "available" ? "full" : "minimal",
      package: info.package,
      version: info.version,
      status: info.status,
      platform: info.platform,
      requiredPlatforms: info.requiredPlatforms,
      error: info.error,
      whenToUse: info.whenToUse,
      globalOptions: info.globalOptions,
      // 完整清单元数据全量透传（arguments/options/output/exitCodes/safety）
      commands: info.commands,
      runtime: info.runtime,
      environment: info.environment,
    });
  }

  return rows;
}

function rowToText(row: AgentIndexRow): string {
  const status = row.status ? ` [${row.status}]` : "";
  const meta = row.metadataStatus === "full" ? "完整元数据" : "最小元数据";
  return `[${row.type}] ${row.name}${status}: ${row.description} (${meta})`;
}

function describeCommandLine(c: AgentRowCommandMeta): string {
  // 防御性渲染：路径缺失/为空时不崩溃（旧版遗留数据）
  const pathText = Array.isArray(c.path) ? c.path.join(" ") : "";
  const argText =
    Array.isArray(c.arguments) && c.arguments.length > 0
      ? ` 参数: ${c.arguments.map((a) => `${a.required ? `<${a.name}>` : `[${a.name}]`}`).join(", ")}`
      : "";
  const optText =
    Array.isArray(c.options) && c.options.length > 0
      ? ` 选项: ${c.options.map((o) => o.flags).join(", ")}`
      : "";
  const outputText =
    c.output && typeof c.output === "object" && typeof c.output.format === "string"
      ? ` 输出: ${c.output.format}${c.output.description ? `（${c.output.description}）` : ""}`
      : "";
  const exitText =
    c.exitCodes && typeof c.exitCodes === "object" && Object.keys(c.exitCodes).length > 0
      ? ` 退出码: ${Object.entries(c.exitCodes).map(([code, desc]) => `${code}=${desc}`).join(", ")}`
      : "";
  const safeText =
    Array.isArray(c.safety) && c.safety.length > 0 ? ` 安全: ${c.safety.join("；")}` : "";
  return `  ${pathText} — ${c.description}${c.usage ? ` (用法: ${c.usage})` : ""}${argText}${optText}${outputText}${exitText}${safeText}`;
}

const AGENT_HELP_TEXT = "运行规范：agent docs [工具]；受管技能：agent skills --json。外部宿主只能通过 agent export --host --directory 显式导出。";
const DOCS_HELP_TEXT = "输出清单声明的 SKILL.md 原文；--json 包含 sha256/content。示例：v-cli agent docs xlmerge --json。AGENTS.md 只面向工具仓库开发。";

/** agent：命令索引 / 单命令详情 / 内置引导文档 / 工作区初始化 */
export const agent: CliCommand = {
  name: "agent",
  description: "发现命令与运行技能，显式导出宿主适配",
  apiVersion: 1,

  agent: {
    whenToUse: "发现命令用 index/describe；运行规范用 docs；外部适配使用显式 export。",
    globalOptions: [
      { flags: "-h, --help", description: "显示命令帮助" },
    ],
    commands: [
      {
        path: ["index"],
        usage: "v-cli agent index [--json]",
        description: "列出全部命令（builtin/local/official）与 agent 元数据",
        arguments: [],
        options: [{ flags: "--json", description: "输出机器可读 JSON" }],
        output: {
          format: "stdout",
          description: "正文输出到 stdout；--json 时输出稳定 JSON 数组（name/type/description/metadataStatus/commands/…）",
        },
        exitCodes: { "0": "成功" },
        safety: ["read-only", "no-network"],
      },
      {
        path: ["describe"],
        usage: "v-cli agent describe <name> [--json]",
        description: "查看单个命令的完整记录",
        arguments: [{ name: "name", required: true, description: "命令名（builtin/local/official）" }],
        options: [{ flags: "--json", description: "输出机器可读 JSON" }],
        output: { format: "stdout", description: "正文输出到 stdout；--json 时输出单条稳定 JSON 对象" },
        exitCodes: { "0": "成功", "1": "未找到命令（stderr 说明）" },
        safety: ["read-only"],
      },
      {
        path: ["docs"],
        usage: "v-cli agent docs [command] [--json]",
        description: "读取工具声明的运行技能入口",
        arguments: [{ name: "command", required: false, description: "官方插件命令名（如 unity、xlmerge）" }],
        options: [{ flags: "--json", description: "输出 { package, version, sha256, content }" }],
        output: {
          format: "stdout",
          description: "SKILL.md 原文逐字节输出到 stdout；--json 时输出含 sha256/content 的稳定 JSON",
        },
        exitCodes: { "0": "成功", "1": "命令未知 / 插件未安装 / SKILL.md 缺失或不可读" },
        safety: ["read-only", "no-network"],
      },
      {
        path: ["skills"], usage: "v-cli agent skills [--json]", description: "列出受管工具声明的技能",
        arguments: [], options: [{flags:"--json",description:"JSON 输出"}],
        output:{format:"json",description:"技能来源与诊断"},exitCodes:{"0":"成功"},safety:["read-only","no-network"],
      },
      {
        path: ["export"], usage: "v-cli agent export [command] --host <codex|claude> --directory <path> [--dry-run] [--json]",
        description: "向指定目录导出运行技能和显式宿主适配",
        arguments: [{name:"command",required:false,description:"工具名，默认 v-cli"}],
        options:[{flags:"--host <name>",description:"显式宿主"},{flags:"--directory <path>",description:"已有技能根目录"},{flags:"--dry-run",description:"只预览"},{flags:"--json",description:"JSON 输出"}],
        output:{format:"json",description:"导出文件与目标"},exitCodes:{"0":"成功","1":"非法目标或来源"},safety:["explicit-target","no-network"],
      },
    ],
  },

  register(program: Command, ctx: CliContext) {
    program
      .command("index")
      .description("列出全部命令（builtin/local/official）与 agent 元数据")
      .option("--json", "输出机器可读 JSON")
      .action(async (opts: { json?: boolean }) => {
        const json = ctx.json || opts.json;
        const rows = buildAgentIndex(
          builtinCommands,
          await loadLocalPlugins(ctx),
          discoverAllOfficialPlugins(),
        );
        ctx.log.result(json ? rows : rows.map(rowToText).join("\n"));
      });

    program
      .command("describe")
      .description("查看单个命令的完整记录（builtin/local/official）")
      .argument("<name>", "命令名")
      .option("--json", "输出机器可读 JSON")
      .action(async (name: string, opts: { json?: boolean }) => {
        const json = ctx.json || opts.json;
        const row = buildAgentIndex(
          builtinCommands,
          await loadLocalPlugins(ctx),
          discoverAllOfficialPlugins(),
        ).find((r) => r.name === name);
        if (!row) {
          ctx.log.error(`未找到命令: ${name}`);
          process.exitCode = 1;
          return;
        }
        if (json) {
          ctx.log.result(row);
          return;
        }
        const lines = [
          `命令: ${row.name} (${row.type})`,
          `描述: ${row.description}`,
          `元数据: ${row.metadataStatus}`,
        ];
        if (row.status) lines.push(`状态: ${row.status}${row.error ? `（${row.error}）` : ""}`);
        if (row.package) lines.push(`包: ${row.package}${row.version ? `@${row.version}` : ""}`);
        if (row.requiredPlatforms) lines.push(`支持平台: ${row.requiredPlatforms.join(", ")}`);
        if (row.whenToUse) lines.push(`何时使用: ${row.whenToUse}`);
        if (row.globalOptions && row.globalOptions.length > 0) {
          lines.push("全局选项:");
          for (const o of row.globalOptions) lines.push(`  ${o.flags} — ${o.description}`);
        }
        if (row.commands && row.commands.length > 0) {
          lines.push("子命令:");
          for (const c of row.commands) lines.push(describeCommandLine(c));
        }
        ctx.log.result(lines.join("\n"));
      });

    program
      .command("docs")
      .description("读取工具声明的运行技能入口")
      .argument("[command]", "官方插件命令名（如 unity、xlmerge）")
      .option("--json", "输出机器可读 JSON（含 sha256/content）")
      .addHelpText("after", DOCS_HELP_TEXT)
      .action((command: string | undefined, opts: { json?: boolean }) => {
        const json = ctx.json || opts.json;
        let docs: ReturnType<typeof readRuntimeSkill>;
        let packageName = "@kevlns/v-cli";
        let version = VERSION;
        try {
          if (command) {
            const pluginDocs = readRuntimeSkill(command);
            docs = pluginDocs;
            packageName = pluginDocs.package;
            version = pluginDocs.version;
          } else {
            docs = readRuntimeSkill();
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (json) ctx.log.result({ ok: false, error: message });
          ctx.log.error(message);
          process.exitCode = 1;
          return;
        }
        if (json) {
          ctx.log.result({
            package: packageName,
            version,
            sha256: docs.sha256,
            content: docs.content,
          });
          return;
        }
        // 原样输出技能入口。
        process.stdout.write(docs.content);
      });

    program.command("skills").description("列出受管工具声明的技能")
      .option("--json", "JSON 输出").action(()=>ctx.log.result(discoverToolSkills()));
    program.command("export").description("显式导出外部宿主技能")
      .argument("[command]").requiredOption("--host <name>").requiredOption("--directory <path>")
      .option("--dry-run").option("--json")
      .action((command: string | undefined, opts: {host:string;directory:string;dryRun?:boolean}) =>
        ctx.log.result(exportToolSkill(command, opts)));
    program.command("init").description("已迁移：使用 project init")
      .argument("[directory]").option("--json").option("--dry-run").option("--force")
      .action(()=>{throw new Error("agent init 已迁移；项目使用 v-cli project init，外部宿主使用 agent export --host --directory。");});

    program.addHelpText("after", AGENT_HELP_TEXT);
  },
};