import { figmaCommandRegistrations } from "./commands";
/**
 * Figma 结构化适配：doctor/contract 使用无凭据的托管配置进行离线核对；
 * 配置、导出、转换器管理与构建使用工具的 JSON 回执。
 * 目标路径来自工程绑定，源数据到 IR 与预制体的转换由 Unity C# 工具完成。
 */

import fs from "node:fs";
import path from "node:path";
import { OFFICIAL_PLUGINS, discoverOfficialPlugin, type OfficialPluginInfo } from "../../core/official";
import { executionFromProcess } from "../../core/execution/runtime";
import { structuredError } from "../../core/execution/errors";
import type { ProcessExecutor, ProcessOutcome } from "../../core/execution/executor";
import type {
  CapabilityExecutionContext,
  CapabilityProvider,
  CapabilityRegistration,
  Evidence,
  ImplementationOutcome,
  JsonSchema,
  PreconditionChecker,
  ProviderBindingContract,
} from "../../core/execution/types";
import { parseContractOutput, parseDoctorOutput, parseToolError } from "./protocol";

export const FIGMA_PROVIDER_ID = "figma";
export const FIGMA_PROVIDER_VERSION = "0.1.0";
const FIGMA_BACKEND_PACKAGE = "@kevlns/figma-to-uprefab";
const FIGMA_BACKEND_COMMAND = "figma";
/** 插件的默认 staging root（相对 Unity 工程）：errors.ts DEFAULT_STAGING_ROOT */
const DEFAULT_STAGING_ROOT_SEGMENTS = "Assets/Arts/Game/FigmaAssets/_Staging";
/** 托管配置落点（工程内、.vant/state 已不入 Git） */
const MANAGED_CONFIG_RELATIVE = ".vant/state/figma/user-config.json";

/** bindings.figma 绑定段（Provider 自包含契约） */
export interface FigmaBinding {
  /** 相对 v-cli 工程根的 Unity 工程目录 */
  projectDir: string;
  /** 相对 v-cli 工程根的 staging 根目录（index 与各 root 所在） */
  stagingRoot: string;
  /** 可选：缺失 IR 报 warning 而非 error（转发 --allow-missing-ir） */
  allowMissingIr?: boolean;
}

const figmaBindingSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["projectDir", "stagingRoot"],
  properties: {
    projectDir: { type: "string", minLength: 1, description: "相对 v-cli 工程根的 Unity 工程目录" },
    stagingRoot: { type: "string", minLength: 1, description: "相对 v-cli 工程根的 staging 根目录；必须位于 projectDir 内（默认 Client/Assets/Arts/Game/FigmaAssets/_Staging）" },
    allowMissingIr: { type: "boolean", description: "可选：缺失 IR 按警告处理（--allow-missing-ir）" },
  },
};

export const figmaBindingContract: ProviderBindingContract = {
  schema: figmaBindingSchema,
  pathFields: [
    { field: "projectDir", kind: "dir", required: true },
    { field: "stagingRoot", kind: "dir", required: true },
  ],
  resolve: ({ project, raw, resolveInsideProject: resolve }) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, errors: ["bindings.figma 必须是对象"] };
    }
    const section = raw as FigmaBinding;
    const errors: string[] = [];
    if (typeof section.projectDir !== "string" || section.projectDir.length === 0) {
      errors.push("bindings.figma.projectDir 必须是非空字符串（相对工程根）");
    }
    if (typeof section.stagingRoot !== "string" || section.stagingRoot.length === 0) {
      errors.push("bindings.figma.stagingRoot 必须是非空字符串（相对工程根）");
    }
    if (section.allowMissingIr !== undefined && typeof section.allowMissingIr !== "boolean") {
      errors.push("bindings.figma.allowMissingIr 出现时必须是布尔值");
    }
    if (errors.length > 0) return { ok: false, errors };
    // 路径违规（PathSafetyError）穿透：核心归类 unsafe-binding
    const projectDir = resolve(project, section.projectDir, "bindings.figma.projectDir");
    const stagingRoot = resolve(project, section.stagingRoot, "bindings.figma.stagingRoot");
    // 语义校验：staging 必须位于 Unity 工程（projectDir）内——插件的 staging 解析以 Unity 工程
    // 为基（safeJoin 拒 ..），stagingRoot 绑到 projectDir 外必然运行期失败，绑定期即拒绝
    const rel = path.relative(projectDir.path, stagingRoot.path);
    if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      return {
        ok: false,
        errors: [`bindings.figma.stagingRoot 必须位于 bindings.figma.projectDir（${section.projectDir}）内（收到 ${section.stagingRoot}）`],
      };
    }
    return {
      ok: true,
      dirs: { projectDir: projectDir.path, stagingRoot: stagingRoot.path },
      files: {},
      section: { ...section },
      warnings: [],
    };
  },
};

