/**
 * 执行内核（与 commander CLI 分离，可被 SDK/MCP/Agent 直接调用）。
 *
 * 单次运行的生命周期：
 *   锚定工程根 → 读工程配置 → 校验真实输入 → 资源授权（组织层注入）→ 前置条件
 *   → 实现执行 → 校验真实输出与副作用声明 → 组装结果 → 落盘记录
 *
 * 硬性语义：
 * - 进程退出码 0 不代表业务验收通过：验收状态由实现基于证据给出。
 * - 取消只有确认（观察到子进程终止）才标记 cancelled，否则 unknown。
 * - 前置条件 violated/unknown 一律 fail-closed，不执行。
 * - 未注册 capability / 工程根不可用 / 配置缺失或非法 / operationId 非法或已存在
 *   属于请求级失败：抛 CapabilityError（CLI 输出稀疏错误对象，退出码 2）。
 */

import {
  CapabilityError,
  structuredError,
  toStructuredError,
} from "./errors";
import { validateValue } from "./json-schema";
import type { CapabilityRegistry } from "./registry";
import type { ProcessOutcome } from "./executor";
import type {
  AcceptanceStatus,
  Artifact,
  CapabilityRunResult,
  ErrorCategory,
  Evidence,
  ExecutionLifecycle,
  ExecutionStatus,
  ImplementationOutcome,
  LogRef,
  OperationLogger,
  PreconditionOutcome,
  ResourceAuthorizationDecision,
  ResourceAuthorizer,
  SideEffectRecord,
  StructuredError,
} from "./types";
import { loadProjectConfig, PROJECT_CLI_CONFIG_RELATIVE, toProviderSet, type ResolvedProviderBinding } from "../project/config";
import { buildExecutionHandle, validateHandleSeed, type ExecutionHandle } from "./handle";
import { generateOperationId, OperationExistsError, OperationStore, validateOperationId } from "../project/operation-store";
import { redactSecrets } from "../project/redact";
import { PathSafetyError, resolveProjectRoot, type ProjectRoot } from "../project/paths";

export interface CapabilityRunRequest {
  capabilityId: string;
  /** 显式工程根（--project）；缺省用 cwd */
  projectRoot?: string;
  cwd?: string;
  input?: Record<string, unknown>;
  operationId?: string;
  taskId?: string;
  runId?: string;
  /** false = 不落盘模式（测试/SDK 探测）；默认 true */
  persist?: boolean;
  signal?: AbortSignal;
  /** 组织层注入的资源授权校验（本阶段内核不实现资源锁） */
  authorize?: ResourceAuthorizer;
}

export interface CapabilityRuntimeDeps {
  /** 注入时钟（测试确定化） */
  clock?: () => Date;
  /** 内核警告出口（默认 stderr） */
  warn?: (message: string) => void;
}

/**
 * 把进程执行结果规范化为执行状态：
 * 超时/未确认取消一律 unknown（业务结论不可知），确认取消才是 cancelled。
 */
