/**
 * Unity provider（首个 provider）：把已安装的 @kevlns/u-cli-mod 包能力
 * 包装成结构化 capability，受控 argv 调用（无 shell 拼接），
 * 目标工程由 .vant/config/v-cli.json 的 bindings.unity.projectDir 统一绑定。
 *
 * 能力集（本阶段）：unity.doctor / unity.editor-status / unity.compile /
 * unity.compile-status / unity.test-start / unity.test-status / unity.test-cancel。
 *
 * 语义边界：
 * - 触发类（compile / test-start）只报告 accepted/running，验收一律 not-run（pending），
 *   完成判定必须轮询对应状态能力。
 * - 状态类只按证据判定：字段缺失、取值不在已知值域、报告缺失 → 一律不通过
 *   （failed 或 not-run），并把实际读到的字段写进证据。
 * - exec 前的就绪判据来自包内 AGENTS.md（doctor cli.state=valid &&
 *   pipeline.installed=true && pipeline.state=current），由前置条件 unity.pipeline-ready
 *   自动执行 doctor 核对；不提供跳过检查的输入选项。
 */

import fs from "node:fs";
import path from "node:path";
import { OFFICIAL_PLUGINS, discoverOfficialPlugin, type OfficialPluginInfo } from "../../core/official";
import { executionFromProcess } from "../../core/execution/runtime";
import { structuredError } from "../../core/execution/errors";
import type { ProcessExecutor, ProcessOutcome } from "../../core/execution/executor";
import type {
  CapabilityExecutionContext,
  CapabilityImplementation,
  CapabilityProvider,
  CapabilityRegistration,
  Evidence,
  ImplementationOutcome,
  JsonSchema,
  PreconditionChecker,
  ProviderBindingContract,
} from "../../core/execution/types";
import type { ProjectRoot } from "../../core/project/paths";
import { PROJECT_CLI_CONFIG_RELATIVE } from "../../core/project/config";
import { comparePathForm } from "../../core/project/paths";
import {
  classifyRecompileStatus,
  classifyTestStatus,
  detectCancellationConfirmation,
  detectTestReport,
  detectWaitBudgetHandoff,
  doctorReadiness,
  extractFailCount,
  extractStatus,
  extractTotal,
  interpretToolOutput,
  normalizeDoctor,
  parseToolStdout,
  type ToolOutput,
} from "./protocol";

export const UNITY_PROVIDER_ID = "unity";
export const UNITY_PROVIDER_VERSION = "0.2.0";

/** bindings.unity 绑定段（Provider 自包含契约） */
export type UnityTestMode = "EditMode" | "PlayMode";

export interface UnityBinding {
  /** 相对工程根的 Unity 工程目录（"." 表示工程根自身） */
  projectDir: string;
  /** 可选：钉扎 Editor 版本（doctor 返回不一致即前置条件不满足） */
  editorVersion?: string;
  /** 可选：test-start 未显式传 mode 时的默认值 */
  testMode?: UnityTestMode;
}

const unityBindingSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["projectDir"],
  properties: {
    projectDir: { type: "string", minLength: 1, description: "相对工程根的 Unity 工程目录（. 表示工程根本身）" },
    editorVersion: { type: "string", minLength: 1, description: "可选：钉扎 Editor 版本" },
    testMode: { type: "string", enum: ["EditMode", "PlayMode"], description: "可选：test-start 默认测试模式" },
  },
};

/** 绑定契约：schema 声明 + 路径字段 + 语义校验（路径解析走核心注入的统一入口） */
export const unityBindingContract: ProviderBindingContract = {
  schema: unityBindingSchema,
  pathFields: [{ field: "projectDir", kind: "dir", required: true }],
  resolve: ({ project, raw, resolveInsideProject }) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, errors: ["bindings.unity 必须是对象"] };
    }
    const section = raw as UnityBinding;
    const errors: string[] = [];
    if (typeof section.projectDir !== "string" || section.projectDir.length === 0) {
      errors.push('bindings.unity.projectDir 必须是非空字符串（相对工程根）');
    }
    if (section.editorVersion !== undefined && (typeof section.editorVersion !== "string" || section.editorVersion.length === 0)) {
      errors.push("bindings.unity.editorVersion 出现时必须是非空字符串");
    }
    if (section.testMode !== undefined && section.testMode !== "EditMode" && section.testMode !== "PlayMode") {
      errors.push('bindings.unity.testMode 出现时必须是 "EditMode" 或 "PlayMode"');
    }
    if (errors.length > 0) return { ok: false, errors };
    // 路径违规（PathSafetyError）向上穿透：核心归类为 unsafe-binding
    const resolved = resolveInsideProject(project, section.projectDir, "bindings.unity.projectDir");
    return { ok: true, dirs: { projectDir: resolved.path }, files: {}, section: { ...section }, warnings: [] };
  },
};

/** 从执行上下文取本 provider 的已校验绑定段 */
function unityBinding(ctx: CapabilityExecutionContext): UnityBinding | null {
  const binding = ctx.binding;
  if (binding === null || typeof binding !== "object") return null;
  return binding as unknown as UnityBinding;
}
const UNITY_BACKEND_PACKAGE = "@kevlns/u-cli-mod";
const UNITY_BACKEND_COMMAND = "unity";
/** 进程硬超时相对 --wait 预算的余量（ms）：包装器让出后仍要给 CLI 收尾时间 */
const DEFAULT_TIMEOUT_SLACK_MS = 15_000;

const DEFAULT_WAIT_SECONDS: Record<string, number> = {
  "unity.doctor": 60,
  "unity.editor-status": 30,
  "unity.compile": 30,
  "unity.compile-status": 30,
  "unity.test-start": 30,
  "unity.test-status": 30,
  "unity.test-cancel": 30,
};

export interface UnityProviderDeps {
  executor: ProcessExecutor;
  /** 后端发现；默认走 v-cli 官方插件白名单发现（不执行工具） */
  discoverBackend?: () => OfficialPluginInfo;
  /** 追加环境变量（默认继承父进程环境） */
  env?: Record<string, string | undefined>;
  timeoutSlackMs?: number;
}

/** 受控 argv：exec 目标工程 / 等待预算 / JSON 格式 / Pipeline 命令 */
export function buildExecArgv(options: {
  projectDir: string;
  waitSeconds: number;
  pipelineCommand: string;
  pipelineArgs?: string[];
}): string[] {
  return [
    "exec",
    options.projectDir,
    "--wait",
    String(options.waitSeconds),
    "--format",
    "json",
    "command",
    options.pipelineCommand,
    ...(options.pipelineArgs ?? []),
  ];
}

export function buildDoctorArgv(options: { projectDir: string; allowRunningEditor: boolean }): string[] {
  const argv = ["doctor", options.projectDir];
  if (options.allowRunningEditor) argv.push("--allow-running-editor");
  return argv;
}

/* ------------------------------- schema 片段 ------------------------------- */

const waitSecondsSchema: JsonSchema = {
  type: "integer",
  minimum: 0,
  maximum: 600,
  description: "包装器等待预算（秒）；0 = 立即让出控制权",
};

/** 输入统一由配置绑定：无 projectPath/project 等字段，additionalProperties=false 拒绝覆盖 */
function execInputSchema(extra: Record<string, JsonSchema> = {}): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties: { waitSeconds: waitSecondsSchema, ...extra },
  };
}

const nullableString = (description: string): JsonSchema => ({ type: "string", nullable: true, description });
const nullableInteger = (description: string): JsonSchema => ({ type: "integer", nullable: true, description });

const doctorOutputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ready", "reasons"],
  properties: {
    editorVersion: nullableString("工程 Editor 版本（缺失为 null）"),
    editorRevision: nullableString("工程 Editor revision"),
    routeSupported: { type: "boolean", nullable: true, description: "工程版本是否在钉扎路由表内" },
    routeRevision: nullableString("路由期望的 revision"),
    cliState: nullableString("Unity CLI 状态（valid 为就绪）"),
    pipelineState: nullableString("适配包状态（current 为就绪）"),
    pipelineInstalled: { type: "boolean", nullable: true, description: "expected-tree 校验通过即 true" },
    pipelinePresent: { type: "boolean", nullable: true, description: "目录存在（不代表就绪）" },
    unityProcessCount: nullableInteger("运行中的 Unity 进程数（查询失败为 null）"),
    supportedVersions: { type: "array", items: { type: "string" }, nullable: true, description: "支持的路由版本列表" },
    ready: { type: "boolean", description: "内核对就绪判据的结论" },
    reasons: { type: "array", items: { type: "string" }, description: "未就绪原因列表" },
  },
};

const editorStatusOutputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "statusSource", "ready"],
  properties: {
    status: nullableString('Editor 状态字符串；证据显示就绪值为 "ready"'),
    statusSource: nullableString("读取到的字段路径"),
    ready: { type: "boolean" },
  },
};

const compileOutputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["accepted", "recompileStatus", "waitBudgetExpired"],
  properties: {
    accepted: { type: "boolean", description: "是否拿到明确的接受响应（handoff/不可解析时为 false）" },
    recompileStatus: nullableString("响应中读到的 recompile 状态（若有）"),
    waitBudgetExpired: { type: "boolean", description: "包装器是否因等待预算耗尽让出控制权" },
  },
};

const compileStatusOutputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "statusSource"],
  properties: {
    status: nullableString("recompile_status 值（观察语义：最近一次编译，不证明属于哪次触发；引擎级编译事件会覆写，跨会话残留）"),
    statusSource: nullableString("读取到的字段路径"),
  },
};

const testStartOutputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["accepted", "mode", "filter", "testStatus", "waitBudgetExpired"],
  properties: {
    accepted: { type: "boolean" },
    mode: { type: "string" },
    filter: nullableString("--filter 值（未传为 null）"),
    testStatus: nullableString("响应中读到的测试状态（若有）"),
    waitBudgetExpired: { type: "boolean" },
  },
};

const testStatusOutputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "statusSource",
    "completed",
    "failCount",
    "failCountSource",
    "total",
    "reportPresent",
    "reportSources",
  ],
  properties: {
    status: nullableString("test_status 值（观察语义：最近一次运行，不证明属于哪次启动；新启动顶替旧运行，跨会话残留旧报告）"),
    statusSource: nullableString("读取到的字段路径"),
    completed: { type: "boolean" },
    failCount: nullableInteger("失败数（候选路径未命中为 null）"),
    failCountSource: nullableString("失败数来源字段路径"),
    total: nullableInteger("总用例数（若有）"),
    reportPresent: { type: "boolean", description: "是否存在有效报告" },
    reportSources: { type: "array", items: { type: "string" }, description: "报告证据来源字段" },
  },
};

const testCancelOutputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cancelAccepted", "confirmed", "confirmationSource", "probeStatus", "probeStatusSource"],
  properties: {
    cancelAccepted: { type: "boolean", description: "cancel_tests 请求是否被接受" },
    confirmed: { type: "boolean", description: "取消是否已确认生效" },
    confirmationSource: nullableString("确认来源"),
    probeStatus: nullableString("test_status 探测结果"),
    probeStatusSource: nullableString("探测结果字段路径"),
  },
};

/* ------------------------------- 通用片段 ------------------------------- */

const READONLY_RETRY = {
  safe: true,
  maxAttempts: 1,
  strategy: "none" as const,
  description: "只读能力；内核单次尝试，重试由调用方决定",
};

const TRIGGER_RETRY = {
  safe: false,
  maxAttempts: 1,
  strategy: "poll-status" as const,
  description: "触发类操作不自动重试；用对应状态能力轮询后续结果",
};

const EXEC_RESOURCES = [
  {
    kind: "engine-editor" as const,
    mode: "exclusive" as const,
    scope: "project" as const,
    description: "需要目标工程 Editor 内的 Pipeline 实例",
  },
  {
    kind: "project-workspace" as const,
    mode: "exclusive" as const,
    scope: "project" as const,
    description: "在目标工程内触发引擎工作",
  },
];

const READONLY_RESOURCES = [
  {
    kind: "engine-editor" as const,
    mode: "shared" as const,
    scope: "project" as const,
    description: "只读查询目标工程 Editor 状态",
  },
  {
    kind: "project-workspace" as const,
    mode: "shared" as const,
    scope: "project" as const,
    description: "只读读取工程状态",
  },
];

const doctorSideEffects = [
  {
    id: "spawn-unity-backend",
    kind: "process-exec" as const,
    description: `以受控 argv 启动 ${UNITY_BACKEND_PACKAGE}（${UNITY_BACKEND_COMMAND}）进程`,
    reversible: false,
  },
  {
    id: "read-project-routing",
    kind: "fs-read" as const,
    description: "读取工程 ProjectVersion.txt、钉扎路由表与已安装包树（只读）",
    reversible: true,
  },
  {
    id: "query-editor-processes",
    kind: "engine-state" as const,
    description: "查询运行中的 Unity Editor 进程状态（只读）",
    reversible: true,
  },
];

const execSideEffects = (mutating: boolean) => [
  {
    id: "spawn-unity-backend",
    kind: "process-exec" as const,
    description: `以受控 argv 启动 ${UNITY_BACKEND_PACKAGE}（${UNITY_BACKEND_COMMAND}）进程`,
    reversible: false,
  },
  {
    id: "query-editor-processes",
    kind: "engine-state" as const,
    description: "查询运行中的 Unity Editor 进程状态（只读）",
    reversible: true,
  },
  ...(mutating
    ? [
        {
          id: "trigger-engine-work",
          kind: "engine-state" as const,
          description: "在目标 Editor 内触发引擎侧工作（重编译 / 测试运行 / 取消测试）",
          reversible: false,
        },
      ]
    : []),
  {
    id: "editor-exec-log",
    kind: "fs-write" as const,
    description: "等待预算耗尽让出控制权时，包装器在工程 Library/editor-pipeline-cli/exec-logs 写输出日志",
    reversible: false,
  },
];

function evidenceField(description: string, data: unknown): Evidence {
  return { kind: "protocol-field", description, data };
}

function evidenceExit(outcome: ProcessOutcome): Evidence {
  return {
    kind: "process-exit",
    description: `进程 exit=${outcome.exitCode ?? "null"} signal=${outcome.signal ?? "null"}`,
    data: { exitCode: outcome.exitCode, signal: outcome.signal, timedOut: outcome.timedOut },
  };
}

/** 后端不可用时的兜底失败（正常被前置条件挡住，不应走到这里） */
function backendUnavailableOutcome(detail: string): ImplementationOutcome {
  return {
    execution: {
      status: "failed",
      lifecycle: "completed",
      exitCode: null,
      signal: null,
      error: structuredError("unity-backend-unavailable", "precondition", detail),
    },
    acceptance: { status: "not-run", reason: "Unity 后端不可用，未执行", pending: false, evidence: [] },
  };
}

function inputWaitSeconds(input: Record<string, unknown>, capabilityId: string): number {
  const raw = input.waitSeconds;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 600) return raw;
  return DEFAULT_WAIT_SECONDS[capabilityId] ?? 30;
}

interface InvocationResult {
  outcome: ProcessOutcome;
  tool: ToolOutput;
  handoff: boolean;
  command: { file: string; args: string[] };
  rawOutput: { stdout: string; stderr: string; stdoutTruncated?: boolean; stderrTruncated?: boolean };
  toolInfo: { name: string; version?: string; path?: string };
  /** 信封回显的目标工程与绑定不一致（GAP-U2：响应不被采信，由调用方转为协议错误） */
  targetMismatch: { echoed: string; expected: string } | null;
}

/** 读取信封 data.target.projectPath 回显（字段来源：2026-10-10 实测，见协议样本 §1） */
function readEchoedProjectPath(parsed: unknown): string | null {
  if (
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) &&
    typeof (parsed as { data?: unknown }).data === "object" && (parsed as { data: unknown }).data !== null
  ) {
    const data = (parsed as { data: Record<string, unknown> }).data;
    const target = data.target;
    if (typeof target === "object" && target !== null && !Array.isArray(target)) {
      const projectPath = (target as Record<string, unknown>).projectPath;
      if (typeof projectPath === "string" && projectPath.length > 0) return projectPath;
    }
  }
  return null;
}

