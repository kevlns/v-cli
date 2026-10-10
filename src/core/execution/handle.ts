/**
 * 异步执行句柄（阶段 C）：可序列化身份凭证 + 落盘证据回读校验。
 *
 * 设计要点（对应计划 §6 与 survey §4）：
 * - 句柄由内核在异步触发结果中产出（Provider 只提供 backendTaskId 种子）；
 *   调用方提交的句柄**不可信**——查询/取消前必须经 verifyExecutionHandle 全量校验。
 * - 校验依据是**落盘证据的一致性核对**（启动 operation 的 result.json），不是密码学签名：
 *   integrity 摘要仅防手滑改动/截断（survey §9 决策 5）。
 * - 禁止"证据缺失/校验失败时回退最近一次任务"；不能恢复的句柄给出明确错误。
 * - 每次查询/取消是独立 operationId（runCapability 天然保证）；校验只**读**启动目录，绝不复用覆盖。
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PathSafetyError, comparePathForm, resolveInsideProject, type ProjectRoot } from "../project/paths";
import { validateOperationId } from "../project/operation-store";
import { OPERATIONS_RELATIVE } from "../project/config";

export const EXECUTION_HANDLE_VERSION = 1;

/** Provider 在异步触发结果中提供的后端身份种子（内核发行前校验形状） */
export interface ExecutionHandleSeed {
  /** 后端可验证的任务身份；后端无身份协议时必须显式为 null（禁止 v-cli 侧编造） */
  backendTaskId: string | null;
}

/** 校验种子形状（string|null、未知键拒绝）；非法返回错误列表（内核按契约违约处理，不发行句柄） */
export function validateHandleSeed(seed: unknown): string[] {
  if (!isPlainObject(seed)) return ["handle 种子必须是对象"];
  for (const key of Object.keys(seed)) {
    if (key !== "backendTaskId") return [`handle 种子含未知键 "${key}"（只允许 backendTaskId）`];
  }
  if (seed.backendTaskId !== null && typeof seed.backendTaskId !== "string") {
    return [`handle 种子 backendTaskId 必须是字符串或 null（收到 ${JSON.stringify(seed.backendTaskId)}）`];
  }
  return [];
}

/** 可序列化执行句柄（随触发结果返回并落盘） */
export interface ExecutionHandle {
  schemaVersion: typeof EXECUTION_HANDLE_VERSION;
  providerId: string;
  /** 触发能力 id（如 unity.test-start） */
  capabilityId: string;
  /** 原始启动操作 id（证据目录锚点） */
  originOperationId: string;
  backendTaskId: string | null;
  /** 目标工程身份（v-cli 解析的 realpath + 配置文件路径） */
  project: { root: string; configFile: string };
  startedAt: string;
  /** false = 未落盘启动（--no-persist），不可跨进程恢复 */
  recoverable: boolean;
  /** 证据目录（工程内相对路径，恒为 .vant/state/operations/<originOperationId>） */
  recordDir: string;
  /** 完整性提示摘要（canonical(handle 去本字段) 的 sha256；非签名） */
  integrity: { algo: "sha256"; digest: string };
}

/** 递归键排序的稳定序列化（integrity 计算基准） */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function handleDigest(handle: Omit<ExecutionHandle, "integrity">): string {
  return createHash("sha256").update(canonicalize(handle), "utf-8").digest("hex");
}

/** 由内核补全句柄（Provider 种子 + 内核掌握的身份字段）；persist=false → recoverable=false */
export function buildExecutionHandle(input: {
  seed: ExecutionHandleSeed;
  providerId: string;
  capabilityId: string;
  operationId: string;
  project: ProjectRoot;
  configFile: string;
  startedAt: string;
  persisted: boolean;
}): ExecutionHandle {
  const base: Omit<ExecutionHandle, "integrity"> = {
    schemaVersion: EXECUTION_HANDLE_VERSION,
    providerId: input.providerId,
    capabilityId: input.capabilityId,
    originOperationId: input.operationId,
    backendTaskId: input.seed.backendTaskId,
    project: { root: input.project.realRoot, configFile: input.configFile },
    startedAt: input.startedAt,
    recoverable: input.persisted,
    recordDir: `${OPERATIONS_RELATIVE}/${input.operationId}`,
  };
  return { ...base, integrity: { algo: "sha256" as const, digest: handleDigest(base) } };
}

/* ------------------------------- 校验与恢复 ------------------------------- */

