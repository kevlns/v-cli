import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilityRegistry } from "../src/core/execution/registry";
import { exitCodeForResult, runCapability, type CapabilityRunRequest } from "../src/core/execution/runtime";
import { createUnityProvider } from "../src/providers/unity";
import type { CapabilityRunResult } from "../src/core/execution/types";
import { FakeExecutor, type FakeCall, type FakeResponse } from "./helpers/fake-executor";
import {
  HANDOFF_STDERR,
  doctorJson,
  execEnvelope,
  fakeBackend,
  makeTempProject,
  type TempProject,
} from "./helpers/unity-fixtures";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function project(options: Parameters<typeof makeTempProject>[0] = {}): TempProject {
  const p = makeTempProject(options);
  cleanups.push(p.cleanup);
  return p;
}

const READY_DOCTOR = doctorJson();
/** 就绪的 doctor 输出 + exec 信封 响应器 */
function readyHandler(execResponse: () => FakeResponse) {
  return (call: FakeCall): FakeResponse => {
    if (call.args[1] === "doctor") return { exitCode: 0, stdout: READY_DOCTOR };
    return execResponse();
  };
}

function registryFor(handler: (call: FakeCall, index: number) => FakeResponse | Promise<FakeResponse>): {
  registry: CapabilityRegistry;
  executor: FakeExecutor;
} {
  const executor = new FakeExecutor(handler);
  const registry = new CapabilityRegistry();
  registry.registerProvider(
    createUnityProvider({
      executor,
      discoverBackend: () => fakeBackend(),
      timeoutSlackMs: 1000,
    }),
  );
  return { registry, executor };
}

function run(
  registry: CapabilityRegistry,
  p: TempProject,
  capabilityId: string,
  input: Record<string, unknown> = {},
  extra: Partial<CapabilityRunRequest> = {},
): Promise<CapabilityRunResult> {
  return runCapability(registry, {
    capabilityId,
    projectRoot: p.root,
    input,
    persist: false,
    ...extra,
  });
}

/** 假执行器记录的是 [backendBin, ...argv]；取插件参数部分 */
const pluginArgs = (call: FakeCall): string[] => call.args.slice(1);
const execCalls = (executor: FakeExecutor): FakeCall[] => executor.calls.filter((c) => c.args[1] === "exec");
const doctorCalls = (executor: FakeExecutor): FakeCall[] => executor.calls.filter((c) => c.args[1] === "doctor");

describe("unity provider：argv 与输入绑定", () => {
  it("doctor argv 只含受控词元；allowRunningEditor 显式才追加", async () => {
    const p = project();
    const { registry, executor } = registryFor(() => ({ exitCode: 0, stdout: READY_DOCTOR }));
    await run(registry, p, "unity.doctor");
    expect(executor.calls).toHaveLength(1);
    expect(pluginArgs(executor.calls[0])).toEqual(["doctor", p.clientDir]);
    expect(executor.calls[0].file).toBe(process.execPath);
    expect(executor.calls[0].cwd).toBe(p.clientDir);

    await run(registry, p, "unity.doctor", { allowRunningEditor: true });
    expect(pluginArgs(executor.calls[1])).toEqual(["doctor", p.clientDir, "--allow-running-editor"]);
  });

  it("exec argv 顺序固定，且不含任何 --project-path 变体（目标工程由包装器附加）", async () => {
    const p = project();
    const { registry, executor } = registryFor(
      readyHandler(() => ({ exitCode: 0, stdout: execEnvelope({ status: "ready" }) })),
    );
    await run(registry, p, "unity.editor-status", { waitSeconds: 12 });
    const call = execCalls(executor)[0];
    expect(pluginArgs(call)).toEqual([
      "exec",
      p.clientDir,
      "--wait",
      "12",
      "--format",
      "json",
      "command",
      "editor_status",
    ]);
    expect(pluginArgs(call).join(" ")).not.toMatch(/project[-_]?path/i);
  });

  it("输入中的 projectPath 覆盖被 schema 拒绝（不执行）", async () => {
    const p = project();
    const { registry, executor } = registryFor(() => ({ exitCode: 0, stdout: execEnvelope({ status: "ready" }) }));
    const result = await run(registry, p, "unity.editor-status", { projectPath: "C:/other" });
    expect(result.execution.error?.code).toBe("input-invalid");
    expect(executor.calls).toHaveLength(0);
    expect(exitCodeForResult(result)).toBe(2);
  });

  it("test-start 固定 --async_tests 并转发 mode/filter（mode 默认取配置 testMode）", async () => {
    const p = project({
      config: { schemaVersion: 1, bindings: { unity: { projectDir: "Client", testMode: "PlayMode" } } },
    });
    const { registry, executor } = registryFor(
      readyHandler(() => ({ exitCode: 0, stdout: execEnvelope({ status: "running" }) })),
    );
    await run(registry, p, "unity.test-start");
    expect(pluginArgs(execCalls(executor)[0]).slice(6)).toEqual([
      "command",
      "run_tests",
      "--mode",
      "PlayMode",
      "--async_tests",
    ]);

    const filtered = registryFor(
      readyHandler(() => ({ exitCode: 0, stdout: execEnvelope({ status: "running" }) })),
    );
    await run(filtered.registry, p, "unity.test-start", { mode: "EditMode", filter: "My.Ns.Tests" });
    expect(pluginArgs(execCalls(filtered.executor)[0]).slice(6)).toEqual([
      "command",
      "run_tests",
      "--mode",
      "EditMode",
      "--filter",
      "My.Ns.Tests",
      "--async_tests",
    ]);
  });
});

