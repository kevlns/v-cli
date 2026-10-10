import type { Command } from "commander";
import type { CliCommand } from "../core/command";
import type { CliContext } from "../core/context";
import {
  initProjectConfig,
  inspectProject,
  PROJECT_CLI_CONFIG_RELATIVE,
  VANT_PROJECT_CONFIG_RELATIVE,
  type UnityTestMode,
} from "../core/project/config";
import { PathSafetyError, resolveProjectRoot } from "../core/project/paths";
import { createDefaultRegistry } from "../core/execution/default-registry";

const PROJECT_HELP_TEXT = [
  "project：工程根绑定与只读检查。",
  "",
  `  init     写入 ${PROJECT_CLI_CONFIG_RELATIVE}（仅 CLI 能力/适配器绑定；已存在一律拒绝，绝不覆盖）`,
  "  inspect  只读检查：配置文件与绑定目录、.vant 布局、provider 发现状态（不执行任何工具）",
  "",
  "职责分离：角色/workflow/项目组织属于 Vant 的 .vant/config/project.json；",
  "本命令既不读也不写该文件，v-cli.json 中出现这类字段会被明确拒绝。",
  "",
  "示例：",
  "  v-cli project init --project . --unity-project Client --json",
  "  v-cli project inspect --project . --json",
].join("\n");

function formatError(err: unknown): string {
  if (err instanceof PathSafetyError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/** project：工程根显式锚定、配置初始化与只读检查 */
export const project: CliCommand = {
  name: "project",
  description: "project：init 初始化 .vant/config/v-cli.json（不覆盖），inspect 只读检查绑定与后状态",
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
        usage:
          "v-cli project init [--project <dir>] [--unity-project <dir>] [--editor-version <v>] [--test-mode <mode>] [--json]",
        description: `写入 ${PROJECT_CLI_CONFIG_RELATIVE}（默认 bindings.unity.projectDir；已存在拒绝，不触碰 Vant 配置）`,
        arguments: [],
        options: [
          { flags: "--project <dir>", description: "工程根（默认当前目录）" },
          { flags: "--unity-project <dir>", description: "bindings.unity.projectDir（工程根内相对路径，默认为 Client）" },
          { flags: "--editor-version <v>", description: "可选：钉扎 Editor 版本（doctor 不一致即前置条件不满足）" },
          { flags: "--test-mode <mode>", description: "可选：test-start 默认模式（EditMode | PlayMode）" },
          { flags: "--json", description: "输出机器可读 JSON" },
        ],
        output: { format: "json", description: "ok/action/file/bytes/sha256/warnings/vantConfig（只读提示）" },
        exitCodes: { "0": "创建成功", "1": "已存在被拒绝 / 目录或路径非法" },
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
        description: "只读检查工程配置、绑定目录、.vant 布局与 provider 发现状态（不执行工具）",
        arguments: [],
        options: [
          { flags: "--project <dir>", description: "工程根（默认当前目录）" },
          { flags: "--json", description: "输出机器可读 JSON" },
        ],
        output: { format: "json", description: "projectRoot/config/vant/state/providers" },
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
      .option("--unity-project <dir>", "bindings.unity.projectDir（工程根内相对路径，默认 Client）")
      .option("--editor-version <v>", "可选：钉扎 Editor 版本")
      .option("--test-mode <mode>", '可选：test-start 默认模式（"EditMode" | "PlayMode"）')
      .option("--json", "输出机器可读 JSON")
      .addHelpText("after", PROJECT_HELP_TEXT)
      .action(
        (opts: {
          project?: string;
          unityProject?: string;
          editorVersion?: string;
          testMode?: string;
          json?: boolean;
        }) => {
          const json = ctx.json || opts.json;
          const testMode = opts.testMode as UnityTestMode | undefined;
          if (testMode !== undefined && testMode !== "EditMode" && testMode !== "PlayMode") {
            const message = `--test-mode 必须是 "EditMode" 或 "PlayMode"（收到 ${JSON.stringify(opts.testMode)}）`;
            if (json) ctx.log.result({ ok: false, action: "refused", reason: message });
            ctx.log.error(message);
            process.exitCode = 1;
            return;
          }
          try {
            const root = resolveProjectRoot(opts.project);
            const result = initProjectConfig(root, {
              unityProjectDir: opts.unityProject,
              editorVersion: opts.editorVersion,
              testMode,
            });
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
        },
      );

    program
      .command("inspect")
      .description("只读检查工程配置、绑定目录、.vant 布局与 provider 发现状态（不执行工具）")
      .option("--project <dir>", "工程根（默认当前目录）")
      .option("--json", "输出机器可读 JSON")
      .addHelpText("after", PROJECT_HELP_TEXT)
      .action(async (opts: { project?: string; json?: boolean }) => {
        const json = ctx.json || opts.json;
        let inspection;
        try {
          inspection = inspectProject(resolveProjectRoot(opts.project));
        } catch (err) {
          const message = formatError(err);
          if (json) ctx.log.result({ ok: false, error: { code: "project-root-invalid", message } });
          ctx.log.error(message);
          process.exitCode = 1;
          return;
        }
        const registry = createDefaultRegistry();
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
          ...Object.entries(report.config.bindingDirs).map(([name, dir]) => `绑定 ${name}: ${dir}`),
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
