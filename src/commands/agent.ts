import path from "node:path";
import type { Command } from "commander";
import type { CliCommand } from "../core/command";
import type { CliContext } from "../core/context";
import { builtinCommands } from "./index";
import { loadLocalPlugins } from "../core/loader";
import { discoverAllOfficialPlugins, type OfficialPluginInfo } from "../core/official";
import type { LoadedCommand } from "../core/loader";
import {
  BUNDLED_DOCS_PACKAGE,
  performAgentInit,
  readBundledAgentsMd,
  type BundledDocs,
} from "../core/agent-docs";
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

const AGENT_HELP_TEXT = [
  "agent 子命令一览：",
  "  index    列出全部命令（builtin/local/official）与 agent 元数据；--json 输出稳定 JSON 数组",
  "  describe 查看单个命令的完整记录（用法/参数/选项/输出/退出码/安全标签）；--json 输出单条记录",
  "  docs     输出当前 @kevlns/v-cli 包内置 AGENTS.md 原文；--json 输出 { package, version, sha256, content }",
  "  init     把内置 AGENTS.md 写入工作区（默认当前目录）；已存在默认拒绝，--force 覆盖，--dry-run 预览",
  "",
  "JSON：所有子命令支持 --json（或前置全局 --json，如 v-cli --json agent index）",
  "",
  "AI Agent 快速开始（推荐顺序）：",
  "  1. v-cli agent docs",
  "  2. v-cli agent index --json",
  "  3. v-cli agent describe <name> --json",
  "  4. v-cli agent init .          （可选：写入工作区 AGENTS.md，AI Agent 自动读取）",
  "",
  "示例：",
  "  v-cli agent index --json            # 全量命令索引",
  "  v-cli agent describe ts --json      # 单命令详情",
  "  v-cli agent docs                    # 内置引导文档原文",
  "  v-cli agent init . --dry-run        # 预览初始化目标",
].join("\n");

const DOCS_HELP_TEXT = [
  "输出当前安装的 @kevlns/v-cli 包内置 AGENTS.md 原文（AI Agent 引导文档），逐字节原样输出、不追加换行。",
  "",
  "JSON 行为（--json 或前置全局 --json）：",
  "  成功：stdout 输出稳定对象 { package, version, sha256, content }",
  "    package  包名 @kevlns/v-cli",
  "    version  当前包版本",
  "    sha256   content 的 SHA-256（hex），可校验引导文档未被篡改",
  "    content  AGENTS.md 原文",
  "  失败：stdout 输出稀疏对象 { ok: false, error }，stderr 再输出同一 error，退出码 1",
  "",
  "退出码：0 成功；1 内置 AGENTS.md 缺失/不可读",
  "",
  "示例：",
  "  v-cli agent docs",
  "  v-cli agent docs --json",
].join("\n");

const INIT_HELP_TEXT = [
  "把当前 @kevlns/v-cli 包内置 AGENTS.md 原样写入 <目录>/AGENTS.md，AI Agent 会自动读取工作区文档。",
  "",
  "参数：",
  "  [directory]  目标目录，默认当前工作目录；必须已存在且为目录",
  "",
  "默认行为（无 --force）：目标已存在 AGENTS.md 时拒绝并退出 1，绝不改动现有文件。",
  "  --force    覆盖已存在的 AGENTS.md（原子写入：同目录临时文件 + rename）",
  "  --dry-run  只报告目标与将执行的动作，不写入任何文件",
  "  --json     成功/干跑输出稳定 JSON { ok, dryRun, action, directory, target, package, version, sha256, bytes }；",
  "             拒绝（如已存在未加 --force）输出 { ok: false, action: \"refused\", reason, … } 且退出 1；",
  "             内置文档缺失时输出稀疏 { ok: false, error } 且退出 1",
  "  符号链接规则：目标 AGENTS.md 是符号链接一律拒绝（fail-closed：不跟随、不覆盖链接目标）；",
  "             显式传入的目录本身是符号链接/联接目录（junction）也拒绝；省略目录参数（默认当前工作目录）不受此限制",
  "",
  "退出码：0 成功或干跑；1 目录无效 / 已存在未加 --force / 符号链接或联接目标 / 内置文档缺失 / 写入失败",
  "",
  "示例：",
  "  v-cli agent init",
  "  v-cli agent init ./myproj",
  "  v-cli agent init --dry-run",
  "  v-cli agent init --force",
  "  v-cli agent init --json",
].join("\n");

