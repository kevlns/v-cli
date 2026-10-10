/**
 * @kevlns/v-cli SDK：结构化 capability 注册/执行内核的公开出口。
 *
 * 用途：后续 MCP / Agent / Vant 组织层可直接 import 本模块，复用
 * 注册表、执行内核、工程配置与操作记录，而无需经过 commander CLI。
 *
 * 稳定性：SDK 出口以本文件为准（package.json exports["."] → dist/sdk.mjs + dist/sdk.d.ts）。
 * 导出面外的内部模块（src/commands/*、src/core/loader 等）不属于公开 API。
 */

export type {
  AcceptanceStatus,
  Artifact,
  CapabilityDescriptor,
  CapabilityExecutionContext,
  CapabilityImplementation,
  CapabilityProvider,
  CapabilityRegistration,
  CapabilityRunResult,
  CapabilitySummary,
  ErrorCategory,
  Evidence,
  ExecutionLifecycle,
  ExecutionStatus,
  ImplementationOutcome,
  JsonSchema,
  JsonSchemaArray,
  JsonSchemaBoolean,
  JsonSchemaNull,
  JsonSchemaNumber,
  JsonSchemaObject,
  JsonSchemaString,
  JsonSchemaType,
  LogRef,
  OperationLogger,
  PreconditionChecker,
  PreconditionDeclaration,
  PreconditionOutcome,
  ProjectBindingInfo,
  ProviderInfo,
  ProviderState,
  ProviderStatus,
  ResourceAuthorizationDecision,
  ResourceAuthorizationRequest,
  ResourceAuthorizer,
  ResourceKind,
  ResourceMode,
  ResourceRequirement,
  RetrySemantics,
  SideEffectDeclaration,
  SideEffectKind,
  SideEffectRecord,
  StructuredError,
} from "./core/execution/types";

export {
  CapabilityRegistrationError,
  CapabilityError,
  structuredError,
  toStructuredError,
} from "./core/execution/errors";

export {
  CapabilityRegistry,
  validateCapability,
  validateProvider,
} from "./core/execution/registry";

export {
  exitCodeForResult,
  executionFromProcess,
  formatResultJson,
  runCapability,
  type CapabilityRunRequest,
  type CapabilityRuntimeDeps,
} from "./core/execution/runtime";

export { NodeProcessExecutor } from "./core/execution/executor";
export type { ProcessExecutor, ProcessInvocation, ProcessOutcome } from "./core/execution/executor";

export { createDefaultRegistry, type DefaultRegistryOptions } from "./core/execution/default-registry";

export {
  JSON_TYPES,
  validateSchemaDefinition,
  validateValue,
} from "./core/execution/json-schema";

export {
  UNITY_PROVIDER_ID,
  UNITY_PROVIDER_VERSION,
  buildDoctorArgv,
  buildExecArgv,
  createUnityProvider,
  type UnityProviderDeps,
} from "./providers/unity";

export {
  OPERATIONS_RELATIVE,
  PROJECT_CLI_CONFIG_RELATIVE,
  VANT_PROJECT_CONFIG_RELATIVE,
  initProjectConfig,
  inspectProject,
  loadProjectConfig,
  renderDefaultConfig,
  validateProjectCliConfig,
  type InitProjectConfigResult,
  type LoadProjectConfigResult,
  type ProjectCliConfig,
  type ProjectInspection,
  type UnityBinding,
  type UnityTestMode,
} from "./core/project/config";

export {
  PathSafetyError,
  resolveInsideProject,
  resolveProjectRoot,
  splitSafeRelative,
  type ProjectRoot,
} from "./core/project/paths";

export {
  OperationExistsError,
  OperationStore,
  generateOperationId,
  validateOperationId,
  type OperationSummary,
} from "./core/project/operation-store";

export { REDACTION_PLACEHOLDER, redactArgv, redactSecrets } from "./core/project/redact";

export { VERSION } from "./version";