/** 从执行上下文取已校验绑定段 */
function figmaBinding(ctx: CapabilityExecutionContext): FigmaBinding | null {
  const binding = ctx.binding;
  if (binding === null || typeof binding !== "object") return null;
  return binding as unknown as FigmaBinding;
}

/** 与 figma-to-uprefab normalizeProjectKey 一致的工程键（resolve→正斜杠→win32 小写） */
function normalizeProjectKey(projectPath: string): string {
  let key = path.resolve(projectPath).replace(/\\/g, "/");
  if (process.platform === "win32") key = key.toLowerCase();
  if (key.length > 3 && key.endsWith("/")) key = key.slice(0, -1);
  return key;
}

export interface FigmaProviderDeps {
  executor: ProcessExecutor;
  discoverBackend?: () => OfficialPluginInfo;
  env?: Record<string, string | undefined>;
}

export function createFigmaProvider(deps: FigmaProviderDeps): CapabilityProvider {
  const discoverBackend =
    deps.discoverBackend ??
    (() => {
      const spec = OFFICIAL_PLUGINS.find((p) => p.command === FIGMA_BACKEND_COMMAND);
      if (!spec) throw new Error(`官方插件白名单缺少 ${FIGMA_BACKEND_COMMAND}`);
      return discoverOfficialPlugin(spec);
    });

  async function backendStatus(): Promise<{ info: OfficialPluginInfo; available: boolean; detail: string }> {
    let info: OfficialPluginInfo;
    try {
      info = discoverBackend();
    } catch (err) {
      return {
        info: {
          source: "official",
          package: FIGMA_BACKEND_PACKAGE,
          name: FIGMA_BACKEND_COMMAND,
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

  /** 写托管配置并返回其绝对路径（内容：仅 uiSystem + staging，无令牌字段） */
  function writeManagedConfig(ctx: CapabilityExecutionContext, unityDir: string, stagingRootAbs: string): string {
    const configPath = path.join(ctx.projectAnchor.root, ...MANAGED_CONFIG_RELATIVE.split("/"));
    const stagingRelativeToUnity = path.relative(unityDir, stagingRootAbs).split(path.sep).join("/");
    const payload = {
      schemaVersion: 1,
      projects: {
        [normalizeProjectKey(unityDir)]: { uiSystem: "UGUI", staging: { root: stagingRelativeToUnity } },
      },
    };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    // 原子写：并发 contract/doctor 同写同文件时，插件不会读到半截 JSON；失败清理 tmp
    const tmpPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}
`, "utf-8");
      fs.renameSync(tmpPath, configPath);
    } catch (err) {
      try { fs.rmSync(tmpPath, { force: true }); } catch { /* 清理失败不影响原异常 */ }
      throw err;
    }
    return configPath;
  }

  function backendUnavailableOutcome(detail: string): ImplementationOutcome {
    return {
      execution: {
        status: "failed",
        lifecycle: "completed",
        exitCode: null,
        signal: null,
        error: structuredError("figma-backend-unavailable", "precondition", detail),
      },
      acceptance: { status: "not-run", reason: "Figma 后端不可用，未执行", pending: false, evidence: [] },
    };
  }

  /** 绑定段不完整的防御路径（正常被前置条件拦截） */
  function bindingIncompleteOutcome(): ImplementationOutcome {
    return {
      execution: {
        status: "failed",
        lifecycle: "completed",
        exitCode: null,
        signal: null,
        error: structuredError("figma-binding-incomplete", "precondition", "缺少工程目录/staging 绑定（figma.project-binding 前置条件负责拦截）"),
      },
      acceptance: { status: "not-run", reason: "绑定不完整，未执行", pending: false, evidence: [] },
    };
  }

  const backendAvailableCheck: PreconditionChecker = async () => {
    const backend = await backendStatus();
    if (backend.available) {
      return {
        id: "figma.backend-available",
        status: "satisfied",
        detail: `${FIGMA_BACKEND_PACKAGE}@${backend.info.version ?? "?"} 可用`,
        evidence: [
          { kind: "protocol-field", description: "后端发现", data: { package: FIGMA_BACKEND_PACKAGE, version: backend.info.version, bin: backend.info.bin } },
        ],
      };
    }
    return {
      id: "figma.backend-available",
      status: "violated",
      detail: `未发现可用的 ${FIGMA_BACKEND_PACKAGE}: ${backend.detail}`,
      evidence: [{ kind: "protocol-field", description: "后端发现", data: { package: FIGMA_BACKEND_PACKAGE, status: backend.info.status, error: backend.info.error } }],
    };
  };

  const projectBindingCheck: PreconditionChecker = (_input, ctx) => {
    const dir = ctx.bindingDirs.projectDir;
    if (dir) {
      return {
        id: "figma.project-binding",
        status: "satisfied",
        detail: `已绑定 Unity 工程目录 ${dir}`,
        evidence: [{ kind: "protocol-field", description: "bindings.figma.projectDir", data: dir }],
      };
    }
    return {
      id: "figma.project-binding",
      status: "violated",
      detail: '工程配置缺少 bindings.figma（projectDir/stagingRoot）；capability 输入不接受路径覆盖',
      evidence: [{ kind: "protocol-field", description: "工程配置文件", data: ctx.configFile }],
    };
  };

  const baseChecks: Record<string, PreconditionChecker> = {
    "figma.backend-available": backendAvailableCheck,
    "figma.project-binding": projectBindingCheck,
  };
  const basePreconditions = [
    { id: "figma.backend-available", description: `已安装并可用的 ${FIGMA_BACKEND_PACKAGE}（官方白名单发现）` },
    { id: "figma.project-binding", description: "工程配置已声明 bindings.figma（projectDir/stagingRoot 相对工程根）" },
  ];

  const READONLY_RETRY = { safe: true, maxAttempts: 1, strategy: "none" as const, description: "只读校验；内核单次尝试" };
  const READONLY_RESOURCES = [
    { kind: "project-workspace" as const, mode: "shared" as const, scope: "project" as const, description: "只读读取工程内 staging 内容" },
  ];
  const baseSideEffects = [
    { id: "spawn-figma-backend", kind: "process-exec" as const, description: `以受控 argv 启动 ${FIGMA_BACKEND_PACKAGE}（${FIGMA_BACKEND_COMMAND}）进程（离线，无网络调用）`, reversible: false },
    { id: "read-staging", kind: "fs-read" as const, description: "只读读取 staging 根下的 index/source/IR/overlay 文件", reversible: true },
    { id: "write-managed-config", kind: "fs-write" as const, description: `在 ${MANAGED_CONFIG_RELATIVE} 写 v-cli 托管配置（运行时生成，不含令牌，不入 Git）`, reversible: true },
  ];

  function evidenceField(description: string, data: unknown): Evidence {
    return { kind: "protocol-field", description, data };
  }

  function waitSecondsOf(input: Record<string, unknown>, fallback: number): number {
    const raw = input.waitSeconds;
    return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 600 ? raw : fallback;
  }

  /* ------------------------ 实现（重构成基于 outcome 的公共执行） ------------------------ */

  async function runBackend(
    argv: string[],
    ctx: CapabilityExecutionContext,
    waitSeconds: number,
    configPath: string,
  ): Promise<
    | { ok: false; outcome: ImplementationOutcome }
    | { ok: true; result: { command: { file: string; args: string[] }; rawOutput: ImplementationOutcome["rawOutput"]; toolInfo: { name: string; version?: string; path?: string }; outcome: ProcessOutcome } }
  > {
    const backend = await backendStatus();
    if (!backend.available || !backend.info.bin) {
      return { ok: false, outcome: backendUnavailableOutcome(`figma 后端不可用: ${backend.detail}`) };
    }
    ctx.log.event("process-start", `启动 ${FIGMA_BACKEND_COMMAND}`, { argv });
    const outcome = await deps.executor.run({
      file: process.execPath,
      args: [backend.info.bin, ...argv],
      cwd: ctx.projectAnchor.root,
      env: { ...deps.env, FIGMA_TO_UPREFAB_CONFIG: configPath },
      timeoutMs: waitSeconds * 1000 + 15_000,
      signal: ctx.signal,
    });
    ctx.log.event("process-finish", `进程结束 exit=${outcome.exitCode ?? "null"}`, {
      timedOut: outcome.timedOut,
      aborted: outcome.aborted,
      stdoutBytes: outcome.stdout.length,
      stderrBytes: outcome.stderr.length,
    });
    return {
      ok: true,
      result: {
        command: { file: process.execPath, args: [backend.info.bin, ...argv] },
        rawOutput: {
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          stdoutTruncated: outcome.stdoutTruncated,
          stderrTruncated: outcome.stderrTruncated,
        },
        toolInfo: { name: FIGMA_BACKEND_COMMAND, version: backend.info.version, path: backend.info.bin },
        outcome,
      },
    };
  }

  const contractExecuteFinal: CapabilityRegistration["implementation"]["execute"] = async (input, ctx) => {
    const binding = figmaBinding(ctx);
    const unityDir = ctx.bindingDirs.projectDir;
    const stagingRoot = ctx.bindingDirs.stagingRoot;
    if (!binding || !unityDir || !stagingRoot) return bindingIncompleteOutcome();
    const waitSeconds = waitSecondsOf(input, 60);
    const configPath = writeManagedConfig(ctx, unityDir, stagingRoot);
    ctx.log.event("managed-config-written", "已写入托管配置（无令牌字段）", { file: configPath });
    const argv = [
      "contract",
      "--project", unityDir,
      "--config", configPath,
      ...(binding.allowMissingIr === true ? ["--allow-missing-ir"] : []),
    ];
    const run = await runBackend(argv, ctx, waitSeconds, configPath);
    if (!run.ok) return run.outcome;
    const { command, rawOutput, toolInfo, outcome } = run.result;
    const base = { command, tool: toolInfo, rawOutput };
    const exec = executionFromProcess(outcome, { failureCode: "figma-contract-exit-nonzero" });
    if (exec.status !== "succeeded" && exec.status !== "failed") {
      return { ...base, execution: exec, acceptance: { status: "not-run", reason: "契约校验进程未取得结论", pending: exec.status === "unknown", evidence: [] } };
    }
    const parsed = parseContractOutput(rawOutput?.stdout ?? "", rawOutput?.stderr ?? "");
    const toolError = parseToolError(rawOutput?.stderr ?? "");
    const evidence: Evidence[] = [];
    if (parsed.validRoots !== null) evidence.push(evidenceField("Contract valid 行", rawOutput?.stdout?.trim()));
    for (const issue of parsed.issues) evidence.push(evidenceField(`issue ${issue.code}${issue.path ? ` @ ${issue.path}` : ""}`, issue.message));
    if (toolError) evidence.push(evidenceField("工具错误码", toolError));

    const output = {
      validRoots: parsed.validRoots,
      issueCount: parsed.issues.length,
      issueCodes: [...new Set(parsed.issues.map((i) => i.code))],
      stagingRoot,
      allowMissingIr: binding.allowMissingIr === true,
    };
    if (parsed.validRoots !== null && outcome.exitCode === 0) {
      if (parsed.validRoots === 0) {
        return {
          ...base,
          output,
          execution: exec,
          acceptance: { status: "failed", reason: "Contract valid 但 roots=0：空 staging 无可验收内容，不通过", pending: false, evidence },
        };
      }
      return {
        ...base,
        output,
        execution: exec,
        acceptance: {
          status: "passed",
          reason: `Contract valid：${parsed.validRoots} 个 root 通过真实插件校验（离线）`,
          pending: false,
          evidence,
        },
      };
    }
    if (parsed.issues.length > 0 && outcome.exitCode === 1) {
      // exit 1 是插件"校验不通过"的正常业务语义：进程成功输出了结构化结论
      return {
        ...base,
        output,
        execution: { ...exec, status: "succeeded", lifecycle: "completed", error: null },
        acceptance: {
          status: "failed",
          reason: `契约校验失败：${parsed.issues.length} 项 issue（${[...new Set(parsed.issues.map((i) => i.code))].slice(0, 5).join(", ")}${parsed.issues.length > 5 ? "…" : ""}）`,
          pending: false,
          evidence,
        },
      };
    }
    if (toolError && outcome.exitCode === 1) {
      // 工具级机器码（CFG_/SCH_/PAT_ 等码族）：调用环境问题，不是 staging 内容结论
      return {
        ...base,
        output,
        execution: {
          ...exec,
          error: structuredError(`figma-${toolError.code.toLowerCase()}`, "config", `${toolError.code}: ${toolError.message}`),
        },
        acceptance: { status: "not-run", reason: `工具报告 ${toolError.code}（调用环境问题），未取得 staging 结论`, pending: false, evidence },
      };
    }
    return {
      ...base,
      output,
      execution: {
        status: "unknown",
        lifecycle: "unknown",
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        error: structuredError("figma-output-uninterpretable", "protocol", `contract 输出不可解释（exit=${outcome.exitCode}，有效行=${parsed.validRoots !== null}，issues=${parsed.issues.length}，未识别行=${parsed.unrecognized}）`),
      },
      acceptance: { status: "not-run", reason: "契约校验输出不可解释，无验收结论", pending: false, evidence: [...evidence, { kind: "process-exit", description: `exit=${outcome.exitCode}`, data: { exitCode: outcome.exitCode } }] },
    };
  };

  const doctorExecute: CapabilityRegistration["implementation"]["execute"] = async (input, ctx) => {
    const binding = figmaBinding(ctx);
    const unityDir = ctx.bindingDirs.projectDir;
    const stagingRoot = ctx.bindingDirs.stagingRoot;
    if (!binding || !unityDir || !stagingRoot) return bindingIncompleteOutcome();
    const waitSeconds = waitSecondsOf(input, 60);
    const configPath = writeManagedConfig(ctx, unityDir, stagingRoot);
    const argv = ["doctor", "--project", unityDir, "--config", configPath];
    const run = await runBackend(argv, ctx, waitSeconds, configPath);
    if (!run.ok) return run.outcome;
    const { command, rawOutput, toolInfo, outcome } = run.result;
    const base = { command, tool: toolInfo, rawOutput };
    const exec = executionFromProcess(outcome, { failureCode: "figma-doctor-exit-nonzero" });
    if (exec.status !== "succeeded" && exec.status !== "failed") {
      return { ...base, execution: exec, acceptance: { status: "not-run", reason: "诊断进程未取得结论", pending: exec.status === "unknown", evidence: [] } };
    }
    const parsed = parseDoctorOutput(rawOutput?.stdout ?? "");
    const toolError = parseToolError(rawOutput?.stderr ?? "");
    const evidence: Evidence[] = parsed.checks.map((c) => evidenceField(`[${c.ok ? "ok" : "FAIL"}] ${c.name}`, c.message));
    if (toolError) evidence.push(evidenceField("工具错误码", toolError));

    if (parsed.checks.length === 0 && toolError) {
      return {
        ...base,
        execution: {
          ...exec,
          error: structuredError(`figma-${toolError.code.toLowerCase()}`, "config", `${toolError.code}: ${toolError.message}`),
        },
        acceptance: { status: "not-run", reason: `工具报告 ${toolError.code}（调用环境问题），未取得诊断结论`, pending: false, evidence },
      };
    }
    if (parsed.checks.length === 0) {
      return {
        ...base,
        execution: {
          status: "unknown",
          lifecycle: "unknown",
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          error: structuredError("figma-output-uninterpretable", "protocol", `doctor 输出无可解析的检查行（exit=${outcome.exitCode}）`),
        },
        acceptance: { status: "not-run", reason: "诊断输出不可解释，无验收结论", pending: false, evidence },
      };
    }
    const failed = parsed.checks.filter((c) => !c.ok);
    // 附言按实际失败项生成（该文案进入持久化验收证据，不得与事实相悖）
    const offlineExpected = new Set(["token", "editor", "unity-package"]);
    const unexpected = failed.filter((c) => !offlineExpected.has(c.name));
    const expectedFailed = failed.filter((c) => offlineExpected.has(c.name)).map((c) => c.name);
    const suffix =
      unexpected.length === 0
        ? `（${expectedFailed.join("/") || "部分检查项"} 在离线环境为预期 FAIL）`
        : "";
    const output = { allOk: outcome.exitCode === 0 && failed.length === 0, checks: parsed.checks };
    if (outcome.exitCode === 0 && failed.length === 0) {
      return {
        ...base,
        output,
        execution: exec,
        acceptance: { status: "passed", reason: `诊断全部通过（${parsed.checks.length} 项，离线环境）`, pending: false, evidence },
      };
    }
    if (outcome.exitCode !== 1) {
      // 协议漂移防御：exit∉{0,1} 不按业务失败解释
      return {
        ...base,
        output,
        execution: {
          status: "unknown",
          lifecycle: "unknown",
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          error: structuredError("figma-output-uninterpretable", "protocol", `doctor 以 exit=${outcome.exitCode} 输出检查行（预期 0/1），不采信`),
        },
        acceptance: { status: "not-run", reason: "诊断退出码异常，无验收结论", pending: false, evidence },
      };
    }
    // exit 1 = 有检查项失败（诊断本身的正常语义）
    return {
      ...base,
      output,
      execution: { ...exec, status: "succeeded", lifecycle: "completed", error: null },
      acceptance: {
        status: "failed",
        reason: `诊断有 ${failed.length}/${parsed.checks.length} 项失败：${failed.map((c) => c.name).join(", ")}${suffix}`,
        pending: false,
        evidence,
      },
      notes: ["退出码 1 只表示有检查项失败；token 缺失是离线验证的预期状态，不要求配置令牌"],
    };
  };

  const registrations: CapabilityRegistration[] = [
    {
      descriptor: {
        id: "figma.contract",
        version: "0.1.0",
        description:
          "离线校验 Figma staging 契约（真实插件、无网络）：root index/source/IR/overlay 对 schema 与不变式；合法 staging 且 roots>0 才通过；越界与非法 staging 明确失败",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            waitSeconds: { type: "integer", minimum: 0, maximum: 600, description: "进程等待预算（秒，默认 60）" },
          },
        },
        outputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["validRoots", "issueCount", "issueCodes"],
          properties: {
            validRoots: { type: "integer", nullable: true, description: "Contract valid 的 root 数（非 valid 输出为 null）" },
            issueCount: { type: "integer", description: "契约 issue 总数" },
            issueCodes: { type: "array", items: { type: "string" }, description: "去重后的 issue 码（CON_*/PAT_*/…）" },
            stagingRoot: { type: "string", description: "本次校验的 staging 根（工程内绝对路径）" },
            allowMissingIr: { type: "boolean", description: "是否按 --allow-missing-ir 执行" },
          },
        },
        preconditions: basePreconditions,
        sideEffects: baseSideEffects,
        resources: READONLY_RESOURCES,
        retry: READONLY_RETRY,
        timeoutMs: 90_000,
        tags: ["figma", "contract", "read-only", "offline"],
      },
      implementation: { preconditions: { ...baseChecks }, execute: contractExecuteFinal },
    },
    {
      descriptor: {
        id: "figma.doctor",
        version: "0.1.0",
        description:
          "只读环境诊断（真实插件、无网络）：托管配置/staging/Unity 安装/令牌存在性逐项 [ok]/[FAIL]；token 缺失是离线验证的预期状态（值永不输出）",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            waitSeconds: { type: "integer", minimum: 0, maximum: 600, description: "进程等待预算（秒，默认 60）" },
          },
        },
        outputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["allOk", "checks"],
          properties: {
            allOk: { type: "boolean", description: "全部检查项是否 [ok]" },
            checks: {
              type: "array",
              description: "逐项检查（name/ok/message；token 项只含存在性，不含值）",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["name", "ok", "message"],
                properties: {
                  name: { type: "string" },
                  ok: { type: "boolean" },
                  message: { type: "string" },
                },
              },
            },
          },
        },
        preconditions: basePreconditions,
        sideEffects: baseSideEffects,
        resources: READONLY_RESOURCES,
        retry: READONLY_RETRY,
        timeoutMs: 90_000,
        tags: ["figma", "doctor", "read-only", "offline"],
      },
      implementation: { preconditions: { ...baseChecks }, execute: doctorExecute },
    },
  ];

  return {
    id: FIGMA_PROVIDER_ID,
    version: FIGMA_PROVIDER_VERSION,
    description: "Figma staging 离线契约校验与只读诊断（Windows-first；不联网、不触碰凭据与生产资产）",
    binding: figmaBindingContract,
    defaultBinding: (project) => {
      const warnings: string[] = [];
      const declared = path.join(project.root, "Client");
      if (!fs.existsSync(declared)) {
        warnings.push("bindings.figma.projectDir=\"Client\" 当前不存在：请按工程实际目录修改 .vant/config/v-cli.json 或用 --binding figma 覆盖");
      } else if (!fs.existsSync(path.join(declared, ...DEFAULT_STAGING_ROOT_SEGMENTS.split("/")))) {
        warnings.push(`默认 staging 根 Client/${DEFAULT_STAGING_ROOT_SEGMENTS} 当前不存在：figma.contract 将按 CON_INDEX_MISSING 明确失败（staging 由 Figma 导出流程产出）`);
      }
      return { section: { projectDir: "Client", stagingRoot: `Client/${DEFAULT_STAGING_ROOT_SEGMENTS}` }, warnings };
    },
    status: async () => {
      const backend = await backendStatus();
      if (backend.available) {
        return {
          state: "available" as const,
          detail: `${FIGMA_BACKEND_PACKAGE}@${backend.info.version ?? "?"} 可用`,
          tool: { name: FIGMA_BACKEND_COMMAND, version: backend.info.version, path: backend.info.bin },
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
    capabilities: () => [...registrations.map(r=>({...r,descriptor:{...r.descriptor,commands:[[r.descriptor.id.slice(6)]]}})), ...figmaCommandRegistrations(deps)],
  };
}