describe("unity provider：doctor（诊断 ≠ 就绪）", () => {
  it("路由/CLI/适配包都就绪 → 执行成功 + 验收 passed", async () => {
    const p = project();
    const { registry } = registryFor(() => ({ exitCode: 0, stdout: READY_DOCTOR }));
    const result = await run(registry, p, "unity.doctor");
    expect(result.execution.status).toBe("succeeded");
    expect(result.acceptance.status).toBe("passed");
    expect(exitCodeForResult(result)).toBe(0);
    expect((result.output as { ready: boolean }).ready).toBe(true);
    expect(result.sideEffects.map((s) => s.kind)).toContain("process-exec");
  });

  it("doctor exit 0 但 pipeline 未安装 → 验收 failed（退出码 1），并说明退出码语义", async () => {
    const p = project();
    const { registry } = registryFor(() => ({
      exitCode: 0,
      stdout: doctorJson({ pipelineState: "missing", pipelineInstalled: false, pipelinePresent: false }),
    }));
    const result = await run(registry, p, "unity.doctor");
    expect(result.execution.status).toBe("succeeded");
    expect(result.acceptance.status).toBe("failed");
    expect(result.acceptance.reason).toContain("pipeline");
    expect(result.notes.join()).toContain("退出码 0 只表示诊断完成");
    expect(exitCodeForResult(result)).toBe(1);
  });

  it("doctor 进程非零退出 → 执行 failed、验收 not-run（不冒充诊断结论）", async () => {
    const p = project();
    const { registry } = registryFor(() => ({ exitCode: 1, stderr: "unsupported editor version" }));
    const result = await run(registry, p, "unity.doctor");
    expect(result.execution.status).toBe("failed");
    expect(result.execution.error?.code).toBe("doctor-exit-nonzero");
    expect(result.acceptance.status).toBe("not-run");
    expect(exitCodeForResult(result)).toBe(1);
  });

  it("doctor 输出不可解析 → 执行 unknown（退出码 5），验收 not-run", async () => {
    const p = project();
    const { registry } = registryFor(() => ({ exitCode: 0, stdout: "not json at all" }));
    const result = await run(registry, p, "unity.doctor");
    expect(result.execution.status).toBe("unknown");
    expect(result.execution.error?.category).toBe("protocol");
    expect(result.acceptance.status).toBe("not-run");
    expect(exitCodeForResult(result)).toBe(5);
  });
});