export function executionFromProcess(
  outcome: ProcessOutcome,
  options: { failureCode?: string } = {},
): {
  status: ExecutionStatus;
  lifecycle: ExecutionLifecycle;
  exitCode: number | null;
  signal: string | null;
  error: StructuredError | null;
} {
  const base = {
    exitCode: outcome.exitCode,
    signal: outcome.signal,
  };
  if (outcome.error) {
    return {
      ...base,
      status: "failed",
      lifecycle: "unknown",
      error: structuredError(
        "process-spawn-failed",
        "process",
        `进程启动失败: ${outcome.error.message}`,
        { details: { code: outcome.error.code }, retryable: false },
      ),
    };
  }
  if (outcome.timedOut) {
    return {
      ...base,
      status: "unknown",
      lifecycle: "unknown",
      error: structuredError(
        "process-timeout",
        "process",
        "进程超时已被终止：底层工作可能仍在进行，业务结论未知",
        { details: { exitCode: outcome.exitCode, signal: outcome.signal }, retryable: true },
      ),
    };
  }
  if (outcome.aborted) {
    if (outcome.killConfirmed) {
      return { ...base, status: "cancelled", lifecycle: "unknown", error: null };
    }
    return {
      ...base,
      status: "unknown",
      lifecycle: "unknown",
      error: structuredError(
        "cancel-unconfirmed",
        "process",
        "取消请求已发出但未观察到子进程终止：不得标记为已取消",
        { retryable: true },
      ),
    };
  }
  if (outcome.exitCode === 0) {
    return { ...base, status: "succeeded", lifecycle: "completed", error: null };
  }
  if (outcome.exitCode === null) {
    return {
      ...base,
      status: "unknown",
      lifecycle: "unknown",
      error: structuredError("process-exit-unknown", "process", "子进程结束但未取得退出码", {
        retryable: true,
      }),
    };
  }
  return {
    ...base,
    status: "failed",
    lifecycle: "completed",
    error: structuredError(
      options.failureCode ?? "process-exit-nonzero",
      "process",
      `进程非零退出（exit=${outcome.exitCode}）`,
      { details: { exitCode: outcome.exitCode, stderrTail: outcome.stderr.slice(-1000) } },
    ),
  };
}

const EXECUTION_STATUSES = ["succeeded", "failed", "cancelled", "unknown"];
const LIFECYCLES = ["completed", "accepted", "running", "failed", "cancelled", "unknown"];
const ACCEPTANCE_STATUSES = ["passed", "failed", "not-run"];

/**
 * 校验实现返回的结构（注册期之外的运行期第二道关）：
 * SDK 是公开面，第三方 provider 的畸形返回必须是结构化契约违约，而不是内核崩溃。
 */
function validateOutcomeShape(outcome: unknown): string[] {
  const errors: string[] = [];
  if (typeof outcome !== "object" || outcome === null) return ["实现返回的不是对象"];
  const value = outcome as ImplementationOutcome;
  const execution = value.execution as { status?: unknown; lifecycle?: unknown } | undefined;
  if (typeof execution !== "object" || execution === null) {
    errors.push("缺少 execution");
  } else {
    if (typeof execution.status !== "string" || !EXECUTION_STATUSES.includes(execution.status)) {
      errors.push(`execution.status 必须是 [${EXECUTION_STATUSES.join(", ")}] 之一`);
    }
    if (typeof execution.lifecycle !== "string" || !LIFECYCLES.includes(execution.lifecycle)) {
      errors.push(`execution.lifecycle 必须是 [${LIFECYCLES.join(", ")}] 之一`);
    }
  }
  const acceptance = value.acceptance as { status?: unknown; reason?: unknown } | undefined;
  if (typeof acceptance !== "object" || acceptance === null) {
    errors.push("缺少 acceptance");
  } else {
    if (typeof acceptance.status !== "string" || !ACCEPTANCE_STATUSES.includes(acceptance.status)) {
      errors.push(`acceptance.status 必须是 [${ACCEPTANCE_STATUSES.join(", ")}] 之一`);
    }
    if (typeof acceptance.reason !== "string") {
      errors.push("acceptance.reason 必须是字符串");
    }
  }
  return errors;
}

/**
 * 结果 → 进程退出码（与 JSON 契约对齐）。
 * 顺序很重要：请求级失败 → 2；执行未成功按执行状态给码；**0 只在执行 succeeded 且验收 passed 时出现**
 * （验收 passed 永远不能覆盖失败/未知的执行状态）。
 */
export function exitCodeForResult(result: CapabilityRunResult): number {
  const errorCategory: ErrorCategory | undefined = result.execution.error?.category;
  if (
    errorCategory === "request" ||
    errorCategory === "config" ||
    errorCategory === "precondition" ||
    errorCategory === "resource"
  ) {
    return 2;
  }
  if (result.execution.status === "cancelled") return 4;
  if (result.execution.status === "unknown") return 5;
  if (result.execution.status === "failed") return 1;
  if (result.acceptance.status === "failed") return 1;
  if (result.acceptance.status === "passed") return 0;
  return 3;
}

