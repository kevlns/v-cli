import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import type { CliCommand } from "../core/command";
import type { CliContext } from "../core/context";
import { CapabilityError } from "../core/execution/errors";
import { createDefaultRegistry } from "../core/execution/default-registry";
import { exitCodeForResult, runCapability } from "../core/execution/runtime";
import type { CapabilityRunResult, CapabilitySummary } from "../core/execution/types";
import { PathSafetyError } from "../core/project/paths";

const CAPABILITY_HELP_TEXT = [
  "capability：结构化能力注册与执行（v-cli 是注册和执行基座）。",
  "",
  "  list      列出已注册 capability（provider 状态只做发现，不执行工具）",
  "  describe  查看单个 capability 的完整描述（id/版本/schema/前置条件/副作用/资源/重试）",
  "  run       执行 capability（真实输入/输出校验；落盘到 .vant/state/operations）",
  "",
  "run 的工程根用 --project 显式锚定（默认 cwd）；目标工程目录来自 .vant/config/v-cli.json",
  "的 bindings（capability 输入不接受 projectPath 覆盖）。没有配置时先运行：",
  "  v-cli project init --project <工程根>",
  "",
  "run 退出码（与 --json 结果对齐）：",
  "  0 执行成功且验收 passed",
  "  1 执行失败 或 验收 failed",
  "  2 未执行：入参/schema、工程配置、前置条件、资源授权不满足",
  "  3 已执行但验收 not-run（pending=true 时应轮询 followUp）",
  "  4 执行被取消且已确认（观察到子进程终止）",
  "  5 执行结果未知（输出不可解释/契约违约/取消失效）",
  "",
  "示例：",
  "  v-cli capability list --json",
  "  v-cli capability describe unity.test-status --json",
  "  v-cli capability run unity.doctor --project . --json",
  "  v-cli capability run unity.test-start --project . --set mode=EditMode --json",
  "  v-cli capability run unity.test-status --project . --operation-id poll-001 --json",
].join("\n");

function summarizeRow(row: CapabilitySummary): string {
  const pre = row.preconditions.length > 0 ? ` 前置条件: ${row.preconditions.join(", ")}` : "";
  const effects = row.sideEffectKinds.length > 0 ? ` 副作用: ${row.sideEffectKinds.join(", ")}` : " 副作用: 无";
  const retry = ` 重试: safe=${row.retry.safe} maxAttempts=${row.retry.maxAttempts} strategy=${row.retry.strategy}`;
  return `[${row.provider.id}] ${row.id}@${row.version} — ${row.description}${pre}${effects}${retry}`;
}

function describeLines(row: CapabilitySummary, full: Record<string, unknown>): string[] {
  const lines = [
    `capability: ${row.id}@${row.version}`,
    `provider: ${row.provider.id}@${row.provider.version} — ${row.provider.description}`,
    `描述: ${row.description}`,
  ];
  if (row.tags.length > 0) lines.push(`标签: ${row.tags.join(", ")}`);
  lines.push(`输入 schema: ${JSON.stringify(full.inputSchema)}`);
  lines.push(`输出 schema: ${JSON.stringify(full.outputSchema)}`);
  lines.push(
    row.preconditions.length > 0
      ? `前置条件: ${row.preconditions.join(", ")}`
      : "前置条件: 无",
  );
  const sideEffects = full.sideEffects as { id: string; kind: string; description: string; reversible: boolean }[];
  lines.push(
    sideEffects.length > 0
      ? `声明的副作用:\n${sideEffects.map((s) => `  - ${s.id} [${s.kind}] ${s.reversible ? "可逆" : "不可逆"} — ${s.description}`).join("\n")}`
      : "声明的副作用: 无",
  );
  const resources = full.resources as { kind: string; mode: string; scope: string; description: string }[];
  lines.push(
    resources.length > 0
      ? `资源需求（声明；授权由组织层注入，本阶段无资源锁）:\n${resources
          .map((r) => `  - ${r.kind} ${r.mode}/${r.scope} — ${r.description}`)
          .join("\n")}`
      : "资源需求: 无",
  );
  const retry = full.retry as { safe: boolean; maxAttempts: number; strategy: string; description: string };
  lines.push(`重试语义: safe=${retry.safe}, maxAttempts=${retry.maxAttempts}, strategy=${retry.strategy} — ${retry.description}`);
  if (typeof full.timeoutMs === "number") lines.push(`建议超时: ${full.timeoutMs} ms`);
  return lines;
}