describe("unity provider：exec 前就绪判据（preflight）", () => {
  it("doctor 未就绪 → 前置条件 violated，只跑 doctor、不 exec", async () => {
    const p = project();
    const { registry, executor } = registryFor(() => ({
      exitCode: 0,
      stdout: doctorJson({ pipelineState: "outdated", pipelineInstalled: false }),
    }));
    const result = await run(registry, p, "unity.compile");
    expect(result.preconditions.find((x) => x.id === "unity.pipeline-ready")?.status).toBe("violated");
    expect(result.execution.error?.category).toBe("precondition");
    expect(execCalls(executor)).toHaveLength(0);
    expect(exitCodeForResult(result)).toBe(2);
  });

  it("doctor 不可用（unknown）也 fail-closed", async () => {
    const p = project();
    const { registry, executor } = registryFor(() => ({ exitCode: 0, stdout: "broken" }));
    const result = await run(registry, p, "unity.test-status");
    expect(result.preconditions.find((x) => x.id === "unity.pipeline-ready")?.status).toBe("unknown");
    expect(execCalls(executor)).toHaveLength(0);
  });

  it("禁止跳过工具链前置检查", async () => {
    const p = project();
    const { registry, executor } = registryFor(() => ({ exitCode: 0, stdout: READY_DOCTOR }));
    const result = await run(registry, p, "unity.test-status", { preflight: false });
    expect(result.execution.error?.code).toBe("input-invalid");
    expect(executor.calls).toHaveLength(0);
  });

  it("配置钉扎 editorVersion 不一致 → violated", async () => {
    const p = project({
      config: {
        schemaVersion: 1,
        bindings: { unity: { projectDir: "Client", editorVersion: "2022.3.59f1c1" } },
      },
    });
    const { registry } = registryFor(() => ({ exitCode: 0, stdout: READY_DOCTOR }));
    const result = await run(registry, p, "unity.editor-status");
    const ready = result.preconditions.find((x) => x.id === "unity.pipeline-ready");
    expect(ready?.status).toBe("violated");
    expect(ready?.detail).toContain("钉扎");
  });

  it("未绑定 unity 目录 → 前置条件 violated（退出码 2）", async () => {
    const p = project({ config: { schemaVersion: 1, bindings: {} } });
    const { registry, executor } = registryFor(() => ({ exitCode: 0, stdout: READY_DOCTOR }));
    const result = await run(registry, p, "unity.doctor");
    expect(result.preconditions?.find((x) => x.id === "unity.project-binding")?.status).toBe("violated");
    expect(executor.calls).toHaveLength(0);
    expect(exitCodeForResult(result)).toBe(2);
  });

  it("后端发现失败 → 前置条件 violated，不启动任何进程", async () => {
    const p = project();
    const executor = new FakeExecutor(() => ({ exitCode: 0, stdout: READY_DOCTOR }));
    const registry = new CapabilityRegistry();
    registry.registerProvider(
      createUnityProvider({
        executor,
        discoverBackend: () => fakeBackend({ status: "missing", bin: undefined, error: "未安装" }),
      }),
    );
    const result = await run(registry, p, "unity.doctor");
    expect(result.preconditions?.find((x) => x.id === "unity.backend-available")?.status).toBe("violated");
    expect(executor.calls).toHaveLength(0);
  });
});