function mergeEvidence(...groups: (Evidence[] | undefined)[]): Evidence[] {
  const out: Evidence[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const item of group ?? []) {
      const key = `${item.kind}:${item.description}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

interface BuildInput {
  entry: NonNullable<ReturnType<CapabilityRegistry["get"]>>;
  operationId: string;
  project: ProjectRoot;
  configFile: string;
  bindingDirs: Record<string, Record<string, string>>;
  taskId: string | null;
  runId: string | null;
  startedAt: Date;
  command: { file: string; args: string[] } | null;
  execution: CapabilityRunResult["execution"];
  handle: ExecutionHandle | null;
  acceptance: CapabilityRunResult["acceptance"];
  preconditions: PreconditionOutcome[];
  resources: CapabilityRunResult["resources"];
  sideEffects: SideEffectRecord[];
  artifacts: Artifact[];
  logs: { stdout: LogRef; stderr: LogRef };
  output: unknown;
  followUp: { capabilityId: string | null; hint: string }[];
  notes: string[];
  warnings: string[];
  tool: { name: string; version?: string; path?: string } | null;
  persisted: CapabilityRunResult["persisted"];
  finishedAt: Date;
}

function buildResult(input: BuildInput): CapabilityRunResult {
  const providerTool = input.tool;
  return {
    schemaVersion: 1,
    operationId: input.operationId,
    capability: {
      id: input.entry.descriptor.id,
      version: input.entry.descriptor.version,
      description: input.entry.descriptor.description,
    },
    provider: {
      ...input.entry.provider,
      tool: providerTool ?? null,
    },
    project: {
      root: input.project.realRoot,
      configFile: input.configFile,
      bindingDirs: input.bindingDirs,
    },
    invocation: {
      taskId: input.taskId,
      runId: input.runId,
      command: input.command,
      startedAt: input.startedAt.toISOString(),
      finishedAt: input.finishedAt.toISOString(),
      durationMs: input.finishedAt.getTime() - input.startedAt.getTime(),
    },
    execution: input.execution,
    handle: input.handle,
    acceptance: input.acceptance,
    preconditions: input.preconditions,
    resources: input.resources,
    sideEffects: input.sideEffects,
    artifacts: input.artifacts,
    logs: input.logs,
    output: input.output ?? null,
    followUp: input.followUp,
    notes: input.notes,
    warnings: input.warnings,
    persisted: input.persisted,
  };
}

function emptyLogs(): { stdout: LogRef; stderr: LogRef } {
  const empty: LogRef = { bytes: 0, truncated: false, sha256: "", file: null, tail: "" };
  return { stdout: empty, stderr: empty };
}

/** 执行一个 capability（唯一入口；CLI 与 SDK 共用） */
export async function runCapability(
  registry: CapabilityRegistry,
  request: CapabilityRunRequest,
  deps: CapabilityRuntimeDeps = {},
): Promise<CapabilityRunResult> {
  const clock = deps.clock ?? (() => new Date());
  const warn = deps.warn ?? ((message: string) => process.stderr.write(`[v-cli] 警告: ${message}\n`));

  const entry = registry.get(request.capabilityId);
  if (!entry) {
    throw new CapabilityError(
      structuredError(
        "capability-unknown",
        "request",
        `未注册的 capability: ${request.capabilityId}（用 \`v-cli capability list\` 查看可用能力）`,
      ),
    );
  }

  let project: ProjectRoot;
  try {
    project = resolveProjectRoot(request.projectRoot, request.cwd ?? process.cwd());
  } catch (err) {
    if (err instanceof PathSafetyError) {
      throw new CapabilityError(structuredError(err.code, "request", err.message));
    }
    throw err;
  }

  const loadedConfig = loadProjectConfig(project, toProviderSet(registry.listProviders()));
  if (!loadedConfig.ok) {
    const code =
      loadedConfig.kind === "missing"
        ? "project-config-missing"
        : loadedConfig.kind === "unsafe-binding"
          ? "project-config-unsafe-binding"
          : "project-config-invalid";
    const detail = loadedConfig.errors.length > 0 ? `（${loadedConfig.errors.join("；")}）` : "";
    throw new CapabilityError(
      structuredError(code, "config", `工程配置 ${PROJECT_CLI_CONFIG_RELATIVE} 不可用${detail}`, {
        details: { file: loadedConfig.file, hint: loadedConfig.hint, errors: loadedConfig.errors },
      }),
    );
  }

  const startedAt = clock();
  const operationId = request.operationId ?? generateOperationId(entry.descriptor.id, startedAt);
  const idErrors = validateOperationId(operationId);
  if (idErrors.length > 0) {
    throw new CapabilityError(structuredError("operation-id-invalid", "request", idErrors.join("；")));
  }

  const persist = request.persist !== false;
  let store: OperationStore;
  try {
    store = persist ? OperationStore.reserve(project, operationId, startedAt) : OperationStore.disabled(operationId);
  } catch (err) {
    if (err instanceof OperationExistsError) {
      throw new CapabilityError(structuredError("operation-exists", "request", err.message));
    }
    if (err instanceof PathSafetyError) {
      throw new CapabilityError(structuredError(err.code, "request", err.message));
    }
    throw err;
  }

  const input = request.input ?? {};
  const redacted = redactSecrets(input);
  store.writeInput({
    schemaVersion: 1,
    operationId,
    capability: { id: entry.descriptor.id, version: entry.descriptor.version },
    project: { root: project.realRoot, configFile: loadedConfig.file },
    taskId: request.taskId ?? null,
    runId: request.runId ?? null,
    recordedAt: startedAt.toISOString(),
    input: redacted.value,
    redactedPaths: redacted.redactedPaths,
  });
  const providerBinding: ResolvedProviderBinding | undefined = loadedConfig.resolved[entry.provider.id];
  const providerBindingDirs = providerBinding ? { ...providerBinding.dirs, ...providerBinding.files } : {};
  const allBindingDirs: Record<string, Record<string, string>> = Object.fromEntries(
    Object.entries(loadedConfig.resolved).map(([id, resolved]) => [id, { ...resolved.dirs, ...resolved.files }]),
  );
  store.event("config-loaded", `已加载工程配置 ${PROJECT_CLI_CONFIG_RELATIVE}`, {
    bindingDirs: allBindingDirs,
    unboundProviders: loadedConfig.unbound,
  });

  const signal = request.signal ?? new AbortController().signal;
  const logger: OperationLogger = {
    event: (type, message, data) => store.event(type, message, data),
    warn: (message) => store.warn(message),
  };
  const context = {
    operationId,
    projectRoot: project.realRoot,
    projectAnchor: project,
    configFile: loadedConfig.file,
    config: loadedConfig.config,
    binding: providerBinding ? providerBinding.section : null,
    bindingDirs: providerBindingDirs,
    taskId: request.taskId ?? null,
    runId: request.runId ?? null,
    signal,
    log: logger,
    persist,
    now: clock,
  };

  let executionHandle: ExecutionHandle | null = null;

  const finish = (
    partial: Omit<BuildInput, "entry" | "operationId" | "project" | "configFile" | "bindingDirs" | "taskId" | "runId" | "startedAt" | "persisted" | "finishedAt" | "handle"> & {
      persisted?: CapabilityRunResult["persisted"];
      handle?: ExecutionHandle | null;
    },
  ): CapabilityRunResult => {
    const result = buildResult({
      entry,
      operationId,
      project,
      configFile: loadedConfig.file,
      bindingDirs: allBindingDirs,
      handle: partial.handle !== undefined ? partial.handle : executionHandle,
      taskId: request.taskId ?? null,
      runId: request.runId ?? null,
      startedAt,
      persisted: partial.persisted ?? {
        status: persist ? "saved" : "disabled",
        dir: store.dir,
        files: store.dir ? [...store.persistedFiles, "result.json"] : [],
        error: null,
      },
      finishedAt: clock(),
      ...partial,
    });
    if (request.persist === false) return result;
    store.writeResult(result);
    if (store.failureMessage) {
      result.persisted.status = "failed";
      result.persisted.error = store.failureMessage;
      warn(`操作记录写入不完整: ${store.failureMessage}`);
      store.writeResult(result);
    }
    return result;
  };

  const cancelledBeforeExecution = (): CapabilityRunResult => finish({
    command: null, execution: { status: "cancelled", lifecycle: "completed", exitCode: null, signal: null, attempts: 0, error: null },
    acceptance: { status: "not-run", reason: "执行前已取消，未触发操作", pending: false, evidence: [] },
    preconditions: [], resources: { declared: entry.descriptor.resources, authorization: "not-enforced", grantId: null, denials: [] },
    sideEffects: [], artifacts: [], logs: emptyLogs(), output: null, followUp: [], notes: [], warnings: [], tool: null,
  });
  if (signal.aborted) return cancelledBeforeExecution();
  // 1) 真实输入校验（不是 TS 类型检查）
  const inputErrors = validateValue(input, entry.descriptor.inputSchema, "$input");
  if (inputErrors.length > 0) {
    store.event("input-invalid", "输入不符合 schema，未执行", { errors: inputErrors });
    return finish({
      command: null,
      execution: {
        status: "failed",
        lifecycle: "completed",
        exitCode: null,
        signal: null,
        attempts: 0,
        error: structuredError("input-invalid", "request", `输入不符合 ${entry.descriptor.id} 的输入 schema`, {
          details: { errors: inputErrors },
        }),
      },
      acceptance: {
        status: "not-run",
        reason: "输入未通过校验，未执行",
        pending: false,
        evidence: [],
      },
      preconditions: [],
      resources: {
        declared: entry.descriptor.resources,
        authorization: "not-enforced",
        grantId: null,
        denials: [],
      },
      sideEffects: [],
      artifacts: [],
      logs: emptyLogs(),
      output: null,
      followUp: [],
      notes: [],
      warnings: [],
      tool: null,
    });
  }
  store.event("input-validated", "输入通过 schema 校验");

  // 2) 资源授权（组织层注入；内核不假装实现了资源锁）
  let authorization: CapabilityRunResult["resources"] = {
    declared: entry.descriptor.resources,
    authorization: "not-enforced",
    grantId: null,
    denials: [],
  };
  if (request.authorize) {
    let decision: ResourceAuthorizationDecision;
    try {
      decision = await request.authorize({
        operationId,
        capabilityId: entry.descriptor.id,
        providerId: entry.provider.id,
        projectRoot: project.realRoot,
        taskId: request.taskId ?? null,
        runId: request.runId ?? null,
        requirements: entry.descriptor.resources,
      });
    } catch (err) {
      store.event("authorize-error", "资源授权钩子抛出异常");
      return finish({
        command: null,
        execution: {
          status: "failed",
          lifecycle: "completed",
          exitCode: null,
          signal: null,
          attempts: 0,
          error: structuredError("resource-authorization-error", "resource", toStructuredError(err).message),
        },
        acceptance: { status: "not-run", reason: "资源授权校验失败，未执行", pending: false, evidence: [] },
        preconditions: [],
        resources: { ...authorization, authorization: "denied", denials: [] },
        sideEffects: [],
        artifacts: [],
        logs: emptyLogs(),
        output: null,
        followUp: [],
        notes: [],
        warnings: [],
        tool: null,
      });
    }
    if (decision?.granted === true) {
      authorization = {
        declared: entry.descriptor.resources,
        authorization: "granted",
        grantId: decision.grantId ?? null,
        denials: [],
      };
      store.event("authorized", `资源授权通过${decision.grantId ? `（grant ${decision.grantId}）` : ""}`);
    } else {
      authorization = {
        declared: entry.descriptor.resources,
        authorization: "denied",
        grantId: null,
        denials: decision?.denials ?? [],
      };
      store.event("authorize-denied", decision?.reason ?? "资源授权被拒绝");
      return finish({
        command: null,
        execution: {
          status: "failed",
          lifecycle: "completed",
          exitCode: null,
          signal: null,
          attempts: 0,
          error: structuredError("resource-denied", "resource", decision?.reason ?? "资源授权被拒绝", {
            details: { denials: decision?.denials ?? [], requirements: entry.descriptor.resources },
          }),
        },
        acceptance: { status: "not-run", reason: "资源未获授权，未执行", pending: false, evidence: [] },
        preconditions: [],
        resources: authorization,
        sideEffects: [],
        artifacts: [],
        logs: emptyLogs(),
        output: null,
        followUp: [],
        notes: [],
        warnings: [],
        tool: null,
      });
    }
  }

  // 3) 前置条件（fail-closed：violated / unknown 都不执行）
  const preconditionOutcomes: PreconditionOutcome[] = [];
  for (const declaration of entry.descriptor.preconditions) {
    if (signal.aborted) return cancelledBeforeExecution();
    const checker = entry.implementation.preconditions?.[declaration.id];
    if (!checker) {
      preconditionOutcomes.push({
        id: declaration.id,
        status: "unknown",
        detail: "缺少前置条件检查实现",
      });
      continue;
    }
    try {
      const outcome = await checker(input, context);
      if (!outcome || outcome.id !== declaration.id || !["satisfied", "violated"].includes(outcome.status) || typeof outcome.detail !== "string") {
        preconditionOutcomes.push({ id: declaration.id, status: "unknown", detail: "前置条件未明确满足或返回不符合声明" });
      } else { preconditionOutcomes.push(outcome); }
      store.event("precondition", `${declaration.id}: ${outcome.status}`, { detail: outcome.detail });
    } catch (err) {
      preconditionOutcomes.push({
        id: declaration.id,
        status: "unknown",
        detail: `检查抛出异常: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  const blocking = preconditionOutcomes.filter((o) => o.status === "violated" || o.status === "unknown");
  if (blocking.length > 0) {
    return finish({
      command: null,
      execution: {
        status: "failed",
        lifecycle: "completed",
        exitCode: null,
        signal: null,
        attempts: 0,
        error: structuredError(
          "precondition-failed",
          "precondition",
          `前置条件未满足，未执行：${blocking.map((b) => `${b.id}(${b.status})`).join(", ")}`,
          { details: { outcomes: blocking } },
        ),
      },
      acceptance: {
        status: "not-run",
        reason: "前置条件未满足，未执行",
        pending: false,
        evidence: mergeEvidence(...blocking.map((b) => b.evidence)),
      },
      preconditions: preconditionOutcomes,
      resources: authorization,
      sideEffects: [],
      artifacts: [],
      logs: emptyLogs(),
      output: null,
      followUp: [],
      notes: [],
      warnings: [],
      tool: null,
    });
  }

  if (signal.aborted) return cancelledBeforeExecution();
  // 4) 执行
  store.event("execute-start", `开始执行 ${entry.descriptor.id}`);
  let outcome: ImplementationOutcome;
  try {
    outcome = await entry.implementation.execute(input, context);
  } catch (err) {
    const error = toStructuredError(err);
    store.event("execute-threw", error.message);
    outcome = {
      execution: { status: "failed", lifecycle: "unknown", exitCode: null, signal: null, error },
      acceptance: {
        status: "not-run",
        reason: "实现抛出异常，未产生业务结论",
        pending: false,
        evidence: [],
      },
    };
  }
  // 4b) 实现返回的形状校验（SDK 是公开面：畸形实现不得污染结果契约）
  const shapeErrors = validateOutcomeShape(outcome);
  const shapeError =
    shapeErrors.length > 0
      ? structuredError("implementation-contract-violation", "internal", "实现返回的结果不符合内核契约", {
          details: { errors: shapeErrors },
        })
      : null;
  // 畸形返回已归类为契约违约：后续一律走规范化对象，避免内核崩溃
  const safeOutcome: ImplementationOutcome =
    typeof outcome === "object" && outcome !== null ? outcome : ({} as ImplementationOutcome);
  store.event(
    "execute-finish",
    `执行状态 ${safeOutcome.execution?.status ?? "?"}/${safeOutcome.execution?.lifecycle ?? "?"}`,
  );
  if (shapeError) store.event("implementation-contract-violation", shapeError.message, { errors: shapeErrors });

  const execution = {
    status: safeOutcome.execution?.status ?? "unknown",
    lifecycle: safeOutcome.execution?.lifecycle ?? "unknown",
    exitCode: safeOutcome.execution?.exitCode ?? null,
    signal: safeOutcome.execution?.signal ?? null,
    attempts: 1,
    error: shapeError ?? safeOutcome.execution?.error ?? null,
  };

  // 5) 真实输出 + 副作用声明核对
  let output = safeOutcome.output;
  const warnings: string[] = [];
  const notes = Array.isArray(safeOutcome.notes) ? [...safeOutcome.notes] : [];
  let contractError: StructuredError | null = shapeError;

  const shouldValidateOutput = !shapeError && (output !== undefined || execution.status === "succeeded");
  if (shouldValidateOutput) {
    const outputErrors = validateValue(output, entry.descriptor.outputSchema, "$output");
    if (outputErrors.length > 0) {
      contractError = structuredError(
        output === undefined ? "output-missing" : "output-contract-violation",
        "output",
        `输出不符合 ${entry.descriptor.id} 的输出 schema`,
        { details: { errors: outputErrors } },
      );
      store.event("output-invalid", contractError.message, { errors: outputErrors });
    } else {
      store.event("output-validated", "输出通过 schema 校验");
    }
  }

  const sideEffects = Array.isArray(safeOutcome.sideEffects) ? [...safeOutcome.sideEffects] : [];
  const declaredKinds = new Set(entry.descriptor.sideEffects.map((s) => s.kind));
  const undeclared = sideEffects.filter((s) => !declaredKinds.has(s.kind));
  if (undeclared.length > 0) {
    const message = `实现上报了未声明的副作用类型: ${[...new Set(undeclared.map((u) => u.kind))].join(", ")}`;
    contractError ??= structuredError("side-effect-undeclared", "output", message, { details: { undeclared } });
    store.event("side-effect-undeclared", message);
  }

  // 句柄种子形状校验（在 executionFinal 之前并入契约违约链：坏契约数据不得流入公开结果）
  const handleSeed = safeOutcome.handle;
  const seedErrors = handleSeed === undefined ? [] : validateHandleSeed(handleSeed);
  if (seedErrors.length > 0) {
    const seedError = structuredError("handle-seed-invalid", "internal", `实现提供的句柄种子非法: ${seedErrors.join("；")}`);
    contractError ??= seedError;
    store.event("handle-seed-invalid", seedError.message);
  }

  const executionFinal = contractError
    ? {
        status: "unknown" as ExecutionStatus,
        lifecycle: "unknown" as ExecutionLifecycle,
        exitCode: execution.exitCode,
        signal: execution.signal,
        attempts: 1,
        error: contractError,
      }
    : execution;

  // 异步触发句柄：Provider 种子形状合法且本次调用成功时由内核补全（身份字段以内核为准）
  if (
    seedErrors.length === 0 &&
    handleSeed !== undefined &&
    executionFinal.status === "succeeded"
  ) {
    executionHandle = buildExecutionHandle({
      seed: handleSeed,
      providerId: entry.provider.id,
      capabilityId: entry.descriptor.id,
      operationId,
      project,
      configFile: loadedConfig.file,
      startedAt: startedAt.toISOString(),
      persisted: persist,
    });
    store.event("handle-issued", "异步执行句柄已产出", {
      originOperationId: operationId,
      backendTaskId: executionHandle.backendTaskId,
      recoverable: executionHandle.recoverable,
    });
  }

  const outcomeAcceptance = safeOutcome.acceptance as
    | { status?: AcceptanceStatus; reason?: string; pending?: boolean; evidence?: Evidence[] }
    | undefined;
  const acceptance = {
    // 实现返回违约时一律不给验收结论（哪怕它自称 passed 并带了证据）
    status: shapeError ? ("not-run" as AcceptanceStatus) : outcomeAcceptance?.status ?? ("not-run" as AcceptanceStatus),
    reason: shapeError
      ? "实现返回不符合内核契约，无验收结论"
      : outcomeAcceptance?.reason ?? "实现未给出验收理由",
    pending: false,
    evidence: mergeEvidence(outcomeAcceptance?.evidence, safeOutcome.evidence),
  };
  if (!shapeError && outcomeAcceptance?.pending === true) acceptance.pending = true;
  if (
    !shapeError &&
    outcomeAcceptance?.status === "passed" &&
    (executionFinal.status !== "succeeded" ||
      executionFinal.lifecycle === "accepted" ||
      executionFinal.lifecycle === "unknown" ||
      acceptance.pending ||
      signal.aborted)
  ) {
    // 防御红线：调用未成功、任务仅被接受（启动≠通过）或状态不可解释时，不得给出 passed。
    // 任务级 running/failed/cancelled 允许 passed——状态/查询/取消类能力的验收目标是
    // 观察或关联成立，不是任务业务通过（如 cancel 的 passed=取消已确认生效）。
    acceptance.status = "not-run";
    acceptance.reason = `执行状态 ${executionFinal.status}/${executionFinal.lifecycle}，实现给出的 passed 被内核降级为 not-run`;
    acceptance.pending = false;
    store.event("acceptance-downgraded", acceptance.reason);
  }
  if (acceptance.status === "passed" && acceptance.evidence.length === 0) {
    acceptance.status = "not-run";
    acceptance.reason = "验收结论缺少证据，内核拒绝给出 passed";
    acceptance.pending = false;
    store.event("acceptance-downgraded", acceptance.reason);
  }

  // 6) 原始输出落盘（stdout/stderr + 证据引用）
  const raw = safeOutcome.rawOutput ?? { stdout: "", stderr: "" };
  const logs = store.writeLogs({
    stdout: typeof raw.stdout === "string" ? raw.stdout : "",
    stderr: typeof raw.stderr === "string" ? raw.stderr : "",
    stdoutTruncated: raw.stdoutTruncated,
    stderrTruncated: raw.stderrTruncated,
  });

  const artifacts: Artifact[] = Array.isArray(safeOutcome.artifacts) ? [...safeOutcome.artifacts] : [];
  if (logs.stdout.bytes > 0 && !artifacts.some((a) => a.kind === "log" && a.path === logs.stdout.file)) {
    artifacts.push({
      kind: "log",
      path: logs.stdout.file,
      description: "主进程 stdout 原文",
      sha256: logs.stdout.sha256,
      bytes: logs.stdout.bytes,
    });
  }
  if (logs.stderr.bytes > 0 && !artifacts.some((a) => a.kind === "log" && a.path === logs.stderr.file)) {
    artifacts.push({
      kind: "log",
      path: logs.stderr.file,
      description: "主进程 stderr 原文",
      sha256: logs.stderr.sha256,
      bytes: logs.stderr.bytes,
    });
  }

  return finish({
    command: safeOutcome.command ?? null,
    execution: executionFinal,
    acceptance,
    preconditions: preconditionOutcomes,
    resources: authorization,
    sideEffects,
    artifacts,
    logs,
    output,
    followUp: Array.isArray(safeOutcome.followUp) ? safeOutcome.followUp : [],
    notes,
    warnings,
    tool: safeOutcome.tool ?? null,
  });
}

/** 便捷封装：把结构化结果序列化为稳定 JSON 文本（CLI/SDK 共用） */
export function formatResultJson(result: CapabilityRunResult): string {
  return JSON.stringify(result, null, 2);
}