/** agent：命令索引 / 单命令详情 / 内置引导文档 / 工作区初始化 */
export const agent: CliCommand = {
  name: "agent",
  description: "agent：index 命令索引，describe 详情，docs 内置 AGENTS.md，init 工作区引导",
  apiVersion: 1,

  agent: {
    whenToUse:
      "当用户需要 AGENTS 引导文档、命令发现或为 AI Agent 初始化工作区时：先 `docs` 读内置 AGENTS.md，" +
      "再 `index --json` 枚举全部命令与元数据，用 `describe <name> --json` 看单命令详情，最后可 `init` 把 AGENTS.md 写入工作区",
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
        usage: "v-cli agent docs [--json]",
        description: "输出当前 @kevlns/v-cli 包内置 AGENTS.md 原文",
        arguments: [],
        options: [{ flags: "--json", description: "输出 { package, version, sha256, content }" }],
        output: {
          format: "stdout",
          description: "AGENTS.md 原文逐字节输出到 stdout；--json 时输出含 sha256/content 的稳定 JSON",
        },
        exitCodes: { "0": "成功", "1": "内置 AGENTS.md 缺失/不可读" },
        safety: ["read-only", "no-network"],
      },
      {
        path: ["init"],
        usage: "v-cli agent init [directory] [--force] [--dry-run] [--json]",
        description: "把内置 AGENTS.md 写入 <目录>/AGENTS.md；默认当前目录；已存在默认拒绝",
        arguments: [
          { name: "directory", required: false, description: "目标目录（默认当前工作目录；须已存在且为目录）" },
        ],
        options: [
          { flags: "--force", description: "覆盖已存在 AGENTS.md（原子写入）" },
          { flags: "--dry-run", description: "只报告目标与动作，不写入" },
          { flags: "--json", description: "输出机器可读结果" },
        ],
        output: {
          format: "stdout",
          description: "结果文本输出到 stdout；--json 时输出稳定 JSON（ok/dryRun/action/directory/target/package/version/sha256/bytes）",
        },
        exitCodes: {
          "0": "成功或干跑",
          "1": "目录无效 / 已存在未覆盖 / 符号链接或联接目标 / 文档缺失 / 写入失败",
        },
        safety: [
          "writes-target-atomic",
          "refuses-existing",
          "fail-closed-symlink",
          "dry-run-supported",
          "no-commit",
        ],
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
      .description("输出当前 @kevlns/v-cli 包内置 AGENTS.md 原文（AI Agent 引导文档）")
      .option("--json", "输出机器可读 JSON（含 sha256/content）")
      .addHelpText("after", DOCS_HELP_TEXT)
      .action((opts: { json?: boolean }) => {
        const json = ctx.json || opts.json;
        let docs: BundledDocs;
        try {
          docs = readBundledAgentsMd();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (json) ctx.log.result({ ok: false, error: message });
          ctx.log.error(message);
          process.exitCode = 1;
          return;
        }
        if (json) {
          ctx.log.result({
            package: BUNDLED_DOCS_PACKAGE,
            version: VERSION,
            sha256: docs.sha256,
            content: docs.content,
          });
          return;
        }
        // 文本模式：逐字节原样输出（AGENTS.md 以换行结尾，不再追加）
        process.stdout.write(docs.content);
      });

    program
      .command("init")
      .description("初始化 <目录>/AGENTS.md（默认当前目录）；已存在默认拒绝，--force 覆盖，--dry-run 预览")
      .argument("[directory]", "目标目录（默认当前工作目录；必须已存在且为目录）")
      .option("--force", "覆盖已存在的 AGENTS.md（原子写入）")
      .option("--dry-run", "只报告目标与动作，不写入任何文件")
      .option("--json", "输出机器可读结果")
      .addHelpText("after", INIT_HELP_TEXT)
      .action(
        (directory: string | undefined, opts: { force?: boolean; dryRun?: boolean; json?: boolean }) => {
          const json = ctx.json || opts.json;
          let docs: BundledDocs;
          try {
            docs = readBundledAgentsMd();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (json) ctx.log.result({ ok: false, error: message });
            ctx.log.error(message);
            process.exitCode = 1;
            return;
          }
          const result = performAgentInit({
            directory: path.resolve(directory ?? process.cwd()),
            docs,
            force: opts.force,
            dryRun: opts.dryRun,
            // 显式传入目录才做目录符号链接/联接 fail-closed；默认 cwd 不受限
            explicitDirectory: directory !== undefined,
          });
          if (json) {
            ctx.log.result(result);
            if (!result.ok && result.reason) ctx.log.error(result.reason);
            if (!result.ok) process.exitCode = 1;
            return;
          }
          if (!result.ok) {
            if (result.reason) ctx.log.error(result.reason);
            process.exitCode = 1;
            return;
          }
          if (result.dryRun) {
            ctx.log.result(
              `[dry-run] 将${result.action === "overwrite" ? "覆盖" : "写入"} ${result.target}（${result.bytes} 字节）`,
            );
          } else {
            ctx.log.result(
              `已${result.action === "overwritten" ? "覆盖" : "写入"} ${result.target}（${result.bytes} 字节，SHA-256 ${result.sha256.slice(0, 12)}…）`,
            );
          }
        },
      );

    program.addHelpText("after", AGENT_HELP_TEXT);
  },
};