describe("unity provider：editor-status", () => {
  it('status="ready" → 验收 passed', async () => {
    const p = project();
    const { registry } = registryFor(readyHandler(() => ({ exitCode: 0, stdout: execEnvelope({ status: "ready" }) })));
    const result = await run(registry, p, "unity.editor-status");
    expect(result.execution.status).toBe("succeeded");
    expect(result.acceptance.status).toBe("passed");
    expect(result.acceptance.evidence.some((e) => String(e.data).includes("ready"))).toBe(true);
    expect(() => JSON.stringify(result.output)).not.toThrow();
    expect((result.output as { status: string }).status).toBe("ready");
  });

  it("非 ready 状态 → 验收 failed（不通过）", async () => {
    const p = project();
    const { registry } = registryFor(readyHandler(() => ({ exitCode: 0, stdout: execEnvelope({ status: "compiling" }) })));
    const result = await run(registry, p, "unity.editor-status");
    expect(result.execution.status).toBe("succeeded");
    expect(result.acceptance.status).toBe("failed");
    expect(exitCodeForResult(result)).toBe(1);
  });

  it("缺少 status 字段 → 验收 failed", async () => {
    const p = project();
    const { registry } = registryFor(readyHandler(() => ({ exitCode: 0, stdout: execEnvelope({ other: 1 }) })));
    const result = await run(registry, p, "unity.editor-status");
    expect(result.acceptance.status).toBe("failed");
    expect(result.acceptance.reason).toContain("缺少 status");
  });

  it("信封 success=false（如未启动 Editor）→ 执行 failed，透出工具错误", async () => {
    const p = project();
    const { registry } = registryFor(
      readyHandler(() => ({
        exitCode: 0,
        stdout: execEnvelope(undefined, { outerSuccess: false, error: "No Pipeline instance found for project" }),
      })),
    );
    const result = await run(registry, p, "unity.editor-status");
    expect(result.execution.status).toBe("failed");
    expect(result.execution.error?.code).toBe("tool-reported-failure");
    expect(result.execution.error?.message).toContain("No Pipeline instance");
    expect(result.acceptance.status).toBe("not-run");
  });

  it("输出不可解析 → 执行 unknown、验收 not-run（退出码 5）", async () => {
    const p = project();
    const { registry } = registryFor(readyHandler(() => ({ exitCode: 0, stdout: "plain text output" })));
    const result = await run(registry, p, "unity.editor-status");
    expect(result.execution.status).toBe("unknown");
    expect(exitCodeForResult(result)).toBe(5);
  });

  it("让出控制权（stderr 有让位说明）→ unknown + 验收 pending（未取得结论，应重新轮询）", async () => {
    const p = project();
    const { registry } = registryFor(readyHandler(() => ({ exitCode: 0, stdout: "", stderr: HANDOFF_STDERR })));
    const result = await run(registry, p, "unity.editor-status");
    expect(result.execution.status).toBe("unknown");
    expect(result.execution.error?.code).toBe("status-unconfirmed");
    expect(result.acceptance.status).toBe("not-run");
    expect(result.acceptance.pending).toBe(true);
    expect(exitCodeForResult(result)).toBe(5);
  });
});

describe("unity provider：compile / compile-status", () => {
  it("触发成功 → accepted=true、lifecycle=accepted、验收 not-run(pending) + followUp", async () => {
    const p = project();
    const { registry } = registryFor(
      readyHandler(() => ({ exitCode: 0, stdout: execEnvelope({ status: "triggered" }) })),
    );
    const result = await run(registry, p, "unity.compile");
    expect(result.execution.status).toBe("succeeded");
    expect(result.execution.lifecycle).toBe("accepted");
    expect(result.acceptance.status).toBe("not-run");
    expect(result.acceptance.pending).toBe(true);
    expect(result.followUp[0].capabilityId).toBe("unity.compile-status");
    expect((result.output as { accepted: boolean }).accepted).toBe(true);
    expect(exitCodeForResult(result)).toBe(3);
  });

  it("让出控制权（无法确认接受）→ unknown/accepted、accepted=false、pending", async () => {
    const p = project();
    const { registry } = registryFor(readyHandler(() => ({ exitCode: 0, stdout: "", stderr: HANDOFF_STDERR })));
    const result = await run(registry, p, "unity.compile");
    expect(result.execution.status).toBe("unknown");
    expect(result.execution.lifecycle).toBe("accepted");
    expect((result.output as { accepted: boolean }).accepted).toBe(false);
    expect(result.acceptance.pending).toBe(true);
    expect(exitCodeForResult(result)).toBe(5);
  });

  it("compile-status：completed / up_to_date → passed；compiling → not-run(pending)", async () => {
    const p = project();
    for (const [status, expected] of [
      ["completed", "passed"],
      ["up_to_date", "passed"],
    ] as const) {
      const { registry } = registryFor(
        readyHandler(() => ({ exitCode: 0, stdout: execEnvelope({ status, failed: false, errors: [] }) })),
      );
      const result = await run(registry, p, "unity.compile-status");
      expect(result.acceptance.status, status).toBe(expected);
    }
    const compiling = registryFor(readyHandler(() => ({ exitCode: 0, stdout: execEnvelope({ status: "compiling" }) })));
    const compilingResult = await run(compiling.registry, p, "unity.compile-status");
    expect(compilingResult.acceptance.status).toBe("not-run");
    expect(compilingResult.acceptance.pending).toBe(true);
    expect(exitCodeForResult(compilingResult)).toBe(3);
  });

  it("compile-status：idle → not-run；未知取值 / 缺字段 / failed → failed（不通过）", async () => {
    const p = project();
    const runStatus = async (result: unknown) => {
      const { registry } = registryFor(readyHandler(() => ({ exitCode: 0, stdout: execEnvelope(result) })));
      return run(registry, p, "unity.compile-status");
    };
    expect((await runStatus({ status: "idle" })).acceptance.status).toBe("not-run");
    expect((await runStatus({ status: "weird" })).acceptance.status).toBe("failed");
    expect((await runStatus({})).acceptance.status).toBe("failed");
    expect((await runStatus({ status: "failed" })).acceptance.status).toBe("failed");
  });
});