function resultSummaryLines(result: CapabilityRunResult): string[] {
  const lines = [
    `operation: ${result.operationId}`,
    `capability: ${result.capability.id}@${result.capability.version} (provider ${result.provider.id})`,
    `project: ${result.project.root}`,
    `execution: ${result.execution.status} / lifecycle=${result.execution.lifecycle} / exit=${
      result.execution.exitCode ?? "null"
    }${result.execution.error ? ` / error=${result.execution.error.code}: ${result.execution.error.message}` : ""}`,
    `acceptance: ${result.acceptance.status}${result.acceptance.pending ? " (pending)" : ""} — ${result.acceptance.reason}`,
  ];
  if (result.output !== null && result.output !== undefined) {
    lines.push(`output: ${JSON.stringify(result.output)}`);
  }
  if (result.followUp.length > 0) {
    lines.push(`followUp: ${result.followUp.map((f) => `${f.capabilityId ?? "-"} → ${f.hint}`).join("; ")}`);
  }
  if (result.sideEffects.length > 0) {
    lines.push(`sideEffects: ${result.sideEffects.map((s) => s.kind).join(", ")}`);
  }
  lines.push(
    `persisted: ${result.persisted.status}${result.persisted.dir ? ` → ${result.persisted.dir}` : ""}${
      result.persisted.files.length > 0 ? ` [${result.persisted.files.join(", ")}]` : ""
    }${result.persisted.error ? ` (${result.persisted.error})` : ""}`,
  );
  for (const note of result.notes) lines.push(`note: ${note}`);
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  return lines;
}

function parseJsonArg(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CapabilityError({
      code: "input-json-invalid",
      category: "request",
      message: `${label} 不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`,
      retryable: false,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CapabilityError({
      code: "input-json-invalid",
      category: "request",
      message: `${label} 必须是 JSON 对象`,
      retryable: false,
    });
  }
  return parsed as Record<string, unknown>;
}

/** `--set a.b=value`：点号建嵌套；值按 JSON 字面量解析，失败按字符串 */
export function applySetPairs(
  target: Record<string, unknown>,
  pairs: string[],
): Record<string, unknown> {
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new CapabilityError({
        code: "set-pair-invalid",
        category: "request",
        message: `--set 需要 key=value 形式（收到 ${JSON.stringify(pair)}）`,
        retryable: false,
      });
    }
    const keyPath = pair.slice(0, eq).split(".");
    if (keyPath.some((key) => key.length === 0 || ["__proto__", "prototype", "constructor"].includes(key))) {
      throw new CapabilityError({ code: "set-path-invalid", category: "request", message: "--set 字段路径非法", retryable: false });
    }
    const rawValue = pair.slice(eq + 1);
    let value: unknown = rawValue;
    try {
      value = JSON.parse(rawValue);
    } catch {
      value = rawValue;
    }
    let cursor: Record<string, unknown> = target;
    for (let i = 0; i < keyPath.length - 1; i++) {
      const key = keyPath[i];
      const next = cursor[key];
      if (typeof next !== "object" || next === null || Array.isArray(next)) {
        cursor[key] = {};
      }
      cursor = cursor[key] as Record<string, unknown>;
    }
    cursor[keyPath[keyPath.length - 1]] = value;
  }
  return target;
}

