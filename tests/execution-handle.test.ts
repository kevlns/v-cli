/**
 * 阶段 C 验收：异步执行句柄（计划 §6 验收矩阵逐行覆盖）。
 *
 * 样本 Provider 模拟带身份的后端（trigger 分配 backendTaskId，query/cancel 经内核
 * verifyExecutionHandle 校验后关联落盘证据）——验证的是内核机制，不假装状态后端。
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilityRegistry } from "../src/core/execution/registry";
import { runCapability } from "../src/core/execution/runtime";
import type { ExecutionHandle } from "../src/core/execution/handle";
import { createSampleProvider } from "./helpers/sample-provider";
import { makeTempProject, type TempProject } from "./helpers/unity-fixtures";

const projects: TempProject[] = [];
afterEach(() => {
  for (const p of projects.splice(0)) p.cleanup();
});

const CONFIG = { schemaVersion: 1, bindings: { sample: { workspaceDir: "Client" } } };

function tempProject(config: unknown = CONFIG): TempProject {
  const project = makeTempProject({ config, withProjectVersion: false });
  projects.push(project);
  return project;
}

function registry(): CapabilityRegistry {
  const r = new CapabilityRegistry();
  r.registerProvider(createSampleProvider());
  return r;
}

async function trigger(project: TempProject, overrides: { operationId?: string; persist?: boolean; input?: Record<string, unknown> } = {}): Promise<{
  handle: ExecutionHandle;
  result: Awaited<ReturnType<typeof runCapability>>;
}> {
  const result = await runCapability(registry(), {
    capabilityId: "sample.trigger",
    projectRoot: project.root,
    input: { label: "job-a", ...(overrides.input ?? {}) },
    operationId: overrides.operationId,
    persist: overrides.persist,
  });
  expect(result.handle).not.toBeNull();
  return { handle: result.handle!, result };
}

async function query(project: TempProject, handle: unknown, operationId?: string) {
  return runCapability(registry(), {
    capabilityId: "sample.query",
    projectRoot: project.root,
    input: { handle },
    operationId,
    persist: true,
  });
}

describe("句柄产出与形态", () => {
  it("异步触发产出句柄：触发 not-run(pending)，句柄含全部身份字段与完整性摘要", async () => {
    const project = tempProject();
    const { handle, result } = await trigger(project);
    expect(result.execution).toMatchObject({ status: "succeeded", lifecycle: "accepted" });
    expect(result.acceptance).toMatchObject({ status: "not-run", pending: true });
    expect(handle.schemaVersion).toBe(1);
    expect(handle.providerId).toBe("sample");
    expect(handle.capabilityId).toBe("sample.trigger");
    expect(handle.originOperationId).toBe(result.operationId);
    expect(handle.backendTaskId).toMatch(/^sample-job-/);
    expect(handle.recoverable).toBe(true);
    expect(handle.recordDir).toBe(`.vant/state/operations/${result.operationId}`);
    expect(handle.integrity.algo).toBe("sha256");
    expect(handle.integrity.digest).toHaveLength(64);
    // 句柄随结果落盘（证据）
    const persisted = JSON.parse(
      fs.readFileSync(path.join(project.root, ".vant", "state", "operations", result.operationId, "result.json"), "utf-8"),
    );
    expect(persisted.handle).toEqual(handle);
  });

  it("未落盘启动（--no-persist）→ recoverable=false 的句柄，无证据目录", async () => {
    const project = tempProject();
    const result = await runCapability(registry(), {
      capabilityId: "sample.trigger",
      projectRoot: project.root,
      input: {},
      persist: false,
    });
    expect(result.handle?.recoverable).toBe(false);
    expect(fs.existsSync(path.join(project.root, ".vant", "state", "operations"))).toBe(false);
  });
});

describe("验收矩阵（计划 §6）", () => {
  it("① 正确句柄查询同一任务：结果具有原始执行关联与身份依据", async () => {
    const project = tempProject();
    const { handle } = await trigger(project, { operationId: "trig-origin-1" });
    const q = await query(project, handle, "query-1");
    expect(q.execution.status).toBe("succeeded");
    expect(q.acceptance.status).toBe("passed");
    expect(q.output).toMatchObject({
      originOperationId: "trig-origin-1",
      backendTaskId: handle.backendTaskId,
      correlation: "verified",
    });
    // 证据含落盘证据路径与身份核对项
    const evidence = q.acceptance.evidence.map((e) => e.description).join();
    expect(evidence).toContain("result.json");
    expect(evidence).toContain("身份核对项");
    // 查询是独立调用记录，不复用启动目录
    expect(q.operationId).toBe("query-1");
    expect(fs.existsSync(path.join(project.root, ".vant", "state", "operations", "query-1", "result.json"))).toBe(true);
    expect(fs.existsSync(path.join(project.root, ".vant", "state", "operations", "trig-origin-1", "result.json"))).toBe(true);
  });

  it("② 另一工程的句柄：执行前拒绝（前置条件 violated），无后端操作", async () => {
    const projectA = tempProject();
    const projectB = tempProject();
    const { handle } = await trigger(projectA, { operationId: "trig-a" });
    const q = await query(projectB, handle, "query-cross");
    expect(q.execution.status).toBe("failed");
    expect(q.execution.error?.category).toBe("precondition");
    expect(q.acceptance.status).toBe("not-run");
    const handleCheck = q.preconditions.find((p) => p.id === "sample.handle-valid")!;
    expect(handleCheck.status).toBe("violated");
    expect(handleCheck.detail).toContain("handle-project-mismatch");
  });

  it("③ 句柄篡改（改 startedAt）/ 证据缺失 / 版本不支持：明确拒绝，不回退最近任务", async () => {
    const project = tempProject();
    const { handle } = await trigger(project, { operationId: "trig-tamper" });

    const tampered = { ...structuredClone(handle), startedAt: "1999-01-01T00:00:00.000Z" };
    const q1 = await query(project, tampered, "query-tamper-1");
    expect(q1.preconditions.find((p) => p.id === "sample.handle-valid")!.detail).toContain("handle-integrity-mismatch");

    // 重算摘要的"高仿"篡改：完整性过了，但与落盘证据不一致 → handle-tampered
    const { canonicalize } = await import("../src/core/execution/handle");
    const { createHash } = await import("node:crypto");
    const { integrity: _drop, ...noIntegrity } = structuredClone(handle);
    const forgedBase = { ...noIntegrity, backendTaskId: "sample-job-forged" } as Omit<ExecutionHandle, "integrity">;
    const forged: ExecutionHandle = {
      ...forgedBase,
      integrity: { algo: "sha256", digest: createHash("sha256").update(canonicalize(forgedBase)).digest("hex") },
    };
    const q2 = await query(project, forged, "query-tamper-2");
    expect(q2.preconditions.find((p) => p.id === "sample.handle-valid")!.detail).toContain("handle-tampered");

    fs.rmSync(path.join(project.root, ".vant", "state", "operations", "trig-tamper"), { recursive: true });
    const q3 = await query(project, handle, "query-missing");
    expect(q3.preconditions.find((p) => p.id === "sample.handle-valid")!.detail).toContain("handle-evidence-missing");

    const q4 = await query(project, { ...structuredClone(handle), schemaVersion: 2 }, "query-version");
    expect(q4.preconditions.find((p) => p.id === "sample.handle-valid")!.detail).toContain("handle-version-unsupported");
  });

  it("④ CLI 重启后继续查询：新注册表实例按落盘证据恢复（同一磁盘即同一事实源）", async () => {
    const project = tempProject();
    const { handle } = await trigger(project, { operationId: "trig-restart" });
    // 新 registry = 新进程等价（句柄校验只依赖工程磁盘证据，不依赖进程内状态）
    const fresh = new CapabilityRegistry();
    fresh.registerProvider(createSampleProvider());
    const q = await runCapability(fresh, {
      capabilityId: "sample.query",
      projectRoot: project.root,
      input: { handle },
      operationId: "query-after-restart",
    });
    expect(q.acceptance.status).toBe("passed");
    expect(q.output).toMatchObject({ originOperationId: "trig-restart" });
  });

  it("⑤ 工具接受启动但尚无终态：not-run/pending，不验收通过", async () => {
    const project = tempProject();
    const { result, handle } = await trigger(project, { operationId: "trig-pending" });
    expect(result.acceptance.status).toBe("not-run");
    expect(result.acceptance.pending).toBe(true);
    expect(result.execution.lifecycle).toBe("accepted");
    // 查询原始执行：仍是启动时的 accepted（观察为 running，无终态验收）
    const q = await query(project, handle, "query-pending");
    expect(q.execution.lifecycle).toBe("running");
    expect(q.acceptance.status).toBe("passed"); // 查询这个调用本身通过（其验收目标是关联成立）
    expect((q.output as { originExecution: { lifecycle: string } }).originExecution.lifecycle).toBe("accepted");
  });

  it("⑥ 后端明确确认取消：lifecycle=cancelled + 取消依据（身份核对）保留", async () => {
    const project = tempProject();
    const { handle } = await trigger(project, { operationId: "trig-cancel" });
    const c = await runCapability(registry(), {
      capabilityId: "sample.cancel",
      projectRoot: project.root,
      input: { handle },
      operationId: "cancel-1",
    });
    expect(c.execution.status).toBe("succeeded");
    expect(c.execution.lifecycle).toBe("cancelled");
    expect(c.acceptance.status).toBe("passed");
    expect(c.acceptance.reason).toContain(handle.backendTaskId);
    expect(c.output).toMatchObject({ cancelled: true, originOperationId: "trig-cancel" });
  });

  it("⑦ 未落盘句柄跨调用恢复：明确错误（不猜测、不回退）", async () => {
    const project = tempProject();
    const result = await runCapability(registry(), {
      capabilityId: "sample.trigger",
      projectRoot: project.root,
      input: {},
      persist: false,
    });
    const q = await query(project, result.handle, "query-norecover");
    const detail = q.preconditions.find((p) => p.id === "sample.handle-valid")!.detail;
    expect(detail).toContain("handle-not-recoverable");
    expect(q.execution.error?.category).toBe("precondition");
  });

  it("⑧ 后端报告被其他任务替代（backendTaskId 与证据不一致）：关联失效，不接受该报告", async () => {
    const project = tempProject();
    const { handle } = await trigger(project, { operationId: "trig-replaced" });
    // 篡改句柄的 backendTaskId 并重算摘要：与落盘证据不一致 → 关联失效
    const { canonicalize } = await import("../src/core/execution/handle");
    const { createHash } = await import("node:crypto");
    const { integrity: _omit, ...noIntegrity } = structuredClone(handle);
    const replacedBase = { ...noIntegrity, backendTaskId: "sample-job-OTHER" } as Omit<ExecutionHandle, "integrity">;
    const replaced: ExecutionHandle = {
      ...replacedBase,
      integrity: { algo: "sha256", digest: createHash("sha256").update(canonicalize(replacedBase)).digest("hex") },
    };
    const q = await query(project, replaced, "query-replaced");
    const detail = q.preconditions.find((p) => p.id === "sample.handle-valid")!.detail;
    expect(detail).toContain("handle-tampered");
    expect(detail).toContain("backendTaskId");
    expect(q.acceptance.status).toBe("not-run");
  });

  it("跨 Provider 句柄：拒绝（provider 不匹配）", async () => {
    const project = tempProject();
    const { handle } = await trigger(project, { operationId: "trig-cross-provider" });
    // 直接以内核校验验证 expectProviderId 闸门
    const { verifyExecutionHandle } = await import("../src/core/execution/handle");
    const { resolveProjectRoot } = await import("../src/core/project/paths");
    const verification = verifyExecutionHandle({
      project: resolveProjectRoot(project.root),
      handle,
      expectProviderId: "unity",
      expectCapabilityId: "unity.test-start",
    });
    expect(verification.ok).toBe(false);
    if (!verification.ok) expect(verification.code).toBe("handle-provider-mismatch");
  });
});

describe("六状态 lifecycle（阶段 A §5 迁移基线）", () => {
  it("样本 cancel 的 lifecycle=cancelled 是一等值（runtime 校验接受六态）", async () => {
    const project = tempProject();
    const { handle } = await trigger(project, { operationId: "trig-six" });
    const c = await runCapability(registry(), {
      capabilityId: "sample.cancel",
      projectRoot: project.root,
      input: { handle },
    });
    expect(c.execution.lifecycle).toBe("cancelled");
  });
});

describe("一审修复回归（句柄内核）", () => {
  it("句柄含未知键 → handle-invalid（重算摘要也不放行）", async () => {
    const project = tempProject();
    const { handle } = await trigger(project, { operationId: "trig-unknown-key" });
    const { canonicalize } = await import("../src/core/execution/handle");
    const { createHash } = await import("node:crypto");
    const { integrity: _i, ...noIntegrity } = structuredClone(handle);
    const extraBase = { ...noIntegrity, smuggled: "x" } as unknown as Omit<ExecutionHandle, "integrity">;
    const withExtra: ExecutionHandle = {
      ...extraBase,
      integrity: { algo: "sha256", digest: createHash("sha256").update(canonicalize(extraBase)).digest("hex") },
    };
    const q = await query(project, withExtra, "query-unknown-key");
    expect(q.preconditions.find((p) => p.id === "sample.handle-valid")!.detail).toContain("未知键");
  });

  it("证据记录缺少 handle 字段（非异步触发的操作）→ handle-evidence-unusable（独立于篡改码）", async () => {
    const project = tempProject();
    const { handle } = await trigger(project, { operationId: "trig-nohandle" });
    const recordPath = path.join(project.root, ".vant", "state", "operations", "trig-nohandle", "result.json");
    const record = JSON.parse(fs.readFileSync(recordPath, "utf-8")) as Record<string, unknown>;
    delete record.handle;
    fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
    const q = await query(project, handle, "query-nohandle");
    expect(q.preconditions.find((p) => p.id === "sample.handle-valid")!.detail).toContain("handle-evidence-unusable");
  });

  it("畸形种子（backendTaskId 非法类型）→ 契约违约降级 unknown，不发行句柄", async () => {
    const project = tempProject();
    const malformed = createSampleProvider({
      execute: async () =>
        ({
          execution: { status: "succeeded", lifecycle: "accepted" },
          acceptance: { status: "not-run", reason: "触发", pending: true, evidence: [] },
          output: { message: "x", workspaceDir: "w" },
          handle: { backendTaskId: 123 },
        }) as never,
    });
    // 用 echo 能力承载畸形种子（execute 钩子作用在 echo 上）
    const r = new CapabilityRegistry();
    r.registerProvider(malformed);
    const result = await runCapability(r, {
      capabilityId: "sample.echo",
      projectRoot: project.root,
      input: { message: "x" },
      persist: false,
    });
    expect(result.handle).toBeNull();
    expect(result.execution.status).toBe("unknown");
    expect(result.execution.error?.code).toBe("handle-seed-invalid");
  });
});

describe("二审修复回归", () => {
  it("混合场景：记录缺 handle 字段且 operationId 不一致 → 优先归类 handle-evidence-unusable", async () => {
    const project = tempProject();
    const { handle } = await trigger(project, { operationId: "trig-mixed" });
    const recordPath = path.join(project.root, ".vant", "state", "operations", "trig-mixed", "result.json");
    const record = JSON.parse(fs.readFileSync(recordPath, "utf-8")) as Record<string, unknown>;
    delete record.handle;
    record.operationId = "someone-else";
    fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
    const q = await query(project, handle, "query-mixed");
    const detail = q.preconditions.find((p) => p.id === "sample.handle-valid")!.detail;
    expect(detail).toContain("handle-evidence-unusable");
    expect(detail).toContain("operationId");
  });

  it("种子含未知键（backendTaskIdSource 残留形态）→ handle-seed-invalid，不发行句柄", async () => {
    const project = tempProject();
    const smuggler = createSampleProvider({
      execute: async () =>
        ({
          execution: { status: "succeeded", lifecycle: "accepted" },
          acceptance: { status: "not-run", reason: "触发", pending: true, evidence: [] },
          output: { message: "x", workspaceDir: "w" },
          handle: { backendTaskId: "job-1", backendTaskIdSource: "data.result.jobId" },
        }) as never,
    });
    const r = new CapabilityRegistry();
    r.registerProvider(smuggler);
    const result = await runCapability(r, {
      capabilityId: "sample.echo",
      projectRoot: project.root,
      input: { message: "x" },
      persist: false,
    });
    expect(result.handle).toBeNull();
    expect(result.execution.error?.code).toBe("handle-seed-invalid");
  });
});