describe("unity provider：test-start / test-status", () => {
  it("test-start 成功只是 accepted（验收 not-run pending，绝不通过）", async () => {
    const p = project();
    const { registry } = registryFor(
      readyHandler(() => ({ exitCode: 0, stdout: execEnvelope({ status: "running" }) })),
    );
    const result = await run(registry, p, "unity.test-start");
    expect(result.execution.status).toBe("succeeded");
    expect(result.acceptance.status).toBe("not-run");
    expect((result.output as { accepted: boolean }).accepted).toBe(true);
    expect((result.output as { mode: string }).mode).toBe("EditMode");
    expect(result.notes.join()).toContain("--async_tests");
    expect(exitCodeForResult(result)).toBe(3);
  });

  it("test-status：completed + 失败数 0 + 有报告 → passed", async () => {
    const p = project();
    const { registry } = registryFor(
      readyHandler(() => ({
        exitCode: 0,
        stdout: execEnvelope({ status: "completed", summary: { total: 12, passed: 12, failed: 0 } }),
      })),
    );
    const result = await run(registry, p, "unity.test-status");
    expect(result.acceptance.status).toBe("passed");
    expect((result.output as { failCount: number }).failCount).toBe(0);
    expect((result.output as { reportPresent: boolean }).reportPresent).toBe(true);
    expect(exitCodeForResult(result)).toBe(0);
  });

  it("test-status：完成但有失败 → failed（带失败数证据）", async () => {
    const p = project();
    const { registry } = registryFor(
      readyHandler(() => ({
        exitCode: 0,
        stdout: execEnvelope({ status: "completed", summary: { total: 12, failed: 3 } }),
      })),
    );
    const result = await run(registry, p, "unity.test-status");
    expect(result.acceptance.status).toBe("failed");
    expect(result.acceptance.reason).toContain("3");
    expect(exitCodeForResult(result)).toBe(1);
  });

  it("test-status：completed 但缺报告 → failed", async () => {
    const p = project();
    const { registry } = registryFor(
      readyHandler(() => ({ exitCode: 0, stdout: execEnvelope({ status: "completed", failed: 0 }) })),
    );
    const result = await run(registry, p, "unity.test-status");
    expect(result.acceptance.status).toBe("failed");
    expect(result.acceptance.reason).toContain("缺少有效报告");
  });

  it("test-status：completed 但缺失败数 → failed（不能通过）", async () => {
    const p = project();
    const { registry } = registryFor(
      readyHandler(() => ({ exitCode: 0, stdout: execEnvelope({ status: "completed", summary: { total: 5 } }) })),
    );
    const result = await run(registry, p, "unity.test-status");
    expect(result.acceptance.status).toBe("failed");
    expect(result.acceptance.reason).toContain("失败数");
  });

  it("test-status：running → not-run(pending)；cancelled/未知/缺失 → 不通过", async () => {
    const p = project();
    const runStatus = async (result: unknown) => {
      const { registry } = registryFor(readyHandler(() => ({ exitCode: 0, stdout: execEnvelope(result) })));
      return run(registry, p, "unity.test-status");
    };
    const running = await runStatus({ status: "running" });
    expect((await runStatus({ status: "in_progress" })).acceptance.status).toBe("failed");
    expect(running.acceptance.status).toBe("not-run");
    expect(running.acceptance.pending).toBe(true);
    expect(exitCodeForResult(running)).toBe(3);
    expect((await runStatus({ status: "idle" })).acceptance.status).toBe("not-run");
    expect((await runStatus({ status: "cancelled" })).acceptance.status).toBe("failed");
    expect((await runStatus({ status: "mystery" })).acceptance.status).toBe("failed");
    expect((await runStatus({})).acceptance.status).toBe("failed");
  });

  it("test-status：工具报告失败 → 执行 failed（不解析为状态）", async () => {
    const p = project();
    const { registry } = registryFor(
      readyHandler(() => ({ exitCode: 0, stdout: execEnvelope(undefined, { outerSuccess: false, error: "no test run" }) })),
    );
    const result = await run(registry, p, "unity.test-status");
    expect(result.execution.status).toBe("failed");
    expect(result.acceptance.status).toBe("not-run");
  });
});