/** capability：注册表只读浏览 + 结构化执行 */
export const capability: CliCommand = {
  name: "capability",
  description: "capability：list 列能力，describe 看契约，run 结构化执行（含真实输入/输出校验与落盘记录）",
  apiVersion: 1,

  agent: {
    whenToUse:
      "当需要以结构化方式执行工程能力（如 Unity 工程诊断/编译/测试）时：先 `capability list --json` 枚举，" +
      "再 `capability describe <id> --json` 读契约（schema/前置条件/副作用/资源/重试），" +
      "最后 `capability run <id> --project <工程根> [--input <json>] --json` 执行；" +
      "退出码 3 表示验收 not-run（异步启动/需轮询 followUp），不得当作通过",
    globalOptions: [{ flags: "-h, --help", description: "显示命令帮助" }],
    commands: [
      {
        path: ["list"],
        usage: "v-cli capability list [--provider <id>] [--json]",
        description: "列出已注册 capability（provider 状态为只读发现，不执行工具）",
        arguments: [],
        options: [
          { flags: "--provider <id>", description: "只列出某个 provider 的 capability" },
          { flags: "--json", description: "输出机器可读 JSON" },
        ],
        output: { format: "json", description: "{ providers, capabilities }：provider 发现状态 + capability 摘要数组" },
        exitCodes: { "0": "成功" },
        safety: ["read-only", "no-tool-execution"],
      },
      {
        path: ["describe"],
        usage: "v-cli capability describe <id> [--json]",
        description: "查看单个 capability 的完整契约描述",
        arguments: [{ name: "id", required: true, description: "capability id（如 unity.compile）" }],
        options: [{ flags: "--json", description: "输出机器可读 JSON" }],
        output: { format: "json", description: "descriptor（schema/前置条件/副作用/资源/重试）+ provider" },
        exitCodes: { "0": "成功", "1": "capability 未注册" },
        safety: ["read-only", "no-tool-execution"],
      },
      {
        path: ["run"],
        usage:
          "v-cli capability run <id> [--project <dir>] [--input <json> | --input-file <path>] [--set k=v]... [--operation-id <id>] [--task-id <id>] [--run-id <id>] [--no-persist] [--json]",
        description: "执行 capability：真实输入/输出校验、前置条件 fail-closed、结果与验收分离、落盘操作记录",
        arguments: [{ name: "id", required: true, description: "capability id" }],
        options: [
          { flags: "--project <dir>", description: "工程根（默认当前目录）" },
          { flags: "--input <json>", description: "输入 JSON 对象" },
          { flags: "--input-file <path>", description: "从文件读取输入 JSON" },
          { flags: "--set <k=v>", description: "设置单个输入字段（可重复；点号建嵌套；值按 JSON 字面量解析）" },
          { flags: "--operation-id <id>", description: "显式操作 id（已存在则拒绝，绝不覆盖）" },
          { flags: "--task-id <id>", description: "外部任务 id（组织层任务调度注入）" },
          { flags: "--run-id <id>", description: "外部运行 id" },
          { flags: "--no-persist", description: "不落盘（测试/SDK 探测模式；无本地证据记录）" },
          { flags: "--json", description: "输出完整机器契约 JSON" },
        ],
        output: {
          format: "json",
          description: "CapabilityRunResult：execution/acceptance/preconditions/resources/sideEffects/artifacts/logs/output/persisted",
        },
        exitCodes: {
          "0": "执行成功且验收 passed",
          "1": "执行失败 或 验收 failed",
          "2": "未执行（入参/配置/前置条件/资源授权）",
          "3": "执行成功但验收 not-run（异步/待轮询）",
          "4": "执行被取消且已确认",
          "5": "执行结果未知",
        },
        safety: [
          "writes-operation-record",
          "refuses-operation-overwrite",
          "fail-closed-path-safety",
          "no-shell-string",
          "acceptance-separated-from-exit-code",
        ],
      },
    ],
  },

  register(program: Command, ctx: CliContext) {
    program
      .command("list")
      .description("列出已注册 capability（provider 状态为只读发现，不执行工具）")
      .option("--provider <id>", "只列出某个 provider 的 capability")
      .option("--json", "输出机器可读 JSON")
      .action(async (opts: { provider?: string; json?: boolean }) => {
        const json = ctx.json || opts.json;
        const registry = createDefaultRegistry();
        const providers = registry.providers();
        const selected = opts.provider ? providers.filter((p) => p.id === opts.provider) : providers;
        if (opts.provider && selected.length === 0) {
          ctx.log.error(`未知 provider: ${opts.provider}（已知: ${providers.map((p) => p.id).join(", ")}）`);
          process.exitCode = 1;
          return;
        }
        const rows = registry.list().filter((row) => selected.some((p) => p.id === row.provider.id));
        const providerStates = [];
        for (const provider of selected) {
          const status = await registry.providerStatus(provider.id);
          providerStates.push({ id: provider.id, version: provider.version, ...(status ?? { state: "unavailable", detail: "未知" }) });
        }
        if (json) {
          ctx.log.result({ providers: providerStates, capabilities: rows });
          return;
        }
        ctx.log.result(
          [
            "providers:",
            ...providerStates.map((p) => `  [${p.id}@${p.version}] ${p.state} — ${p.detail}`),
            "capabilities:",
            ...rows.map((row) => `  ${summarizeRow(row)}`),
          ].join("\n"),
        );
      });

    program
      .command("describe")
      .description("查看单个 capability 的完整契约描述")
      .argument("<id>", "capability id")
      .option("--json", "输出机器可读 JSON")
      .action((id: string, opts: { json?: boolean }) => {
        const json = ctx.json || opts.json;
        const registry = createDefaultRegistry();
        const described = registry.describe(id);
        if (!described) {
          ctx.log.error(`未注册的 capability: ${id}（用 \`v-cli capability list\` 查看）`);
          process.exitCode = 1;
          return;
        }
        if (json) {
          ctx.log.result(described);
          return;
        }
        const row = registry.list().find((r) => r.id === id)!;
        ctx.log.result(describeLines(row, described as unknown as Record<string, unknown>).join("\n"));
      });

    program
      .command("run")
      .description("执行 capability（真实输入/输出校验；结果与验收分离；落盘 .vant/state/operations）")
      .argument("<id>", "capability id")
      .option("--project <dir>", "工程根（默认当前目录）")
      .option("--input <json>", "输入 JSON 对象")
      .option("--input-file <path>", "从文件读取输入 JSON")
      .option("--set <k=v>", "设置单个输入字段（可重复）", (value: string, previous: string[] = []) => [...previous, value], [] as string[])
      .option("--operation-id <id>", "显式操作 id（已存在则拒绝）")
      .option("--task-id <id>", "外部任务 id")
      .option("--run-id <id>", "外部运行 id")
      .option("--no-persist", "不落盘（测试/SDK 探测模式）")
      .option("--json", "输出完整机器契约 JSON")
      .addHelpText("after", CAPABILITY_HELP_TEXT)
      .action(
        async (
          id: string,
          opts: {
            project?: string;
            input?: string;
            inputFile?: string;
            set: string[];
            operationId?: string;
            taskId?: string;
            runId?: string;
            persist: boolean;
            json?: boolean;
          },
        ) => {
          const json = ctx.json || opts.json;
          try {
            let input: Record<string, unknown> = {};
            if (opts.inputFile) {
              const file = path.resolve(process.cwd(), opts.inputFile);
              let text: string;
              try {
                text = fs.readFileSync(file, "utf-8");
              } catch (err) {
                throw new CapabilityError({
                  code: "input-file-unreadable",
                  category: "request",
                  message: `无法读取 --input-file ${file}: ${err instanceof Error ? err.message : String(err)}`,
                  retryable: false,
                });
              }
              input = parseJsonArg(text, `--input-file ${file}`);
            }
            if (opts.input) {
              input = { ...input, ...parseJsonArg(opts.input, "--input") };
            }
            applySetPairs(input, opts.set ?? []);

            const registry = createDefaultRegistry();
            const controller = new AbortController();
            const onSignal = (): void => controller.abort();
            process.on("SIGINT", onSignal);
            process.on("SIGTERM", onSignal);
            let result: CapabilityRunResult;
            try {
              result = await runCapability(
                registry,
                {
                  capabilityId: id,
                  projectRoot: opts.project,
                  input,
                  operationId: opts.operationId,
                  taskId: opts.taskId,
                  runId: opts.runId,
                  persist: opts.persist,
                  signal: controller.signal,
                },
                { warn: (message) => ctx.log.warn(message) },
              );
            } finally {
              process.removeListener("SIGINT", onSignal);
              process.removeListener("SIGTERM", onSignal);
            }
            if (json) {
              ctx.log.result(result);
            } else {
              ctx.log.result(resultSummaryLines(result).join("\n"));
            }
            process.exitCode = exitCodeForResult(result);
          } catch (err) {
            const message =
              err instanceof CapabilityError
                ? `${err.structured.code}: ${err.structured.message}`
                : err instanceof PathSafetyError
                  ? `${err.code}: ${err.message}`
                  : err instanceof Error
                    ? err.message
                    : String(err);
            if (json) {
              ctx.log.result({
                ok: false,
                error: {
                  code: err instanceof CapabilityError ? err.structured.code : "capability-run-failed",
                  message,
                  ...(err instanceof CapabilityError && err.structured.details !== undefined
                    ? { details: err.structured.details }
                    : {}),
                },
              });
            }
            ctx.log.error(message);
            process.exitCode = 2;
          }
        },
      );
  },
};