export type HandleVerification =
  | {
      ok: true;
      /** 从启动 operation 落盘证据读回的关联材料（供查询/取消能力组装结果与证据） */
      record: {
        operationId: string;
        capabilityId: string;
        providerId: string;
        backendTaskId: string | null;
        recordDir: string;
        startedAt: string | null;
        execution: { status: string; lifecycle: string } | null;
        acceptance: { status: string; pending: boolean } | null;
      };
      /** 已通过的身份核对项（写入验收证据） */
      checks: string[];
    }
  | { ok: false; code: string; errors: string[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 校验调用方提交的句柄（不可信输入），并从落盘证据恢复原始执行关联。
 * 任何不一致 → 明确拒绝（不回退最近任务、不猜测）。
 */
export function verifyExecutionHandle(input: {
  project: ProjectRoot;
  handle: unknown;
  /** 查询/取消能力所属 provider（防跨 Provider 句柄） */
  expectProviderId: string;
  /** 期望的触发能力 id（可选，收紧到具体触发器） */
  expectCapabilityId?: string;
}): HandleVerification {
  const { project, handle } = input;
  const fail = (code: string, errors: string[]): HandleVerification => ({ ok: false, code, errors });

  if (!isPlainObject(handle)) return fail("handle-invalid", ["句柄必须是 JSON 对象"]);
  // 句柄不接受未知键（与全项目 additionalProperties:false 的 fail-closed 风格一致）
  const HANDLE_KEYS = new Set([
    "schemaVersion", "providerId", "capabilityId", "originOperationId", "backendTaskId",
    "project", "startedAt", "recoverable", "recordDir", "integrity",
  ]);
  for (const key of Object.keys(handle)) {
    if (!HANDLE_KEYS.has(key)) {
      return fail("handle-invalid", [`句柄含未知键 "${key}"（允许: ${[...HANDLE_KEYS].join(" / ")}）`]);
    }
  }
  if (handle.schemaVersion !== EXECUTION_HANDLE_VERSION) {
    return fail("handle-version-unsupported", [
      `句柄 schemaVersion 必须为 ${EXECUTION_HANDLE_VERSION}（收到 ${JSON.stringify(handle.schemaVersion)}）`,
    ]);
  }
  const stringFields = ["providerId", "capabilityId", "originOperationId", "startedAt", "recordDir"] as const;
  for (const field of stringFields) {
    if (typeof handle[field] !== "string" || (handle[field] as string).length === 0) {
      return fail("handle-invalid", [`句柄字段 ${field} 必须是非空字符串`]);
    }
  }
  if (handle.backendTaskId !== null && typeof handle.backendTaskId !== "string") {
    return fail("handle-invalid", ["句柄 backendTaskId 必须是字符串或 null"]);
  }
  if (typeof handle.recoverable !== "boolean") {
    return fail("handle-invalid", ["句柄 recoverable 必须是布尔值"]);
  }
  if (!isPlainObject(handle.project) || typeof handle.project.root !== "string" || typeof handle.project.configFile !== "string") {
    return fail("handle-invalid", ["句柄 project.root/configFile 必须是字符串"]);
  }
  if (!isPlainObject(handle.integrity) || handle.integrity.algo !== "sha256" || typeof handle.integrity.digest !== "string") {
    return fail("handle-invalid", ["句柄 integrity 缺失或非法"]);
  }

  // 完整性提示：canonical 摘要自洽（防手滑改动；非签名）
  const { integrity: _omit, ...base } = handle as unknown as ExecutionHandle;
  if (handleDigest(base as Omit<ExecutionHandle, "integrity">) !== (handle.integrity as { digest: string }).digest) {
    return fail("handle-integrity-mismatch", ["句柄完整性摘要不一致（内容被改动或截断）"]);
  }

  if (handle.providerId !== input.expectProviderId) {
    return fail("handle-provider-mismatch", [
      `句柄属于 provider "${handle.providerId}"，本能力属于 "${input.expectProviderId}"：跨 Provider 句柄拒绝`,
    ]);
  }
  if (input.expectCapabilityId !== undefined && handle.capabilityId !== input.expectCapabilityId) {
    return fail("handle-capability-mismatch", [
      `句柄的触发能力为 "${handle.capabilityId}"，期望 "${input.expectCapabilityId}"`,
    ]);
  }

  // 目标工程身份：不信任调用方提交的工程路径——句柄工程必须是当前锚定工程
  if (comparePathForm((handle.project as { root: string }).root) !== comparePathForm(project.realRoot)) {
    return fail("handle-project-mismatch", [
      `句柄工程 ${(handle.project as { root: string }).root} 与当前工程 ${project.realRoot} 不一致：拒绝执行`,
    ]);
  }

  if (handle.recoverable !== true) {
    return fail("handle-not-recoverable", [
      "句柄由未落盘模式（--no-persist）启动，无本地证据，不可跨调用恢复；请用原始能力重新触发",
    ]);
  }

  // 证据目录形态：恒为 .vant/state/operations/<originOperationId>
  const idErrors = validateOperationId(handle.originOperationId);
  if (idErrors.length > 0) return fail("handle-invalid", idErrors);
  const expectedDir = `${OPERATIONS_RELATIVE}/${handle.originOperationId}`;
  if (handle.recordDir !== expectedDir) {
    return fail("handle-invalid", [`句柄 recordDir 必须是 ${expectedDir}（收到 ${handle.recordDir}）`]);
  }

  let recordPath: string;
  try {
    recordPath = resolveInsideProject(project, `${expectedDir}/result.json`, "句柄证据").path;
  } catch (err) {
    if (err instanceof PathSafetyError) {
      return fail("handle-evidence-unsafe", [err.message]);
    }
    throw err;
  }
  if (!fs.existsSync(recordPath)) {
    return fail("handle-evidence-missing", [
      `句柄证据缺失: ${expectedDir}/result.json（目录或文件不存在；不回退最近任务）`,
    ]);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(recordPath, "utf-8"));
  } catch (err) {
    return fail("handle-evidence-unreadable", [
      `句柄证据不可读: ${err instanceof Error ? err.message : String(err)}`,
    ]);
  }
  if (!isPlainObject(raw)) return fail("handle-evidence-unreadable", ["句柄证据不是 JSON 对象"]);

  // 落盘证据一致性核对（句柄各身份字段 ↔ 原始执行记录）
  const operation = isPlainObject(raw.operationId) ? undefined : raw.operationId;
  const capability = isPlainObject(raw.capability) ? raw.capability : undefined;
  const provider = isPlainObject(raw.provider) ? raw.provider : undefined;
  const recordProject = isPlainObject(raw.project) ? raw.project : undefined;
  const recordHandle = isPlainObject(raw.handle) ? raw.handle : undefined;
  const recordExecution = isPlainObject(raw.execution) ? raw.execution : null;
  const recordAcceptance = isPlainObject(raw.acceptance) ? raw.acceptance : null;

  const checks: string[] = [];
  const mismatches: string[] = [];
  let missingHandleField = false;
  if (operation !== handle.originOperationId) {
    mismatches.push(`operationId: 记录 ${JSON.stringify(operation)} ≠ 句柄 ${JSON.stringify(handle.originOperationId)}`);
  } else checks.push("operationId");
  if (capability?.id !== handle.capabilityId) {
    mismatches.push(`capabilityId: 记录 ${JSON.stringify(capability?.id)} ≠ 句柄 ${JSON.stringify(handle.capabilityId)}`);
  } else checks.push("capabilityId");
  if (provider?.id !== handle.providerId) {
    mismatches.push(`providerId: 记录 ${JSON.stringify(provider?.id)} ≠ 句柄 ${JSON.stringify(handle.providerId)}`);
  } else checks.push("providerId");
  if (recordProject !== undefined && comparePathForm(String(recordProject.root ?? "")) !== comparePathForm(handle.project.root)) {
    mismatches.push("project.root 与记录不一致");
  } else if (recordProject !== undefined) checks.push("project.root");
  if (recordHandle !== undefined) {
    if (recordHandle.backendTaskId !== handle.backendTaskId) {
      mismatches.push(
        `backendTaskId: 记录 ${JSON.stringify(recordHandle.backendTaskId)} ≠ 句柄 ${JSON.stringify(handle.backendTaskId)}（关联已失效或被其他任务替代）`,
      );
    } else checks.push("backendTaskId");
    if (typeof recordHandle.startedAt === "string" && recordHandle.startedAt !== handle.startedAt) {
      mismatches.push("startedAt 与记录不一致");
    } else if (typeof recordHandle.startedAt === "string") checks.push("startedAt");
  } else {
    missingHandleField = true;
    mismatches.push("记录缺少 handle 字段（非异步触发的操作记录，证据形态不可用于句柄恢复）");
  }
  if (missingHandleField) {
    return fail("handle-evidence-unusable", mismatches);
  }
  if (mismatches.length > 0) {
    return fail("handle-tampered", ["句柄与落盘证据不一致，关联失效:", ...mismatches]);
  }

  return {
    ok: true,
    record: {
      operationId: String(operation),
      capabilityId: String(capability?.id),
      providerId: String(provider?.id),
      backendTaskId: (recordHandle?.backendTaskId as string | null) ?? null,
      recordDir: expectedDir,
      startedAt: typeof recordHandle?.startedAt === "string" ? recordHandle.startedAt : null,
      execution:
        recordExecution !== null && typeof recordExecution.status === "string" && typeof recordExecution.lifecycle === "string"
          ? { status: recordExecution.status, lifecycle: recordExecution.lifecycle }
          : null,
      acceptance:
        recordAcceptance !== null && typeof recordAcceptance.status === "string"
          ? { status: recordAcceptance.status, pending: recordAcceptance.pending === true }
          : null,
    },
    checks,
  };
}