describe("unity provider：test-cancel（取消必须确认）", () => {
  it("响应直接确认 cancelled → passed（无需探测）", async () => {
    const p = project();
    const { registry, executor } = registryFor(
      readyHandler(() => ({ exitCode: 0, stdout: execEnvelope({ status: "cancelled" }) })),
    );
    const result = await run(registry, p, "unity.test-cancel");
    expect(result.acceptance.status).toBe("passed");
    expect((result.output as { confirmed: boolean }).confirmed).toBe(true);
    expect(execCalls(executor)).toHaveLength(1);
  });

  it("响应未确认但 test_status 探测为 cancelled → passed（两段证据）", async () => {
    const p = project();
    let execIndex = 0;
    const { registry, executor } = registryFor(
      readyHandler(() => {
        execIndex++;
        return execIndex === 1
          ? { exitCode: 0, stdout: execEnvelope({ ok: true }) }
          : { exitCode: 0, stdout: execEnvelope({ status: "cancelled" }) };
      }),
    );
    const result = await run(registry, p, "unity.test-cancel");
    expect(result.acceptance.status).toBe("passed");
    expect(result.acceptance.reason).toContain("test_status=cancelled");
    expect((result.output as { probeStatus: string }).probeStatus).toBe("cancelled");
    expect(execCalls(executor)).toHaveLength(2);
  });

  it("探测仍 running → not-run(pending)，且不标记已取消", async () => {
    const p = project();
    let execIndex = 0;
    const { registry } = registryFor(
      readyHandler(() => {
        execIndex++;
        return execIndex === 1
          ? { exitCode: 0, stdout: execEnvelope({ ok: true }) }
          : { exitCode: 0, stdout: execEnvelope({ status: "running" }) };
      }),
    );
    const result = await run(registry, p, "unity.test-cancel");
    expect(result.execution.status).toBe("succeeded");
    expect(result.acceptance.status).toBe("not-run");
    expect(result.acceptance.pending).toBe(true);
    expect((result.output as { confirmed: boolean }).confirmed).toBe(false);
    expect(JSON.stringify(result)).not.toContain('"status": "cancelled"');
  });

  it("探测不可解析 → not-run，明确说明未确认", async () => {
    const p = project();
    let execIndex = 0;
    const { registry } = registryFor(
      readyHandler(() => {
        execIndex++;
        return execIndex === 1
          ? { exitCode: 0, stdout: execEnvelope({ ok: true }) }
          : { exitCode: 0, stdout: "not json" };
      }),
    );
    const result = await run(registry, p, "unity.test-cancel");
    expect(result.acceptance.status).toBe("not-run");
    expect(result.acceptance.reason).toContain("未确认");
  });

  it("verify=false 且响应无确认字段 → not-run（不探测）", async () => {
    const p = project();
    const { registry, executor } = registryFor(
      readyHandler(() => ({ exitCode: 0, stdout: execEnvelope({ ok: true }) })),
    );
    const result = await run(registry, p, "unity.test-cancel", { verify: false });
    expect(result.acceptance.status).toBe("not-run");
    expect(execCalls(executor)).toHaveLength(1);
  });

  it("cancel 进程非零退出 → 执行 failed，验收 not-run", async () => {
    const p = project();
    const { registry } = registryFor(readyHandler(() => ({ exitCode: 2, stderr: "cancel failed" })));
    const result = await run(registry, p, "unity.test-cancel");
    expect(result.execution.status).toBe("failed");
    expect(result.acceptance.status).toBe("not-run");
  });
});