function unityPathsEqual(a: string, b: string): boolean {
  const norm = comparePathForm;
  if (norm(a) === norm(b)) return true;
  // 8.3 短名 / 与 Editor 持有形式不同的词形：两侧都存在时按最终路径（realpath）比较
  try {
    return norm(fs.realpathSync(a)) === norm(fs.realpathSync(b));
  } catch {
    return false;
  }
}

/* ------------------------------- provider 工厂 ------------------------------- */

export function createUnityProvider(deps: UnityProviderDeps): CapabilityProvider {
  const discoverBackend =
    deps.discoverBackend ??
    (() => {
      const spec = OFFICIAL_PLUGINS.find((p) => p.command === UNITY_BACKEND_COMMAND);
      if (!spec) throw new Error(`官方插件白名单缺少 ${UNITY_BACKEND_COMMAND}`);
      return discoverOfficialPlugin(spec);
    });
  const slack = deps.timeoutSlackMs ?? DEFAULT_TIMEOUT_SLACK_MS;

  async function backendStatus(): Promise<{ info: OfficialPluginInfo; available: boolean; detail: string }> {
    let info: OfficialPluginInfo;
    try {
      info = discoverBackend();
    } catch (err) {
      return {
        info: {
          source: "official",
          package: UNITY_BACKEND_PACKAGE,
          name: UNITY_BACKEND_COMMAND,
          description: "",
          status: "invalid",
          platform: process.platform,
        },
        available: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    return {
      info,
      available: info.status === "available" && typeof info.bin === "string",
      detail: info.error ?? `status=${info.status}`,
    };
  }

  async function invoke(
    argv: string[],
    ctx: CapabilityExecutionContext,
    waitSeconds: number,
    cwd: string,
  ): Promise<InvocationResult> {
    const backend = await backendStatus();
    if (!backend.available || !backend.info.bin) {
      throw new Error(`unity 后端不可用: ${backend.detail}`);
    }
    ctx.log.event("process-start", `启动 ${UNITY_BACKEND_COMMAND}`, { argv });
    const outcome = await deps.executor.run({
      file: process.execPath,
      args: [backend.info.bin, ...argv],
      cwd,
      env: deps.env,
      timeoutMs: waitSeconds * 1000 + slack,
      signal: ctx.signal,
    });
    ctx.log.event("process-finish", `进程结束 exit=${outcome.exitCode ?? "null"}`, {
      signal: outcome.signal,
      timedOut: outcome.timedOut,
      aborted: outcome.aborted,
      stdoutBytes: outcome.stdout.length,
      stderrBytes: outcome.stderr.length,
    });
    const tool = interpretToolOutput(outcome.stdout);
    if (argv[0] === "exec" && tool.success === null && !tool.parseError) {
      tool.parseError = "Unity exec 输出缺少 success 信封";
    }
    // GAP-U2：exec 信封回显目标工程身份，与绑定目录核对（不一致 → 不采信该响应）
    let targetMismatch: { echoed: string; expected: string } | null = null;
    if (argv[0] === "exec" && tool.parsed !== null) {
      const echoed = readEchoedProjectPath(tool.parsed);
      if (echoed !== null && !unityPathsEqual(echoed, cwd)) {
        targetMismatch = { echoed, expected: cwd };
        ctx.log.warn(`信封回显目标工程 ${echoed} 与绑定 ${cwd} 不一致：响应不被采信`);
      }
    }
    return {
      outcome,
      tool,
      handoff: detectWaitBudgetHandoff(outcome.stdout, outcome.stderr, outcome.exitCode),
      command: { file: process.execPath, args: [backend.info.bin, ...argv] },
      rawOutput: {
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        stdoutTruncated: outcome.stdoutTruncated,
        stderrTruncated: outcome.stderrTruncated,
      },
      toolInfo: {
        name: UNITY_BACKEND_COMMAND,
        version: backend.info.version,
        path: backend.info.bin,
      },
      targetMismatch,
    };
  }

  function findUnityDir(ctx: CapabilityExecutionContext): string | null {
    return ctx.bindingDirs.projectDir ?? null;
  }

  /* --------------------------- 前置条件检查实现 --------------------------- */

  const backendAvailableCheck: PreconditionChecker = async () => {
    const backend = await backendStatus();
    if (backend.available) {
      return {
        id: "unity.backend-available",
        status: "satisfied",
        detail: `${UNITY_BACKEND_PACKAGE}@${backend.info.version ?? "?"} 可用`,
        evidence: [
          evidenceField("后端发现", {
            package: UNITY_BACKEND_PACKAGE,
            version: backend.info.version,
            status: backend.info.status,
            bin: backend.info.bin,
          }),
        ],
      };
    }
    return {
      id: "unity.backend-available",
      status: "violated",
      detail: `未发现可用的 ${UNITY_BACKEND_PACKAGE}: ${backend.detail}`,
      evidence: [
        evidenceField("后端发现", {
          package: UNITY_BACKEND_PACKAGE,
          status: backend.info.status,
          error: backend.info.error,
        }),
      ],
    };
  };

  const projectBindingCheck: PreconditionChecker = (_input, ctx) => {
    const dir = findUnityDir(ctx);
    if (dir) {
      return {
        id: "unity.project-binding",
        status: "satisfied",
        detail: `已绑定 Unity 工程目录 ${dir}`,
        evidence: [evidenceField("bindings.unity.projectDir", dir)],
      };
    }
    return {
      id: "unity.project-binding",
      status: "violated",
      detail: '工程配置缺少 bindings.unity.projectDir（例 "Client"）；capability 输入不接受 projectPath 覆盖',
      evidence: [evidenceField("工程配置文件", ctx.configFile)],
    };
  };

  const projectVersionFileCheck: PreconditionChecker = (_input, ctx) => {
    const dir = findUnityDir(ctx);
    if (!dir) {
      return { id: "unity.project-version-file", status: "violated", detail: "缺少工程目录绑定" };
    }
    const versionFile = path.join(dir, "ProjectSettings", "ProjectVersion.txt");
    if (fs.existsSync(versionFile)) {
      return {
        id: "unity.project-version-file",
        status: "satisfied",
        detail: "找到 ProjectSettings/ProjectVersion.txt",
        evidence: [evidenceField("ProjectVersion.txt", versionFile)],
      };
    }
    return {
      id: "unity.project-version-file",
      status: "violated",
      detail: `绑定目录缺少 ProjectSettings/ProjectVersion.txt: ${dir}`,
      evidence: [evidenceField("期望文件", versionFile)],
    };
  };

  /** exec 前就绪判据：自动跑一次 doctor（包内 AGENTS.md 的强制规范） */
  const pipelineReadyCheck: PreconditionChecker = async (input, ctx) => {
    const dir = findUnityDir(ctx);
    if (!dir) {
      return { id: "unity.pipeline-ready", status: "violated", detail: "缺少工程目录绑定" };
    }
    const argv = buildDoctorArgv({ projectDir: dir, allowRunningEditor: true });
    let result: InvocationResult;
    try {
      result = await invoke(argv, ctx, DEFAULT_WAIT_SECONDS["unity.doctor"], dir);
    } catch (err) {
      return {
        id: "unity.pipeline-ready",
        status: "unknown",
        detail: `doctor 无法执行: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const exec = executionFromProcess(result.outcome);
    if (exec.status !== "succeeded") {
      return {
        id: "unity.pipeline-ready",
        status: "unknown",
        detail: `doctor 未成功（${exec.status}）：${exec.error?.message ?? "未知"}`,
        evidence: [evidenceExit(result.outcome)],
      };
    }
    if (result.tool.parseError !== null) {
      return {
        id: "unity.pipeline-ready",
        status: "unknown",
        detail: `doctor 输出无法解析为 JSON: ${result.tool.parseError}`,
      };
    }
    const doctor = normalizeDoctor(result.tool.parsed);
    const readiness = doctorReadiness(doctor);
    const pin = unityBinding(ctx)?.editorVersion;
    const pinMismatch = pin !== undefined && doctor.editorVersion !== pin;
    if (!readiness.ready || pinMismatch) {
      const reasons = [...readiness.reasons];
      if (pinMismatch) {
        reasons.push(`工程 Editor 版本 ${doctor.editorVersion ?? "(缺失)"} 与配置钉扎 ${pin} 不一致`);
      }
      return {
        id: "unity.pipeline-ready",
        status: "violated",
        detail: `exec 就绪判据未满足: ${reasons.join("；")}`,
        evidence: [
          evidenceField("doctor 就绪判据", {
            routeSupported: doctor.routeSupported,
            cliState: doctor.cliState,
            pipelineInstalled: doctor.pipelineInstalled,
            pipelineState: doctor.pipelineState,
          }),
        ],
      };
    }
    return {
      id: "unity.pipeline-ready",
      status: "satisfied",
      detail: `doctor 就绪（cli.state=valid, pipeline.installed=true, pipeline.state=current${
        pin ? `, 版本钉扎 ${pin} 一致` : ""
      }）`,
      evidence: [
        evidenceField("doctor 就绪判据", {
          routeSupported: doctor.routeSupported,
          cliState: doctor.cliState,
          pipelineInstalled: doctor.pipelineInstalled,
          pipelineState: doctor.pipelineState,
          editorVersion: doctor.editorVersion,
        }),
      ],
    };
  };

  const baseChecks: Record<string, PreconditionChecker> = {
    "unity.backend-available": backendAvailableCheck,
    "unity.project-binding": projectBindingCheck,
    "unity.project-version-file": projectVersionFileCheck,
  };
  const execChecks: Record<string, PreconditionChecker> = {
    ...baseChecks,
    "unity.pipeline-ready": pipelineReadyCheck,
  };

  const basePreconditions = [
    { id: "unity.backend-available", description: "已安装并可用的 @kevlns/u-cli-mod（官方白名单发现）" },
    { id: "unity.project-binding", description: "工程配置已绑定 bindings.unity.projectDir（输入不接受 projectPath 覆盖）" },
    { id: "unity.project-version-file", description: "绑定目录含 ProjectSettings/ProjectVersion.txt" },
  ];
  const execPreconditions = [
    ...basePreconditions,
    {
      id: "unity.pipeline-ready",
      description:
        "exec 就绪判据（自动 doctor：routeSupported=true、cli.state=valid、pipeline.installed=true、pipeline.state=current）",
    },
  ];

  /* ------------------------------- 通用执行辅助 ------------------------------- */

  function failedBeforeRun(
    result: InvocationResult,
    label: string,
    followUpCapabilityId: string | null = null,
  ): ImplementationOutcome {
    const exec = executionFromProcess(result.outcome);
    const pending = followUpCapabilityId !== null;
    return {
      execution: exec,
      acceptance: {
        status: "not-run",
        reason: `${label} 未成功（${exec.status}），无验收结论`,
        pending,
        evidence: [evidenceExit(result.outcome)],
      },
      followUp:
        pending && followUpCapabilityId !== null
          ? [{ capabilityId: followUpCapabilityId, hint: `调用未取得结论（超时/中断只说明调用结束，不推断底层已停止）：重试或轮询` }]
          : undefined,
      command: result.command,
      tool: result.toolInfo,
      rawOutput: result.rawOutput,
    };
  }

  function toolReportedFailure(result: InvocationResult, label: string): ImplementationOutcome {
    return {
      execution: {
        status: "failed",
        lifecycle: "completed",
        exitCode: result.outcome.exitCode,
        signal: result.outcome.signal,
        error: structuredError(
          "tool-reported-failure",
          "process",
          result.tool.errorMessage ?? `${label}: Unity CLI 报告 success=false`,
        ),
      },
      acceptance: {
        status: "not-run",
        reason: "工具报告失败，无验收结论",
        pending: false,
        evidence: [evidenceField("信封 success", false)],
      },
      command: result.command,
      tool: result.toolInfo,
      rawOutput: result.rawOutput,
    };
  }

  function unparseable(result: InvocationResult, label: string, capabilityId: string): ImplementationOutcome {
    return {
      execution: {
        status: "unknown",
        lifecycle: "unknown",
        exitCode: result.outcome.exitCode,
        signal: result.outcome.signal,
        error: structuredError(
          "output-unparseable",
          "protocol",
          `${label} 输出无法解释: ${result.tool.parseError ?? "无法读取响应"}`,
          { details: { stderrTail: result.outcome.stderr.slice(-800) } },
        ),
      },
      acceptance: {
        status: "not-run",
        reason: "工具输出不可解释，无验收结论；重新执行本能力取得结论",
        pending: true,
        evidence: [evidenceExit(result.outcome)],
      },
      followUp: [{ capabilityId, hint: "重新执行本能力以取得结论" }],
      command: result.command,
      tool: result.toolInfo,
      rawOutput: result.rawOutput,
    };
  }

  /** 状态能力遇到"等待预算耗尽让出控制权"：未取得结论，应重新轮询（不通过） */
  function statusHandoffOutcome(
    result: InvocationResult,
    label: string,
    capabilityId: string,
  ): ImplementationOutcome {
    return {
      execution: {
        status: "unknown",
        lifecycle: "unknown",
        exitCode: result.outcome.exitCode,
        signal: result.outcome.signal,
        error: structuredError(
          "status-unconfirmed",
          "protocol",
          `${label} 等待预算耗尽：包装器已让出控制权，未取得状态结论`,
          { details: { stderrTail: result.outcome.stderr.slice(-800) } },
        ),
      },
      acceptance: {
        status: "not-run",
        reason: `${label} 未取得状态结论（工具仍在 Editor 内执行）；请重新执行本状态能力`,
        pending: true,
        evidence: [evidenceExit(result.outcome)],
      },
      followUp: [{ capabilityId, hint: "重新执行本状态能力以取得结论" }],
      command: result.command,
      tool: result.toolInfo,
      rawOutput: result.rawOutput,
    };
  }

  /** 信封回显目标工程与绑定不一致（GAP-U2）：响应整体不采信，协议错误 */
  function targetMismatchOutcome(result: InvocationResult): ImplementationOutcome {
    return {
      execution: {
        status: "failed",
        lifecycle: "unknown",
        exitCode: result.outcome.exitCode,
        signal: result.outcome.signal,
        error: structuredError(
          "unity-target-mismatch",
          "protocol",
          `Editor 回显目标工程 ${result.targetMismatch!.echoed} 与绑定 ${result.targetMismatch!.expected} 不一致：响应不被采信`,
          { retryable: false },
        ),
      },
      acceptance: {
        status: "not-run",
        reason: "目标工程身份核对失败，未采信响应（不回退其他工程）",
        pending: false,
        evidence: [evidenceField("data.target.projectPath 回显", result.targetMismatch!.echoed)],
      },
      command: result.command,
      tool: result.toolInfo,
      rawOutput: result.rawOutput,
    };
  }

  async function invokeOrUnavailable(
    argv: string[],
    ctx: CapabilityExecutionContext,
    waitSeconds: number,
    dir: string,
  ): Promise<InvocationResult | ImplementationOutcome> {
    try {
      const result = await invoke(argv, ctx, waitSeconds, dir);
      if (result.targetMismatch !== null) return targetMismatchOutcome(result);
      return result;
    } catch (err) {
      return backendUnavailableOutcome(err instanceof Error ? err.message : String(err));
    }
  }

  function isOutcome(value: InvocationResult | ImplementationOutcome): value is ImplementationOutcome {
    return (value as ImplementationOutcome).execution !== undefined;
  }

  /* ------------------------------- 各能力实现 ------------------------------- */

  const doctorExecute: CapabilityImplementation["execute"] = async (input, ctx) => {
    const dir = findUnityDir(ctx);
    if (!dir) return backendUnavailableOutcome("缺少工程目录绑定");
    const argv = buildDoctorArgv({
      projectDir: dir,
      allowRunningEditor: input.allowRunningEditor === true,
    });
    const invoked = await invokeOrUnavailable(argv, ctx, inputWaitSeconds(input, "unity.doctor"), dir);
    if (isOutcome(invoked)) return invoked;
    const result = invoked;
    const exec = executionFromProcess(result.outcome, { failureCode: "doctor-exit-nonzero" });
    const base = { command: result.command, tool: result.toolInfo, rawOutput: result.rawOutput };
    if (exec.status !== "succeeded") {
      return {
        ...base,
        ...failedBeforeRun(result, "doctor"),
        execution: exec,
        sideEffects: [
          { kind: "process-exec", description: `启动 ${UNITY_BACKEND_COMMAND} doctor`, reversible: false, details: { argv } },
        ],
      };
    }
    const parse = parseToolStdout(result.outcome.stdout);
    if (parse.parsed === null) {
      return {
        ...base,
        execution: {
          status: "unknown",
          lifecycle: "unknown",
          exitCode: result.outcome.exitCode,
          signal: result.outcome.signal,
          error: structuredError("output-unparseable", "protocol", `doctor 输出无法解析为 JSON: ${parse.parseError}`),
        },
        acceptance: {
          status: "not-run",
          reason: "doctor 输出不可解析，无验收结论",
          pending: false,
          evidence: [evidenceExit(result.outcome)],
        },
      };
    }
    const doctor = normalizeDoctor(parse.parsed);
    const readiness = doctorReadiness(doctor);
    const output = { ...doctor, ready: readiness.ready, reasons: readiness.reasons };
    const evidence: Evidence[] = [
      evidenceExit(result.outcome),
      evidenceField("doctor.routeSupported", doctor.routeSupported),
      evidenceField("doctor.cli.state", doctor.cliState),
      evidenceField("doctor.pipeline.installed", doctor.pipelineInstalled),
      evidenceField("doctor.pipeline.state", doctor.pipelineState),
    ];
    return {
      ...base,
      output,
      execution: exec,
      acceptance: readiness.ready
        ? {
            status: "passed",
            reason:
              "路由/CLI/适配包均就绪（routeSupported=true, cli.state=valid, pipeline.installed=true, pipeline.state=current）",
            pending: false,
            evidence,
          }
        : {
            status: "failed",
            reason: `工程未就绪: ${readiness.reasons.join("；")}`,
            pending: false,
            evidence,
          },
      sideEffects: [
        { kind: "process-exec", description: `启动 ${UNITY_BACKEND_COMMAND} doctor`, reversible: false, details: { argv } },
        { kind: "fs-read", description: "只读读取工程版本、路由与包树状态", reversible: true },
      ],
      notes: ["doctor 退出码 0 只表示诊断完成，不代表工程已就绪（验收由 routeSupported/cli/pipeline 字段判定）"],
    };
  };

  const editorStatusExecute: CapabilityImplementation["execute"] = async (input, ctx) => {
    const dir = findUnityDir(ctx);
    if (!dir) return backendUnavailableOutcome("缺少工程目录绑定");
    const waitSeconds = inputWaitSeconds(input, "unity.editor-status");
    const argv = buildExecArgv({ projectDir: dir, waitSeconds, pipelineCommand: "editor_status" });
    const invoked = await invokeOrUnavailable(argv, ctx, waitSeconds, dir);
    if (isOutcome(invoked)) return invoked;
    const result = invoked;
    const exec = executionFromProcess(result.outcome);
    const base = { command: result.command, tool: result.toolInfo, rawOutput: result.rawOutput };
    if (exec.status !== "succeeded") return failedBeforeRun(result, "editor_status", "unity.editor-status");
    if (result.tool.success === false) return toolReportedFailure(result, "editor_status");
    if (result.handoff) return statusHandoffOutcome(result, "editor_status", "unity.editor-status");
    if (result.tool.parseError !== null) return unparseable(result, "editor_status", "unity.editor-status");
    const { status, source } = extractStatus(result.tool.payload);
    const ready = status === "ready";
    const output = { status, statusSource: source, ready };
    return {
      ...base,
      output,
      execution: exec,
      acceptance: ready
        ? {
            status: "passed",
            reason: 'editor_status 报告 status="ready"',
            pending: false,
            evidence: [evidenceField(source ?? "status", status)],
          }
        : {
            status: "failed",
            reason:
              status === null
                ? "结果缺少 status/state 字段：无法确认 Editor 状态，不通过"
                : `editor_status 报告 status="${status}"（证据显示就绪值为 "ready"）`,
            pending: false,
            evidence: [evidenceField(source ?? "status 字段缺失", status)],
          },
    };
  };

  const compileExecute: CapabilityImplementation["execute"] = async (input, ctx) => {
    const dir = findUnityDir(ctx);
    if (!dir) return backendUnavailableOutcome("缺少工程目录绑定");
    const waitSeconds = inputWaitSeconds(input, "unity.compile");
    const argv = buildExecArgv({ projectDir: dir, waitSeconds, pipelineCommand: "recompile" });
    const invoked = await invokeOrUnavailable(argv, ctx, waitSeconds, dir);
    if (isOutcome(invoked)) return invoked;
    const result = invoked;
    const exec = executionFromProcess(result.outcome);
    const base = { command: result.command, tool: result.toolInfo, rawOutput: result.rawOutput };
    const extracted = result.tool.parseError === null ? extractStatus(result.tool.payload) : { status: null, source: null };
    const output = { accepted: false, recompileStatus: extracted.status, waitBudgetExpired: result.handoff };
    if (exec.status !== "succeeded") {
      return { ...failedBeforeRun(result, "recompile 触发", "unity.compile-status"), output };
    }
    if (result.tool.success === false) return { ...toolReportedFailure(result, "recompile 触发"), output };
    if (result.handoff || result.tool.parseError !== null) {
      return {
        ...base,
        output,
        execution: {
          status: "unknown",
          lifecycle: "unknown",
          exitCode: result.outcome.exitCode,
          signal: result.outcome.signal,
          error: structuredError(
            "trigger-unconfirmed",
            "protocol",
            "等待预算耗尽/输出不可解析：无法确认 recompile 已被接受（包装器已让出控制权，Editor 侧工作可能仍在进行）",
            { details: { stderrTail: result.outcome.stderr.slice(-800) } },
          ),
        },
        acceptance: {
          status: "not-run",
          reason: "触发结果未确认；请用 unity.compile-status 轮询（pending）",
          pending: true,
          evidence: [evidenceExit(result.outcome)],
        },
        followUp: [
          { capabilityId: "unity.compile-status", hint: "轮询 recompile_status 直到 completed/up_to_date" },
        ],
      };
    }
    output.accepted = true;
    return {
      ...base,
      output,
      execution: { ...exec, lifecycle: "accepted" },
      acceptance: {
        status: "not-run",
        reason: "recompile 已触发（异步）：完成判定必须轮询 unity.compile-status，触发不等于通过",
        pending: true,
        evidence: [evidenceField("信封 success", true), evidenceField(extracted.source ?? "recompile 触发响应", extracted.status)],
      },
      followUp: [{ capabilityId: "unity.compile-status", hint: "轮询 recompile_status 直到 completed/up_to_date" }],
      notes: [
        "recompile 只表示已请求重编译；完成及错误验收由 unity.compile-status 给出",
        "句柄 backendTaskId=null：后端无任务身份协议（GAP-U1），终态关联 unverified，不可用于句柄关联查询",
      ],
      handle: { backendTaskId: null },
    };
  };

  const compileStatusExecute: CapabilityImplementation["execute"] = async (input, ctx) => {
    const dir = findUnityDir(ctx);
    if (!dir) return backendUnavailableOutcome("缺少工程目录绑定");
    const waitSeconds = inputWaitSeconds(input, "unity.compile-status");
    const argv = buildExecArgv({ projectDir: dir, waitSeconds, pipelineCommand: "recompile_status" });
    const invoked = await invokeOrUnavailable(argv, ctx, waitSeconds, dir);
    if (isOutcome(invoked)) return invoked;
    const result = invoked;
    const exec = executionFromProcess(result.outcome);
    const base = { command: result.command, tool: result.toolInfo, rawOutput: result.rawOutput };
    if (exec.status !== "succeeded") return failedBeforeRun(result, "recompile_status", "unity.compile-status");
    if (result.tool.success === false) return toolReportedFailure(result, "recompile_status");
    if (result.handoff) {
      return statusHandoffOutcome(result, "recompile_status", "unity.compile-status");
    }
    if (result.tool.parseError !== null) return unparseable(result, "recompile_status", "unity.compile-status");
    if (result.tool.payloadParseError !== null) {
      // 调用成功但载荷不可二次解析：与"值域外"分开（调用 succeeded / 任务状态 unknown）
      return {
        ...base,
        output: { status: null, statusSource: null },
        execution: { ...exec, lifecycle: "unknown" },
        acceptance: {
          status: "not-run",
          reason: `recompile_status 载荷不可解析: ${result.tool.payloadParseError}`,
          pending: true,
          evidence: [evidenceExit(result.outcome)],
        },
        followUp: [{ capabilityId: "unity.compile-status", hint: "重新执行本能力以取得结论" }],
      };
    }
    const { status, source } = extractStatus(result.tool.payload);
    const output = { status, statusSource: source };
    const klass = classifyRecompileStatus(status);
    const normalized = status?.trim().toLowerCase().replace(/[\s-]/g, "_") ?? null;
    switch (klass) {
      case "completed":
        const compileReport = result.tool.payload as Record<string, unknown>;
        if (compileReport.failed !== false || !Array.isArray(compileReport.errors) || compileReport.errors.length !== 0) {
          return { ...base, output, execution: { ...exec, lifecycle: "failed" }, acceptance: { status: "failed", reason: "编译状态已结束，但错误报告缺失或存在编译错误", pending: false, evidence: [evidenceField("编译错误报告", compileReport)] } };
        }
        return {
          ...base,
          output,
          execution: exec,
          acceptance: {
            status: "passed",
            reason: `recompile_status=${status}（终态）`,
            pending: false,
            evidence: [evidenceField(source ?? "status", status), evidenceField("编译错误报告", compileReport)],
          },
        };
      case "running":
        return {
          ...base,
          output,
          execution: { ...exec, lifecycle: "running" },
          acceptance: {
            status: "not-run",
            reason: `recompile_status=${status}：仍在进行中，继续轮询`,
            pending: true,
            evidence: [evidenceField(source ?? "status", status)],
          },
          followUp: [{ capabilityId: "unity.compile-status", hint: "继续轮询直到 completed/up_to_date" }],
        };
      case "idle":
        return {
          ...base,
          output,
          execution: { ...exec, lifecycle: "unknown" },
          acceptance: {
            status: "not-run",
            reason: "recompile_status=idle：没有可解释的编译任务状态（可能尚未触发 recompile）",
            pending: false,
            evidence: [evidenceField(source ?? "status", status)],
          },
        };
      case "failed":
        return {
          ...base,
          output,
          execution: { ...exec, lifecycle: "failed" },
          acceptance: {
            status: "failed",
            reason: `recompile_status=${status}`,
            pending: false,
            evidence: [evidenceField(source ?? "status", status)],
          },
        };
      default:
        return {
          ...base,
          output,
          execution: { ...exec, lifecycle: "unknown" },
          acceptance: {
            status: "failed",
            reason:
              normalized === null
                ? "结果缺少 status/state 字段：无法确认编译状态，不通过"
                : `无法识别的 recompile_status 值 "${status}"：不通过（已知值域 idle|triggered|compiling|completed|up_to_date）`,
            pending: false,
            evidence: [evidenceField(source ?? "status 字段缺失", status)],
          },
        };
    }
  };

  const testStartExecute: CapabilityImplementation["execute"] = async (input, ctx) => {
    const dir = findUnityDir(ctx);
    if (!dir) return backendUnavailableOutcome("缺少工程目录绑定");
    const configuredMode = unityBinding(ctx)?.testMode;
    const mode = typeof input.mode === "string" ? input.mode : configuredMode ?? "EditMode";
    const filter = typeof input.filter === "string" ? input.filter : null;
    const waitSeconds = inputWaitSeconds(input, "unity.test-start");
    const pipelineArgs = ["--mode", mode, ...(filter ? ["--filter", filter] : []), "--async_tests"];
    const argv = buildExecArgv({ projectDir: dir, waitSeconds, pipelineCommand: "run_tests", pipelineArgs });
    const invoked = await invokeOrUnavailable(argv, ctx, waitSeconds, dir);
    if (isOutcome(invoked)) return invoked;
    const result = invoked;
    const exec = executionFromProcess(result.outcome);
    const base = { command: result.command, tool: result.toolInfo, rawOutput: result.rawOutput };
    const extracted = result.tool.parseError === null ? extractStatus(result.tool.payload) : { status: null, source: null };
    const output = {
      accepted: false,
      mode,
      filter,
      testStatus: extracted.status,
      waitBudgetExpired: result.handoff,
    };
    if (exec.status !== "succeeded") {
      return { ...failedBeforeRun(result, "run_tests 启动", "unity.test-status"), output };
    }
    if (result.tool.success === false) return { ...toolReportedFailure(result, "run_tests 启动"), output };
    if (result.handoff || result.tool.parseError !== null) {
      return {
        ...base,
        output,
        execution: {
          status: "unknown",
          lifecycle: "unknown",
          exitCode: result.outcome.exitCode,
          signal: result.outcome.signal,
          error: structuredError(
            "trigger-unconfirmed",
            "protocol",
            "等待预算耗尽/输出不可解析：无法确认测试启动已被接受（包装器已让出控制权）",
            { details: { stderrTail: result.outcome.stderr.slice(-800) } },
          ),
        },
        acceptance: {
          status: "not-run",
          reason: "测试启动未确认；请用 unity.test-status 轮询（pending）",
          pending: true,
          evidence: [evidenceExit(result.outcome)],
        },
        followUp: [{ capabilityId: "unity.test-status", hint: "轮询 test_status 直到 completed 并核对失败数" }],
      };
    }
    output.accepted = true;
    return {
      ...base,
      output,
      execution: { ...exec, lifecycle: "accepted" },
      acceptance: {
        status: "not-run",
        reason: "测试已异步启动（--async_tests）：不得把启动当通过，必须轮询 unity.test-status",
        pending: true,
        evidence: [evidenceField("信封 success", true), evidenceField(extracted.source ?? "启动响应", extracted.status)],
      },
      followUp: [{ capabilityId: "unity.test-status", hint: "轮询 test_status 直到 completed 并核对失败数" }],
      notes: [
        "本能力固定追加 --async_tests（Unity CLI 同步命令有 30s 硬上限，全量同步必然超时）",
        "句柄 backendTaskId=null：后端无任务身份协议（GAP-U1），test_status 为观察语义，不可用于句柄关联查询",
      ],
      handle: { backendTaskId: null },
    };
  };

  const testStatusExecute: CapabilityImplementation["execute"] = async (input, ctx) => {
    const dir = findUnityDir(ctx);
    if (!dir) return backendUnavailableOutcome("缺少工程目录绑定");
    const waitSeconds = inputWaitSeconds(input, "unity.test-status");
    const argv = buildExecArgv({ projectDir: dir, waitSeconds, pipelineCommand: "test_status" });
    const invoked = await invokeOrUnavailable(argv, ctx, waitSeconds, dir);
    if (isOutcome(invoked)) return invoked;
    const result = invoked;
    const exec = executionFromProcess(result.outcome);
    const base = { command: result.command, tool: result.toolInfo, rawOutput: result.rawOutput };
    if (exec.status !== "succeeded") return failedBeforeRun(result, "test_status", "unity.test-status");
    if (result.tool.success === false) return toolReportedFailure(result, "test_status");
    if (result.handoff) {
      return statusHandoffOutcome(result, "test_status", "unity.test-status");
    }
    if (result.tool.parseError !== null) return unparseable(result, "test_status", "unity.test-status");
    if (result.tool.payloadParseError !== null) {
      // 调用成功但载荷不可二次解析：与"值域外"分开（调用 succeeded / 任务状态 unknown）
      return {
        ...base,
        output: { status: null, statusSource: null, completed: false, failCount: null, failCountSource: null, total: null, reportPresent: false, reportSources: [] },
        execution: { ...exec, lifecycle: "unknown" },
        acceptance: {
          status: "not-run",
          reason: `test_status 载荷不可解析: ${result.tool.payloadParseError}`,
          pending: true,
          evidence: [evidenceExit(result.outcome)],
        },
        followUp: [{ capabilityId: "unity.test-status", hint: "重新执行本能力以取得结论" }],
      };
    }
    const { status, source } = extractStatus(result.tool.payload);
    const fails = extractFailCount(result.tool.payload);
    const totals = extractTotal(result.tool.payload);
    const report = detectTestReport(result.tool.payload);
    const klass = classifyTestStatus(status);
    const output = {
      status,
      statusSource: source,
      completed: klass === "completed",
      failCount: fails.count,
      failCountSource: fails.source,
      total: totals.total,
      reportPresent: report.present,
      reportSources: report.sources,
    };
    const evidence: Evidence[] = [
      evidenceField(source ?? "status 字段缺失", status),
      evidenceField("失败数", { value: fails.count, source: fails.source }),
      evidenceField("有效报告", { present: report.present, sources: report.sources }),
    ];
    switch (klass) {
      case "completed": {
        if (!report.present) {
          return {
            ...base,
            output,
            execution: exec,
            acceptance: {
              status: "failed",
              reason: "test_status=completed 但缺少有效报告（total/summary/resultSummary/results/reportPath 均未命中）：不通过",
              pending: false,
              evidence,
            },
          };
        }
        if (fails.count === null || totals.total === null || totals.total <= 0 || fails.count > totals.total) {
          return {
            ...base,
            output,
            execution: exec,
            acceptance: {
              status: "failed",
              reason:
                "test_status=completed 但无法从结果中确认失败数（summary.failed / summary.total 无效，零用例亦不通过）：不能通过",
              pending: false,
              evidence,
            },
          };
        }
        if (fails.count > 0) {
          return {
            ...base,
            output,
            execution: exec,
            acceptance: {
              status: "failed",
              reason: `test_status=completed 且失败数 ${fails.count} > 0`,
              pending: false,
              evidence,
            },
          };
        }
        const summary = (result.tool.payload as { summary: Record<string, unknown> }).summary;
        if (!Number.isSafeInteger(summary.passed) || summary.passed !== totals.total) {
          return { ...base, output, execution: exec, acceptance: { status: "failed", reason: "测试报告缺少有效通过数，或未全部通过", pending: false, evidence } };
        }
        return {
          ...base,
          output,
          execution: exec,
          acceptance: {
            status: "passed",
            reason: `test_status=completed、${totals.total} 项全部通过且失败数 0`,
            pending: false,
            evidence,
          },
        };
      }
      case "running":
        return {
          ...base,
          output,
          execution: { ...exec, lifecycle: "running" },
          acceptance: {
            status: "not-run",
            reason: `test_status=${status}：测试仍在运行，继续轮询`,
            pending: true,
            evidence,
          },
          followUp: [{ capabilityId: "unity.test-status", hint: "继续轮询直到 completed" }],
        };
      case "idle":
        return {
          ...base,
          output,
          execution: { ...exec, lifecycle: "unknown" },
          acceptance: {
            status: "not-run",
            reason: "test_status=idle：没有可解释的测试任务状态（可能尚未启动）",
            pending: false,
            evidence,
          },
        };
      case "cancelled":
        return {
          ...base,
          output,
          execution: { ...exec, lifecycle: "cancelled" },
          acceptance: {
            status: "failed",
            reason: `test_status=${status}：测试运行已取消（后端确认），无通过结论`,
            pending: false,
            evidence,
          },
        };
      default:
        return {
          ...base,
          output,
          execution: { ...exec, lifecycle: "unknown" },
          acceptance: {
            status: "failed",
            reason:
              status === null
                ? "结果缺少 status/state 字段：无法确认测试状态，不通过"
                : `无法识别的 test_status 值 "${status}"：不通过`,
            pending: false,
            evidence,
          },
        };
    }
  };

  const testCancelExecute: CapabilityImplementation["execute"] = async (input, ctx) => {
    const dir = findUnityDir(ctx);
    if (!dir) return backendUnavailableOutcome("缺少工程目录绑定");
    const waitSeconds = inputWaitSeconds(input, "unity.test-cancel");
    const verify = input.verify !== false;
    const argv = buildExecArgv({ projectDir: dir, waitSeconds, pipelineCommand: "cancel_tests" });
    const invoked = await invokeOrUnavailable(argv, ctx, waitSeconds, dir);
    if (isOutcome(invoked)) return invoked;
    const result = invoked;
    let exec = executionFromProcess(result.outcome);
    const stdoutParts = [result.outcome.stdout];
    const stderrParts = [result.outcome.stderr];
    const rawOutput = () => ({
      stdout: stdoutParts.join("\n"),
      stderr: stderrParts.join("\n"),
      stdoutTruncated: result.outcome.stdoutTruncated,
      stderrTruncated: result.outcome.stderrTruncated,
    });
    const base = { command: result.command, tool: result.toolInfo };
    if (exec.status !== "succeeded") {
      return { ...failedBeforeRun(result, "cancel_tests", "unity.test-status"), rawOutput: rawOutput() };
    }
    if (result.tool.success === false) {
      return { ...toolReportedFailure(result, "cancel_tests"), rawOutput: rawOutput() };
    }

    let confirmed = false;
    let confirmationSource: string | null = null;
    let probeStatus: string | null = null;
    let probeStatusSource: string | null = null;
    const evidence: Evidence[] = [evidenceField("信封 success", true)];

    if (result.tool.parseError === null) {
      const direct = detectCancellationConfirmation(result.tool.payload);
      if (direct.confirmed) {
        confirmed = true;
        confirmationSource = direct.source;
        evidence.push(evidenceField(`取消确认（${direct.source}）`, true));
      }
    }

    if (!confirmed && verify) {
      const probeArgv = buildExecArgv({ projectDir: dir, waitSeconds, pipelineCommand: "test_status" });
      try {
        const probe = await invoke(probeArgv, ctx, waitSeconds, dir);
        stdoutParts.push(probe.outcome.stdout);
        stderrParts.push(probe.outcome.stderr);
        const probeExec = executionFromProcess(probe.outcome);
        if (probe.targetMismatch !== null) {
          evidence.push(evidenceField("test_status 探测目标工程不一致", probe.targetMismatch));
        } else if (probeExec.status === "succeeded" && probe.tool.parseError === null && probe.tool.success !== false) {
          const extracted = extractStatus(probe.tool.payload);
          probeStatus = extracted.status;
          probeStatusSource = extracted.source;
          const klass = classifyTestStatus(probeStatus);
          if (klass === "cancelled") {
            confirmed = true;
            confirmationSource = `test_status=${probeStatus}（${extracted.source}）`;
          }
          evidence.push(evidenceField("test_status 探测", { status: probeStatus, source: probeStatusSource }));
        } else {
          evidence.push(
            evidenceField("test_status 探测失败", {
              execution: probeExec.status,
              error: probeExec.error?.message ?? null,
            }),
          );
        }
      } catch (err) {
        evidence.push(evidenceField("test_status 探测异常", err instanceof Error ? err.message : String(err)));
      }
    }

    const output = {
      cancelAccepted: true,
      confirmed,
      confirmationSource,
      probeStatus,
      probeStatusSource,
    };
    if (confirmed) {
      return {
        ...base,
        output,
        rawOutput: rawOutput(),
        // 任务级：后端确认取消（调用级 exec 仍为本次 cancel 调用的进程结果）
        execution: { ...exec, lifecycle: "cancelled" },
        acceptance: {
          status: "passed",
          reason: `取消已确认：${confirmationSource}`,
          pending: false,
          evidence,
        },
      };
    }
    exec = executionFromProcess(result.outcome);
    const klass = classifyTestStatus(probeStatus);
    if (klass === "running") {
      return {
        ...base,
        output,
        rawOutput: rawOutput(),
        execution: exec,
        acceptance: {
          status: "not-run",
          reason: `取消请求已接受但测试仍在运行（test_status=${probeStatus}）：未确认，继续轮询`,
          pending: true,
          evidence,
        },
        followUp: [{ capabilityId: "unity.test-status", hint: "继续轮询确认测试是否停止" }],
      };
    }
    return {
      ...base,
      output,
      rawOutput: rawOutput(),
      execution: exec,
      acceptance: {
        status: "not-run",
        reason:
          klass === "completed"
            ? "取消请求已接受，但测试运行已自行完成（test_status=completed）：取消是否生效无法确认"
            : `取消未确认（探测状态：${probeStatus ?? "未知/缺失"}）：不标记为已取消`,
        pending: false,
        evidence,
      },
      notes: ["cancel_tests 请求被接受不等于取消生效；未确认时不得报告已取消"],
    };
  };

  /* ------------------------------- 注册表 ------------------------------- */

  const registrations: CapabilityRegistration[] = [
    {
      descriptor: {
        id: "unity.doctor",
        version: "0.1.0",
        description: "只读体检：工程 Editor 版本路由、Unity CLI 状态、适配版 com.unity.pipeline 安装状态",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            allowRunningEditor: {
              type: "boolean",
              description: "允许在查询运行中的 Editor 时不失败（默认 false）",
            },
          },
        },
        outputSchema: doctorOutputSchema,
        preconditions: basePreconditions,
        sideEffects: doctorSideEffects,
        resources: READONLY_RESOURCES,
        retry: READONLY_RETRY,
        timeoutMs: 90_000,
        tags: ["unity", "diagnostics", "read-only"],
      },
      implementation: { preconditions: { ...baseChecks }, execute: doctorExecute },
    },
    {
      descriptor: {
        id: "unity.editor-status",
        version: "0.1.0",
        description: '读取当前 Editor 与 Pipeline 连接状态（证据显示就绪值为 status="ready"）',
        inputSchema: execInputSchema(),
        outputSchema: editorStatusOutputSchema,
        preconditions: execPreconditions,
        sideEffects: execSideEffects(false),
        resources: READONLY_RESOURCES,
        retry: READONLY_RETRY,
        timeoutMs: 60_000,
        tags: ["unity", "editor", "read-only"],
      },
      implementation: { preconditions: { ...execChecks }, execute: editorStatusExecute },
    },
    {
      descriptor: {
        id: "unity.compile",
        version: "0.1.0",
        description: "触发脚本重编译（异步）：只报告 accepted，完成判定必须轮询 unity.compile-status",
        inputSchema: execInputSchema(),
        outputSchema: compileOutputSchema,
        preconditions: execPreconditions,
        sideEffects: execSideEffects(true),
        resources: EXEC_RESOURCES,
        retry: TRIGGER_RETRY,
        timeoutMs: 90_000,
        tags: ["unity", "compile", "async-trigger"],
      },
      implementation: { preconditions: { ...execChecks }, execute: compileExecute },
    },
    {
      descriptor: {
        id: "unity.compile-status",
        version: "0.1.0",
        description:
          "读取最近一次重编译状态（idle | triggered | compiling | completed | up_to_date）。观察语义：不证明属于哪次触发——引擎级任何编译（含资产导入等）都会覆写该状态，且跨 Editor 会话残留旧终态",
        inputSchema: execInputSchema(),
        outputSchema: compileStatusOutputSchema,
        preconditions: execPreconditions,
        sideEffects: execSideEffects(false),
        resources: READONLY_RESOURCES,
        retry: READONLY_RETRY,
        timeoutMs: 60_000,
        tags: ["unity", "compile", "status"],
      },
      implementation: { preconditions: { ...execChecks }, execute: compileStatusExecute },
    },
    {
      descriptor: {
        id: "unity.test-start",
        version: "0.1.0",
        description: "启动 Unity Test Runner（固定 --async_tests）：仅报告 accepted，结果用 unity.test-status 轮询",
        inputSchema: execInputSchema({
          mode: {
            type: "string",
            enum: ["EditMode", "PlayMode"],
            description: "测试模式（默认取配置 testMode，再退化为 EditMode）",
          },
          filter: {
            type: "string",
            minLength: 1,
            maxLength: 512,
            description: "命名空间/类名过滤（转发给 Unity CLI --filter）",
          },
        }),
        outputSchema: testStartOutputSchema,
        preconditions: execPreconditions,
        sideEffects: execSideEffects(true),
        resources: EXEC_RESOURCES,
        retry: TRIGGER_RETRY,
        timeoutMs: 90_000,
        tags: ["unity", "test", "async-trigger"],
      },
      implementation: { preconditions: { ...execChecks }, execute: testStartExecute },
    },
    {
      descriptor: {
        id: "unity.test-status",
        version: "0.1.0",
        description:
          "读取最近一次测试运行状态；completed 且失败数 0 且存在有效报告才判定通过。观察语义：不证明属于哪次启动——新启动会顶替旧运行，状态文件跨 Editor 会话残留旧报告",
        inputSchema: execInputSchema(),
        outputSchema: testStatusOutputSchema,
        preconditions: execPreconditions,
        sideEffects: execSideEffects(false),
        resources: READONLY_RESOURCES,
        retry: READONLY_RETRY,
        timeoutMs: 60_000,
        tags: ["unity", "test", "status"],
      },
      implementation: { preconditions: { ...execChecks }, execute: testStatusExecute },
    },
    {
      descriptor: {
        id: "unity.test-cancel",
        version: "0.1.0",
        description: "请求取消测试运行；只有确认（响应字段或 test_status 探测）才判定取消生效",
        inputSchema: execInputSchema({
          verify: { type: "boolean", description: "取消后用 test_status 探测确认（默认 true）" },
        }),
        outputSchema: testCancelOutputSchema,
        preconditions: execPreconditions,
        sideEffects: execSideEffects(true),
        resources: EXEC_RESOURCES,
        retry: TRIGGER_RETRY,
        timeoutMs: 90_000,
        tags: ["unity", "test", "cancel"],
      },
      implementation: { preconditions: { ...execChecks }, execute: testCancelExecute },
    },
  ];

  return {
    id: UNITY_PROVIDER_ID,
    version: UNITY_PROVIDER_VERSION,
    description: "Unity 工程（Windows-first）：体检、Editor 状态、重编译与测试的异步触发/状态/取消",
    binding: unityBindingContract,
    defaultBinding: (project: ProjectRoot) => {
      const warnings: string[] = [];
      const declared = path.join(project.root, "Client");
      if (!fs.existsSync(declared)) {
        warnings.push(
          `bindings.unity.projectDir="Client" 当前不存在：请按工程实际目录修改 ${PROJECT_CLI_CONFIG_RELATIVE} 或用 --binding unity='{...}' 覆盖`,
        );
      }
      return { section: { projectDir: "Client" }, warnings };
    },
    status: async () => {
      const backend = await backendStatus();
      if (backend.available) {
        return {
          state: "available" as const,
          detail: `${UNITY_BACKEND_PACKAGE}@${backend.info.version ?? "?"} 可用`,
          tool: { name: UNITY_BACKEND_COMMAND, version: backend.info.version, path: backend.info.bin },
        };
      }
      const state =
        backend.info.status === "platform-mismatch"
          ? ("platform-mismatch" as const)
          : backend.info.status === "invalid"
            ? ("invalid" as const)
            : ("missing" as const);
      return { state, detail: backend.detail };
    },
    capabilities: () => registrations,
  };
}
