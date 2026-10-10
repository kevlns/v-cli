/**
 * 结构化执行契约：Capability / Provider 描述、请求、结果与状态模型。
 *
 * 核心不变量（由 registry/runtime 强制，测试覆盖）：
 * - 描述（descriptor）在注册时被完整校验：稳定 id、版本、描述、输入/输出 schema、
 *   前置条件、声明的副作用、资源需求、重试语义；注册拒绝重复 id 与错误 schema/元数据。
 * - list/describe 只读描述，绝不执行工具。
 * - 运行时校验真实输入与真实输出（不是 TS 类型），并把结果按契约返回。
 * - 执行状态（execution）与验收状态（acceptance）严格分离：
 *   进程退出码 0 不等于业务验收通过；取消未确认不得标记 cancelled。
 */

import type { ProjectCliConfig } from "../project/config";
import type { ProjectRoot } from "../project/paths";
import type { ExecutionHandle, ExecutionHandleSeed } from "./handle";

/** JSON Schema 子集（本阶段支持的形态，注册时校验） */
export type JsonSchemaType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null";

export interface JsonSchemaObject {
  type: "object";
  description?: string;
  /** true 时允许 null（用于"缺失即 null"的输出字段） */
  nullable?: boolean;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  minProperties?: number;
  maxProperties?: number;
}

export interface JsonSchemaArray {
  type: "array";
  description?: string;
  /** true 时允许 null（用于"缺失即 null"的输出字段） */
  nullable?: boolean;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
}