describe("unity provider：契约与注册", () => {
  it("provider 描述包含全部七个能力与声明的副作用/资源/重试", async () => {
    const { registry } = registryFor(() => ({ exitCode: 0, stdout: READY_DOCTOR }));
    const ids = registry.list().map((r) => r.id);
    expect(ids).toEqual([
      "unity.compile",
      "unity.compile-status",
      "unity.doctor",
      "unity.editor-status",
      "unity.test-cancel",
      "unity.test-start",
      "unity.test-status",
    ]);
    for (const row of registry.list()) {
      expect(row.retry.maxAttempts).toBeGreaterThanOrEqual(1);
      expect(row.sideEffectKinds).toContain("process-exec");
    }
    const doctor = registry.describe("unity.doctor");
    expect(doctor?.preconditions.map((p) => p.id)).toEqual([
      "unity.backend-available",
      "unity.project-binding",
      "unity.project-version-file",
    ]);
    const testStart = registry.describe("unity.test-start");
    expect((testStart?.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
    expect(testStart?.resources.map((r) => r.mode)).toContain("exclusive");
  });

  it("provider 状态发现只读（不会启动进程）", async () => {
    const executor = new FakeExecutor(() => ({ exitCode: 0, stdout: READY_DOCTOR }));
    const registry = new CapabilityRegistry();
    registry.registerProvider(createUnityProvider({ executor, discoverBackend: () => fakeBackend() }));
    const status = await registry.providerStatus("unity");
    expect(status?.state).toBe("available");
    expect(status?.tool?.version).toBe("0.2.4");
    expect(executor.calls).toHaveLength(0);
  });

  it("非 win32 平台 → platform-mismatch 状态（fail-closed，路由由现有插件门禁负责）", async () => {
    const executor = new FakeExecutor(() => ({ exitCode: 0, stdout: READY_DOCTOR }));
    const registry = new CapabilityRegistry();
    registry.registerProvider(
      createUnityProvider({
        executor,
        discoverBackend: () =>
          fakeBackend({ status: "platform-mismatch", platform: "linux", requiredPlatforms: ["win32"], bin: undefined }),
      }),
    );
    const status = await registry.providerStatus("unity");
    expect(status?.state).toBe("platform-mismatch");
    const result = await run(registry, project(), "unity.doctor");
    expect(result.preconditions.find((x) => x.id === "unity.backend-available")?.status).toBe("violated");
  });

  it("进程硬超时 = wait 预算 + 余量（超时不允许无限等待）", async () => {
    const p = project();
    const { registry, executor } = registryFor(
      readyHandler(() => ({ exitCode: 0, stdout: execEnvelope({ status: "ready" }) })),
    );
    await run(registry, p, "unity.editor-status", { waitSeconds: 5 });
    const call = execCalls(executor)[0];
    expect(call.timeoutMs).toBe(5000 + 1000);
  });

  it("进程超时 → 执行 unknown（不冒充失败/取消）", async () => {
    const p = project();
    const { registry } = registryFor(
      readyHandler(() => ({ exitCode: null, signal: "SIGKILL", timedOut: true })),
    );
    const result = await run(registry, p, "unity.editor-status", {});
    expect(result.execution.status).toBe("unknown");
    expect(result.execution.error?.code).toBe("process-timeout");
    expect(exitCodeForResult(result)).toBe(5);
  });

  it("取消（确认杀进程）→ execution=cancelled，验收 not-run，退出码 4", async () => {
    const p = project();
    const { registry } = registryFor(
      readyHandler(() => ({ exitCode: null, signal: "SIGKILL", aborted: true, killConfirmed: true })),
    );
    const controller = new AbortController();
    const result = await runCapability(registry, {
      capabilityId: "unity.editor-status",
      projectRoot: p.root,
      input: {},
      persist: false,
      signal: controller.signal,
    });
    expect(result.execution.status).toBe("cancelled");
    expect(result.acceptance.status).toBe("not-run");
    expect(exitCodeForResult(result)).toBe(4);
  });

  it("取消未确认（killConfirmed=false）→ execution=unknown（不得标记 cancelled）", async () => {
    const p = project();
    const { registry } = registryFor(readyHandler(() => ({ exitCode: null, aborted: true, killConfirmed: false })));
    const result = await run(registry, p, "unity.compile", {});
    expect(result.execution.status).toBe("unknown");
    expect(result.execution.error?.code).toBe("cancel-unconfirmed");
    expect(exitCodeForResult(result)).toBe(5);
  });

  it("落盘证据包含 tool 版本与受控 argv（不含 shell 字符串）", async () => {
    const p = project();
    const { registry } = registryFor(() => ({ exitCode: 0, stdout: READY_DOCTOR }));
    const result = await run(registry, p, "unity.doctor", {}, { persist: true });
    expect(result.provider.tool?.name).toBe("unity");
    expect(result.provider.tool?.version).toBe("0.2.4");
    expect(result.invocation.command?.args[0]).toBe(fakeBackend().bin);
    expect(path.isAbsolute(result.invocation.command!.args[0]!)).toBe(true);
    expect(result.persisted.files).toEqual(
      expect.arrayContaining(["input.json", "events.jsonl", "stdout.log", "result.json"]),
    );
  });
});

describe("P.Cell 真实协议与验收回归", () => {
  it("展开字符串形式的 JSON 状态报告", async () => {
    const p = project(); const { registry } = registryFor(readyHandler(() => ({ exitCode: 0, stdout: execEnvelope(JSON.stringify({ status: "completed", summary: { total: 3, passed: 3, failed: 0 }, results: [{ Status: "Passed" }, { Status: "Passed" }, { Status: "Passed" }] })) })));
    const r = await run(registry, p, "unity.test-status"); expect(r.acceptance.status).toBe("passed"); expect((r.output as any).total).toBe(3);
  });
  it("编译完成必须附带无错误报告", async () => {
    for (const payload of [{ status: "completed" }, { status: "completed", failed: true, errors: ["CS0234"] }, { status: "completed", failed: false, errors: ["CS0234"] }]) {
      const p = project(); const { registry } = registryFor(readyHandler(() => ({ exitCode: 0, stdout: execEnvelope(JSON.stringify(payload)) })));
      expect((await run(registry, p, "unity.compile-status")).acceptance.status).toBe("failed");
    }
    const p = project(); const { registry } = registryFor(readyHandler(() => ({ exitCode: 0, stdout: execEnvelope(JSON.stringify({ status: "up_to_date", failed: false, errors: [] })) })));
    expect((await run(registry, p, "unity.compile-status")).acceptance.status).toBe("passed");
  });
  it("零用例、负数和小数失败计数不能通过", async () => {
    for (const [total, failed] of [[0, 0], [3, -1], [3, 0.5], [3, 4], [-1, 0]]) {
      const p = project(); const { registry } = registryFor(readyHandler(() => ({ exitCode: 0, stdout: execEnvelope({ status: "completed", summary: { total, failed } }) })));
      expect((await run(registry, p, "unity.test-status")).acceptance.status).toBe("failed");
    }
  });
  it("空闲状态不能证明取消已确认", async () => {
    const p = project(); let n = 0; const { registry } = registryFor(readyHandler(() => ({ exitCode: 0, stdout: execEnvelope(++n === 1 ? { ok: true } : { status: "idle" }) })));
    expect((await run(registry, p, "unity.test-cancel")).acceptance.status).toBe("not-run");
  });
  it("外层失败不能被内层成功覆盖", async () => {
    const p = project(); const { registry } = registryFor(readyHandler(() => ({ exitCode: 0, stdout: JSON.stringify({ success: false, data: { success: true, result: { status: "ready" } } }) })));
    expect((await run(registry, p, "unity.editor-status")).execution.status).toBe("failed");
  });
});
