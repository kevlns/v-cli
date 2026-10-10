import type { Command } from "commander";
import type { CliCommand } from "../core/command";
import type { CliContext } from "../core/context";
import {
  initProjectConfig,
  inspectProject,
  PROJECT_CLI_CONFIG_RELATIVE,
  toProviderSet,
  VANT_PROJECT_CONFIG_RELATIVE,
} from "../core/project/config";
import { PathSafetyError, resolveProjectRoot } from "../core/project/paths";
import { createDefaultRegistry } from "../default-registry";

const PROJECT_HELP_TEXT = [
  "project：工程根绑定与只读检查。",
  "",
  `  init     写入 ${PROJECT_CLI_CONFIG_RELATIVE}（通用外壳：schemaVersion + 按 Provider 分组的 bindings；已存在一律拒绝，绝不覆盖）`,
  "  inspect  只读检查：配置文件与绑定目录、.vant 布局、按注册集合的 provider 绑定状态（不执行任何工具）",
  "",
  "职责分离：角色/workflow/项目组织属于 Vant 的 .vant/config/project.json；",
  "本命令既不读也不写该文件，v-cli.json 中出现这类字段会被明确拒绝。",
  "绑定段由各 Provider 自包含声明（capability describe / project inspect 可见契约）。",
  "",
  "示例：",
  "  v-cli project init --project . --json",
  "  v-cli project init --project . --binding unity='{\"projectDir\":\"Client\",\"editorVersion\":\"2022.3.59f1c1\"}' --json",
  "  v-cli project inspect --project . --json",
].join("\n");

function formatError(err: unknown): string {
  if (err instanceof PathSafetyError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/** 解析 --binding <providerId>=<JSON>（可重复）：JSON 必须是对象 */
export function parseBindingOptions(pairs: string[]): Record<string, Record<string, unknown>> {
  const overrides: Record<string, Record<string, unknown>> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new Error(`--binding 需要 <providerId>=<JSON对象> 形式（收到 ${JSON.stringify(pair)}）`);
    }
    const providerId = pair.slice(0, eq);
    if (!/^[a-z][a-z0-9-]*$/.test(providerId)) {
      throw new Error(`--binding 的 providerId 非法: ${JSON.stringify(providerId)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(pair.slice(eq + 1));
    } catch (err) {
      throw new Error(
        `--binding ${providerId} 的值不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`--binding ${providerId} 的值必须是 JSON 对象`);
    }
    if (overrides[providerId] !== undefined) {
      throw new Error(`--binding ${providerId} 重复提供（后值会覆盖前值，请只给一次完整段）`);
    }
    overrides[providerId] = parsed as Record<string, unknown>;
  }
  return overrides;
}