export interface JsonSchemaString {
  type: "string";
  description?: string;
  /** true 时允许 null（用于"缺失即 null"的输出字段） */
  nullable?: boolean;
  enum?: string[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

export interface JsonSchemaNumber {
  type: "number" | "integer";
  description?: string;
  /** true 时允许 null（用于"缺失即 null"的输出字段） */
  nullable?: boolean;
  enum?: number[];
  minimum?: number;
  maximum?: number;
}

export interface JsonSchemaBoolean {
  type: "boolean";
  description?: string;
  /** true 时允许 null（用于"缺失即 null"的输出字段） */
  nullable?: boolean;
  enum?: boolean[];
}

export interface JsonSchemaNull {
  type: "null";
  description?: string;
  nullable?: boolean;
}

export type JsonSchema =
  | JsonSchemaObject
  | JsonSchemaArray
  | JsonSchemaString
  | JsonSchemaNumber
  | JsonSchemaBoolean
  | JsonSchemaNull;

/** 描述里的前置条件声明（检查实现由 provider 提供，注册时核对一一对应） */
export interface PreconditionDeclaration {
  /** 稳定 id，例如 "unity.pipeline-ready" */
  id: string;
  description: string;
}

export type PreconditionStatus = "satisfied" | "violated" | "skipped" | "unknown";

export interface PreconditionOutcome {
  id: string;
  status: PreconditionStatus;
  detail: string;
  evidence?: Evidence[];
}

/** 副作用声明（运行时实现上报的副作用必须落在声明集合内，否则视为契约违约） */
export type SideEffectKind =
  | "process-exec"
  | "fs-write"
  | "fs-read"
  | "engine-state"
  | "network";

export interface SideEffectDeclaration {
  id: string;
  kind: SideEffectKind;
  description: string;
  reversible: boolean;
}

export interface SideEffectRecord {
  kind: SideEffectKind;
  description: string;
  reversible: boolean;
  details?: Record<string, unknown>;
}

/** 资源需求（声明 + 组织层注入授权；本阶段内核不实现资源锁） */
export type ResourceKind =
  | "project-workspace"
  | "engine-editor"
  | "build-target"
  | "user-cache"
  | "network";

export type ResourceMode = "exclusive" | "shared";

export interface ResourceRequirement {
  kind: ResourceKind;
  mode: ResourceMode;
  scope: "project" | "machine";
  description: string;
}

/** 重试语义（本阶段内核单次尝试；声明供调用方/组织层消费） */
export interface RetrySemantics {
  /** 同一入参重复执行是否安全（幂等/只读） */
  safe: boolean;
  /** >= 1；> 1 表示调用方可重试 */
  maxAttempts: number;
  strategy: "none" | "rerun" | "poll-status";
  description: string;
}

export interface CapabilityDescriptor {
  /** 稳定 capability id，必须带 provider 命名空间前缀（如 unity.compile） */
  id: string;
  /** 语义化版本，如 "0.1.0" */
  version: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  preconditions: PreconditionDeclaration[];
  sideEffects: SideEffectDeclaration[];
  resources: ResourceRequirement[];
  retry: RetrySemantics;
  /** 单次尝试的建议超时（毫秒）；调用方与实现都可进一步收紧 */
  timeoutMs?: number;
  tags?: string[];
}

export interface ProviderInfo {
  id: string;
  version: string;
  description: string;
}

export type ProviderState = "available" | "missing" | "platform-mismatch" | "invalid" | "unavailable";

export interface ProviderStatus {
  state: ProviderState;
  detail: string;
  tool?: { name: string; version?: string; path?: string };
}

/** 执行状态：只描述本次调用本身 */
export type ExecutionStatus = "succeeded" | "failed" | "cancelled" | "unknown";

/**
 * 生命周期：描述底层引擎工作（任务级六态，阶段 C 扩展）：
 * accepted=已接受启动、running=进行中、completed=正常终态、failed=失败终态、
 * cancelled=后端确认取消、unknown=不可解释/不可知。
 */
export type ExecutionLifecycle = "completed" | "accepted" | "running" | "failed" | "cancelled" | "unknown";

/** 验收状态：只描述业务结论 */
export type AcceptanceStatus = "passed" | "failed" | "not-run";

export type ErrorCategory =
  | "request"
  | "config"
  | "precondition"
  | "resource"
  | "process"
  | "protocol"
  | "output"
  | "acceptance"
  | "internal";

export interface StructuredError {
  code: string;
  category: ErrorCategory;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export interface Evidence {
  kind: "process-exit" | "protocol-envelope" | "protocol-field" | "file" | "report" | "probe" | "declared";
  description: string;
  data?: unknown;
}

export interface Artifact {
  kind: "log" | "tool-json" | "report" | "exec-log";
  path: string | null;
  description: string;
  sha256?: string;
  bytes?: number;
}

export interface LogRef {
  bytes: number;
  truncated: boolean;
  sha256: string;
  /** 持久化后的文件名（相对 operation 目录）；未落盘为 null */
  file: string | null;
  /** 便于快速查看的尾部片段 */
  tail: string;
}

export interface ProjectBindingInfo {
  /** 工程根绝对路径（realpath） */
  root: string;
  /** .vant/config/v-cli.json 绝对路径 */
  configFile: string;
  /** 已安全解析的绑定路径（provider id -> 字段名 -> 绝对路径） */
  bindingDirs: Record<string, Record<string, string>>;
}

export interface CapabilityRunResult<Out = unknown> {
  schemaVersion: 1;
  operationId: string;
  capability: { id: string; version: string; description: string };
  provider: ProviderInfo & { tool?: { name: string; version?: string; path?: string } | null };
  project: ProjectBindingInfo;
  invocation: {
    taskId: string | null;
    runId: string | null;
    /** 本次操作的主进程调用（受控 argv；不含 shell 字符串） */
    command: { file: string; args: string[] } | null;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
  };
  execution: {
    status: ExecutionStatus;
    lifecycle: ExecutionLifecycle;
    exitCode: number | null;
    signal: string | null;
    attempts: number;
    error: StructuredError | null;
  };
  /** 异步触发句柄（触发类能力且调用成功时产出；其余为 null） */
  handle: ExecutionHandle | null;
  acceptance: {
    status: AcceptanceStatus;
    reason: string;
    /** true 表示"尚未有结论，应轮询 followUp" */
    pending: boolean;
    evidence: Evidence[];
  };
  preconditions: PreconditionOutcome[];
  resources: {
    declared: ResourceRequirement[];
    authorization: "not-enforced" | "granted" | "denied";
    grantId: string | null;
    denials: { kind: string; reason: string }[];
  };
  sideEffects: SideEffectRecord[];
  artifacts: Artifact[];
  logs: { stdout: LogRef; stderr: LogRef };
  output: Out | null;
  followUp: { capabilityId: string | null; hint: string }[];
  notes: string[];
  warnings: string[];
  persisted: {
    status: "saved" | "disabled" | "failed";
    dir: string | null;
    files: string[];
    error: string | null;
  };
}

/** 资源授权请求（组织层注入的校验钩子输入） */
export interface ResourceAuthorizationRequest {
  operationId: string;
  capabilityId: string;
  providerId: string;
  projectRoot: string;
  taskId: string | null;
  runId: string | null;
  requirements: ResourceRequirement[];
}

export interface ResourceAuthorizationDecision {
  granted: boolean;
  reason?: string;
  grantId?: string;
  denials?: { kind: string; reason: string }[];
}

export type ResourceAuthorizer = (
  request: ResourceAuthorizationRequest,
) => ResourceAuthorizationDecision | Promise<ResourceAuthorizationDecision>;

/** 操作事件记录器（落盘或无操作） */
export interface OperationLogger {
  event(type: string, message: string, data?: unknown): void;
  warn(message: string): void;
}

/** provider 实现可用的执行上下文 */
export interface CapabilityExecutionContext {
  operationId: string;
  projectRoot: string;
  /** 锚定后的工程根（realpath 语义；句柄校验等需要 ProjectRoot 的内核入口直接用它） */
  projectAnchor: ProjectRoot;
  configFile: string;
  /** 已校验的工程级 v-cli 配置（.vant/config/v-cli.json） */
  config: ProjectCliConfig;
  /** 本 provider 的已校验绑定段（无绑定为 null；消费而非重新解析 ctx.config） */
  binding: Record<string, unknown> | null;
  /** 本 provider 的绑定路径（pathField 字段名 -> 绝对路径） */
  bindingDirs: Record<string, string>;
  taskId: string | null;
  runId: string | null;
  signal: AbortSignal;
  log: OperationLogger;
  /** 明确的测试/SDK 不落盘模式 */
  persist: boolean;
  now(): Date;
}

/** 实现返回的结构化结果（内核补全 project/时间/日志/持久化等字段） */
export interface ImplementationOutcome<Out = unknown> {
  execution: {
    status: ExecutionStatus;
    lifecycle: ExecutionLifecycle;
    exitCode?: number | null;
    signal?: string | null;
    error?: StructuredError | null;
  };
  acceptance: {
    status: AcceptanceStatus;
    reason: string;
    pending?: boolean;
    evidence?: Evidence[];
  };
  output?: Out;
  /** 主进程原始输出：由内核落盘为 stdout.log / stderr.log */
  rawOutput?: { stdout: string; stderr: string; stdoutTruncated?: boolean; stderrTruncated?: boolean };
  evidence?: Evidence[];
  artifacts?: Artifact[];
  sideEffects?: SideEffectRecord[];
  followUp?: { capabilityId: string | null; hint: string }[];
  notes?: string[];
  /** 实现实际发起的主进程调用（受控 argv） */
  command?: { file: string; args: string[] } | null;
  /** 工具版本等归属信息 */
  tool?: { name: string; version?: string; path?: string } | null;
  /** 异步触发句柄种子（backendTaskId 等）；内核补全身份与完整性后进入结果 */
  handle?: ExecutionHandleSeed;
}

export type PreconditionChecker = (
  input: Record<string, unknown>,
  ctx: CapabilityExecutionContext,
) => Promise<PreconditionOutcome> | PreconditionOutcome;

export interface CapabilityImplementation {
  /** 与 descriptor.preconditions 一一对应（注册时校验） */
  preconditions?: Record<string, PreconditionChecker>;
  execute(
    input: Record<string, unknown>,
    ctx: CapabilityExecutionContext,
  ): Promise<ImplementationOutcome>;
}

export interface CapabilityRegistration {
  descriptor: CapabilityDescriptor;
  implementation: CapabilityImplementation;
}

/** Provider：状态发现（不执行工具）+ 能力注册 + 自包含绑定契约 */
export interface CapabilityProvider {
  id: string;
  version: string;
  description: string;
  /** 只做发现（读包/读配置），不得执行被包装工具 */
  status(): Promise<ProviderStatus> | ProviderStatus;
  capabilities(): CapabilityRegistration[];
  /** bindings.<providerId> 段的契约：schema + 路径字段声明 + 语义校验与解析 */
  binding: ProviderBindingContract;
  /** 可选：project init 生成默认绑定段（未实现则 init 不为该 provider 生成段） */
  defaultBinding?: ProviderDefaultBinding;
}

/* ------------------------- Provider 绑定契约 ------------------------- */

/** 绑定段中的路径字段声明：核心据此统一做越界/符号链接强核对 */
export interface ProviderPathField {
  /** 绑定段内字段名（须出现在 binding.schema.properties） */
  field: string;
  kind: "dir" | "file";
  required: boolean;
}

export interface ProviderBindingResolutionOk {
  ok: true;
  /** 字段名 -> 已安全解析的绝对路径（kind:"dir" 的 pathFields） */
  dirs: Record<string, string>;
  /** 字段名 -> 已安全解析的绝对路径（kind:"file" 的 pathFields） */
  files: Record<string, string>;
  /** Provider 语义归一后的绑定段（运行期注入 ctx.binding；缺省用原始段） */
  section?: Record<string, unknown>;
  warnings: string[];
}

export interface ProviderBindingResolutionError {
  ok: false;
  errors: string[];
}

export type ProviderBindingResolution = ProviderBindingResolutionOk | ProviderBindingResolutionError;

export interface ProviderBindingResolveInput {
  project: ProjectRoot;
  /** bindings.<providerId> 原始对象 */
  raw: unknown;
  /** 路径解析统一入口（核心注入；"." 表示工程根本身） */
  resolveInsideProject: typeof import("../project/paths").resolveInsideProject;
}

export interface ProviderBindingContract {
  /** bindings.<providerId> 段的 JSON Schema（顶层必须是 object） */
  schema: JsonSchema;
  /** 声明的路径字段（核心对 resolve 结果做重解析强核对；注册表保存冻结快照） */
  pathFields: readonly ProviderPathField[];
  /** 语义校验与解析：字段类型/值域由 Provider 自定，路径必须走注入的 resolveInsideProject */
  resolve(input: ProviderBindingResolveInput): ProviderBindingResolution;
}

/** project init 默认绑定段生成器（可选能力） */
export type ProviderDefaultBinding = (project: ProjectRoot) => {
  section: Record<string, unknown>;
  warnings: string[];
};

export interface CapabilitySummary {
  id: string;
  version: string;
  description: string;
  provider: ProviderInfo;
  tags: string[];
  preconditions: string[];
  sideEffectKinds: SideEffectKind[];
  resources: { kind: ResourceKind; mode: ResourceMode; scope: ResourceRequirement["scope"] }[];
  retry: RetrySemantics;
}