/** project：工程根显式锚定、配置初始化与只读检查 */
export const project: CliCommand = {
  name: "project",
  description: "project：init 初始化 .vant/config/v-cli.json（不覆盖），inspect 只读检查绑定与 provider 状态",
  apiVersion: 1,

  agent: {
    whenToUse:
      "当工程尚未初始化 v-cli 工程配置（.vant/config/v-cli.json）或需要确认绑定是否就绪时使用：" +
      "`project inspect --json` 只读检查，`project init --project <工程根>` 写入默认绑定（已存在拒绝覆盖）；" +
      "capability run 报 project-config-missing 时按提示初始化",
    globalOptions: [{ flags: "-h, --help", description: "显示命令帮助" }],
    commands: [
      {
        path: ["init"],
        usage: "v-cli project init [--project <dir>] [--binding <providerId>=<JSON>]... [--json]",
        description: `写入 ${PROJECT_CLI_CONFIG_RELATIVE}（为有默认绑定的 Provider 生成段，--binding 完整覆盖；已存在拒绝，不触碰 Vant 配置）`,
        arguments: [],
        options: [
          { flags: "--project <dir>", description: "工程根（默认当前目录）" },
          {
            flags: "--binding <providerId>=<JSON>",
            description:
              "覆盖某 Provider 的绑定段（可重复；JSON 对象，完整替换该 Provider 的默认段；各字段契约见 capability describe / Provider 文档）",
          },
          { flags: "--json", description: "输出机器可读 JSON" },
        ],
        output: { format: "json", description: "ok/action/file/bytes/sha256/bindings/warnings/vantConfig（只读提示）" },
        exitCodes: { "0": "创建成功", "1": "已存在被拒绝 / 目录、路径或 --binding 非法" },
        safety: [
          "refuses-existing",
          "fail-closed-symlink",
          "never-writes-vant-config",
          "writes-config-atomic",
        ],
      },
      {
        path: ["inspect"],
        usage: "v-cli project inspect [--project <dir>] [--json]",
        description: "只读检查工程配置、按注册集合的绑定状态、.vant 布局与 provider 发现状态（不执行工具）",
        arguments: [],
        options: [
          { flags: "--project <dir>", description: "工程根（默认当前目录）" },
          { flags: "--json", description: "输出机器可读 JSON" },
        ],
        output: { format: "json", description: "projectRoot/config（含 providerBindings）/vant/state/providers" },
        exitCodes: { "0": "检查完成（配置缺失/非法也退出 0，问题在数据里）", "1": "工程根不存在" },
        safety: ["read-only", "no-tool-execution"],
      },
    ],
  },

  register(program: Command, ctx: CliContext) {
    program
      .command("init")
      .description(`写入 ${PROJECT_CLI_CONFIG_RELATIVE}（已存在一律拒绝；不触碰 Vant 配置）`)
      .option("--project <dir>", "工程根（默认当前目录）")
      .option(
        "--binding <providerId>=<JSON>",
        "覆盖某 Provider 的绑定段（可重复；JSON 对象完整替换默认段）",
        (value: string, previous: string[] = []) => [...previous, value],
        [] as string[],
      )
      .option("--json", "输出机器可读 JSON")
      .addHelpText("after", PROJECT_HELP_TEXT)
      .action((opts: { project?: string; binding: string[]; json?: boolean }) => {
        const json = ctx.json || opts.json;
        const registry = createDefaultRegistry();
        try {
          const overrides = parseBindingOptions(opts.binding ?? []);
          const root = resolveProjectRoot(opts.project);
          const result = initProjectConfig(root, toProviderSet(registry.listProviders()), overrides);
          if (json) {
            ctx.log.result(result);
            if (!result.ok) {
              ctx.log.error(result.reason);
              process.exitCode = 1;
            }
            return;
          }
          if (!result.ok) {
            ctx.log.error(result.reason);
            process.exitCode = 1;
            return;
          }
          const lines = [
            `已写入 ${result.file}（${result.bytes} 字节，SHA-256 ${result.sha256.slice(0, 12)}…）`,
            `工程根: ${result.projectRoot}`,
            ...Object.entries(result.bindings).map(([id, section]) => `绑定 ${id}: ${JSON.stringify(section)}`),
            result.vantConfig.exists
              ? `检测到 Vant 配置 ${VANT_PROJECT_CONFIG_RELATIVE}（只读提示，v-cli 未做任何修改）`
              : "未检测到 Vant 配置（.vant/config/project.json）；角色/workflow 归属 Vant，不在本文件",
          ];
          for (const warning of result.warnings) lines.push(`警告: ${warning}`);
          ctx.log.result(lines.join("\n"));
        } catch (err) {
          const message = formatError(err);
          if (json) ctx.log.result({ ok: false, action: "refused", reason: message });
          ctx.log.error(message);
          process.exitCode = 1;
        }
      });

    program
      .command("inspect")
      .description("只读检查工程配置、绑定目录、.vant 布局与 provider 发现状态（不执行工具）")
      .option("--project <dir>", "工程根（默认当前目录）")
      .option("--json", "输出机器可读 JSON")
      .addHelpText("after", PROJECT_HELP_TEXT)
      .action(async (opts: { project?: string; json?: boolean }) => {
        const json = ctx.json || opts.json;
        const registry = createDefaultRegistry();
        let inspection;
        try {
          inspection = inspectProject(resolveProjectRoot(opts.project), toProviderSet(registry.listProviders()));
        } catch (err) {
          const message = formatError(err);
          if (json) ctx.log.result({ ok: false, error: { code: "project-root-invalid", message } });
          ctx.log.error(message);
          process.exitCode = 1;
          return;
        }
        const providers = [];
        for (const provider of registry.providers()) {
          const status = await registry.providerStatus(provider.id);
          providers.push({
            id: provider.id,
            version: provider.version,
            description: provider.description,
            state: status?.state ?? "unavailable",
            detail: status?.detail ?? "未知",
            tool: status?.tool ?? null,
            capabilityCount: registry.list().filter((r) => r.provider.id === provider.id).length,
          });
        }
        const report = { ...inspection, providers, capabilities: registry.list().length };
        if (json) {
          ctx.log.result(report);
          return;
        }
        const lines = [
          `工程根: ${report.projectRoot}`,
          `配置: ${report.config.relativeFile} ${report.config.exists ? (report.config.valid ? "[有效]" : `[无效: ${report.config.kind}]`) : "[缺失]"}`,
          ...report.config.errors.map((e) => `  - ${e}`),
          ...(report.config.hint ? [`  提示: ${report.config.hint}`] : []),
          "绑定状态（按注册集合）:",
          ...report.config.providerBindings.flatMap((b) => [
            `  [${b.providerId}] ${b.state === "bound" ? "已绑定" : b.state === "missing-binding" ? "缺绑定（运行期前置条件将失败）" : "无效"}`,
            ...Object.entries(b.dirs).map(([field, dir]) => `    ${field}: ${dir}`),
            ...Object.entries(b.files).map(([field, file]) => `    ${field}: ${file}`),
            ...b.warnings.map((w) => `    警告: ${w}`),
            ...b.errors.map((e) => `    - ${e}`),
          ]),
          `.vant: ${report.vant.exists ? "存在" : "不存在"}（config 文件: ${report.vant.configFiles.join(", ") || "无"}）`,
          `Vant 配置: ${report.vant.projectConfigExists ? `${VANT_PROJECT_CONFIG_RELATIVE}（只读；v-cli 不修改）` : "未检测到"}`,
          `操作记录目录: ${report.state.exists ? `${report.state.dir}（${report.state.operationCount} 条）` : `${report.state.dir}（未创建）`}`,
          "providers:",
          ...providers.map(
            (p) => `  [${p.id}@${p.version}] ${p.state}（${p.capabilityCount} 个 capability）— ${p.detail}`,
          ),
        ];
        ctx.log.result(lines.join("\n"));
      });
  },
};
