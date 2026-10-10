import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CapabilityError,
  CapabilityRegistrationError,
} from "../src/core/execution/errors";
import { CapabilityRegistry } from "../src/core/execution/registry";
import {
  executionFromProcess,
  exitCodeForResult,
  runCapability,
  type CapabilityRunRequest,
} from "../src/core/execution/runtime";
import { OperationExistsError, OperationStore, validateOperationId } from "../src/core/project/operation-store";
import { resolveProjectRoot } from "../src/core/project/paths";
import type {
  CapabilityDescriptor,
  CapabilityImplementation,
  CapabilityProvider,
  JsonSchema,
  ProviderBindingContract,
  ResourceAuthorizer,
} from "../src/core/execution/types";
import type { ProcessOutcome } from "../src/core/execution/executor";
import { makeTempProject, type TempProject } from "./helpers/unity-fixtures";

const projects: TempProject[] = [];
afterEach(() => {
  for (const p of projects.splice(0)) p.cleanup();
});

const DEMO_BINDING: ProviderBindingContract = {
  schema: { type: "object", additionalProperties: false, properties: {} },
  pathFields: [],
  resolve: () => ({ ok: true, dirs: {}, files: {}, warnings: [] }),
};

function tempProject(): TempProject {
  // demo provider 的绑定段：无路径字段（外壳 + 契约校验链路仍然全走）
  const project = makeTempProject({ config: { schemaVersion: 1, bindings: { demo: {} } } });
  projects.push(project);
  return project;
}

const INPUT: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: { value: { type: "string" }, secret: { type: "string" } },
};
const OUTPUT: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: { echo: { type: "string" }, status: { type: "string" } },
  required: ["echo"],
};

function makeRegistry(options: {
  execute?: CapabilityImplementation["execute"];
  preconditions?: CapabilityImplementation["preconditions"];
  descriptor?: Partial<CapabilityDescriptor>;
} = {}): CapabilityRegistry {
  const descriptor: CapabilityDescriptor = {
    id: "demo.sample",
    version: "0.1.0",
    description: "样例",
    inputSchema: INPUT,
    outputSchema: OUTPUT,
    preconditions: [],
    sideEffects: [{ id: "run", kind: "process-exec", description: "跑进程", reversible: false }],
    resources: [
      { kind: "project-workspace", mode: "exclusive", scope: "project", description: "工程独占" },
    ],
    retry: { safe: false, maxAttempts: 1, strategy: "none", description: "单次" },
    ...options.descriptor,
  };
  const implementation: CapabilityImplementation = {
    preconditions: options.preconditions ?? {},
    execute:
      options.execute ??
      (async (input) => ({
        execution: { status: "succeeded", lifecycle: "completed", exitCode: 0 },
        acceptance: {
          status: "passed",
          reason: "证据充分",
          evidence: [{ kind: "protocol-field", description: "ok", data: true }],
        },
        output: { echo: String(input.value ?? ""), status: "ok" },
        rawOutput: { stdout: "hello-stdout", stderr: "hello-stderr" },
        sideEffects: [{ kind: "process-exec", description: "样例进程", reversible: false }],
        command: { file: "node", args: ["sample.js"] },
      })),
  };
  const provider: CapabilityProvider = {
    id: "demo",
    version: "0.1.0",
    description: "样例 provider",
    status: () => ({ state: "available", detail: "ok" }),
    capabilities: () => [{ descriptor, implementation }],
    binding: DEMO_BINDING,
  };
  const registry = new CapabilityRegistry();
  try {
    registry.registerProvider(provider);
  } catch (err) {
    throw new Error(`fixture 注册失败: ${err instanceof CapabilityRegistrationError ? err.errors.join("；") : String(err)}`);
  }
  return registry;
}

function request(project: TempProject, overrides: Partial<CapabilityRunRequest> = {}): CapabilityRunRequest {
  return {
    capabilityId: "demo.sample",
    projectRoot: project.root,
    input: { value: "x" },
    persist: false,
    ...overrides,
  };
}

describe("runCapability：请求级失败（抛出 CapabilityError）", () => {
  it("未注册 capability", async () => {
    const project = tempProject();
    await expect(runCapability(makeRegistry(), request(project, { capabilityId: "nope.nope" }))).rejects.toThrow(
      /未注册的 capability/,
    );
  });

  it("工程根不存在 / 不是目录", async () => {
    const project = tempProject();
    await expect(
      runCapability(makeRegistry(), request(project, { projectRoot: path.join(project.root, "missing") })),
    ).rejects.toMatchObject({ structured: { code: "project-root-missing" } });
    const file = path.join(project.root, "a-file.txt");
    fs.writeFileSync(file, "x");
    await expect(runCapability(makeRegistry(), request(project, { projectRoot: file }))).rejects.toMatchObject({
      structured: { code: "project-root-not-directory" },
    });
  });

  it("配置缺失时给出初始化指引", async () => {
    const project = tempProject();
    fs.rmSync(path.join(project.root, ".vant", "config", "v-cli.json"));
    try {
      await runCapability(makeRegistry(), request(project));
      throw new Error("应当抛出");
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityError);
      const structured = (err as CapabilityError).structured;
      expect(structured.code).toBe("project-config-missing");
      expect(structured.category).toBe("config");
      expect(String(structured.details && (structured.details as { hint: string }).hint)).toContain("project init");
    }
  });

  it("operationId 非法 / 已存在都拒绝", async () => {
    const project = tempProject();
    const registry = makeRegistry();
    for (const bad of ["..", "a/b", "a\\b", ".hidden", "", "x".repeat(129)]) {
      await expect(
        runCapability(registry, request(project, { persist: true, operationId: bad })),
      ).rejects.toMatchObject({ structured: { code: "operation-id-invalid" } });
    }
    const first = await runCapability(registry, request(project, { persist: true, operationId: "fixed-id-1" }));
    expect(first.persisted.status).toBe("saved");
    // 内核把"已存在"翻译为请求级失败（CLI 退出 2，错误 code=operation-exists）
    await expect(
      runCapability(registry, request(project, { persist: true, operationId: "fixed-id-1" })),
    ).rejects.toMatchObject({ structured: { code: "operation-exists", category: "request" } });
    // store 层同样拒绝覆盖（直接调用时抛出专用错误）
    expect(() =>
      OperationStore.reserve(resolveProjectRoot(project.root), "fixed-id-1"),
    ).toThrow(OperationExistsError);
  });
});

describe("runCapability：输入/输出真实校验", () => {
  it("输入违反 schema：未执行、退出码 2、错误分类 request", async () => {
    const project = tempProject();
    let executed = 0;
    const registry = makeRegistry({
      execute: async () => {
        executed++;
        return { execution: { status: "succeeded", lifecycle: "completed" }, acceptance: { status: "not-run", reason: "" } };
      },
    });
    const result = await runCapability(
      registry,
      request(project, { input: { value: "x", extra: true }, persist: true }),
    );
    expect(executed).toBe(0);
    expect(result.execution.status).toBe("failed");
    expect(result.execution.attempts).toBe(0);
    expect(result.execution.error?.code).toBe("input-invalid");
    expect(result.execution.error?.category).toBe("request");
    expect(result.acceptance.status).toBe("not-run");
    expect(exitCodeForResult(result)).toBe(2);
    // 失败也留证据（input.json / result.json）
    expect(result.persisted.files).toContain("input.json");
    expect(result.persisted.files).toContain("result.json");
  });

  it("输入不接受 projectPath 覆盖（additionalProperties=false）", async () => {
    const project = tempProject();
    const result = await runCapability(
      makeRegistry(),
      request(project, { input: { value: "x", projectPath: "C:/other" } }),
    );
    expect(result.execution.error?.code).toBe("input-invalid");
    expect(JSON.stringify(result.execution.error?.details)).toContain("projectPath");
  });

  it("输出违反 schema：执行结果降级为 unknown（契约违约），验收 not-run", async () => {
    const project = tempProject();
    const registry = makeRegistry({
      execute: async () => ({
        execution: { status: "succeeded", lifecycle: "completed", exitCode: 0 },
        acceptance: {
          status: "passed",
          reason: "实现自称通过",
          evidence: [{ kind: "protocol-field", description: "x", data: 1 }],
        },
        output: { echo: 42 as unknown as string },
      }),
    });
    const result = await runCapability(registry, request(project));
    expect(result.execution.status).toBe("unknown");
    expect(result.execution.error?.code).toBe("output-contract-violation");
    expect(result.execution.error?.category).toBe("output");
    expect(result.acceptance.status).toBe("not-run");
    expect(exitCodeForResult(result)).toBe(5);
  });

  it("成功执行但未给输出同样视为契约违约", async () => {
    const project = tempProject();
    const registry = makeRegistry({
      execute: async () => ({
        execution: { status: "succeeded", lifecycle: "completed" },
        acceptance: { status: "not-run", reason: "" },
      }),
    });
    const result = await runCapability(registry, request(project));
    expect(result.execution.error?.code).toBe("output-missing");
    expect(exitCodeForResult(result)).toBe(5);
  });

  it("实现返回畸形结构（缺 acceptance / 非法状态）→ 契约违约 unknown，不崩溃", async () => {
    const project = tempProject();
    const registry = makeRegistry({
      execute: (async () => ({
        execution: { status: "success", lifecycle: "completed" },
        acceptance: undefined,
      })) as unknown as CapabilityImplementation["execute"],
    });
    const result = await runCapability(registry, request(project));
    expect(result.execution.status).toBe("unknown");
    expect(result.execution.error?.code).toBe("implementation-contract-violation");
    expect(result.acceptance.status).toBe("not-run");
    expect(exitCodeForResult(result)).toBe(5);
  });

  it("实现返回违约但自称 passed 且带证据：验收被压成 not-run，退出码 5（绝不 0）", async () => {
    const project = tempProject();
    const registry = makeRegistry({
      execute: (async () => ({
        execution: { status: "succeeded", lifecycle: "finished" },
        acceptance: {
          status: "passed",
          reason: "自称通过",
          evidence: [{ kind: "protocol-field", description: "x", data: 1 }],
        },
      })) as unknown as CapabilityImplementation["execute"],
    });
    const result = await runCapability(registry, request(project));
    expect(result.execution.status).toBe("unknown");
    expect(result.acceptance.status).toBe("not-run");
    expect(exitCodeForResult(result)).toBe(5);
  });

  it("实现返回非对象 → 契约违约 unknown", async () => {
    const project = tempProject();
    const registry = makeRegistry({
      execute: (async () => null) as unknown as CapabilityImplementation["execute"],
    });
    const result = await runCapability(registry, request(project));
    expect(result.execution.error?.code).toBe("implementation-contract-violation");
    expect(result.execution.status).toBe("unknown");
  });

  it("上报未声明的副作用类型 → 契约违约（unknown）", async () => {
    const project = tempProject();
    const registry = makeRegistry({
      execute: async () => ({
        execution: { status: "succeeded", lifecycle: "completed" },
        acceptance: { status: "not-run", reason: "" },
        output: { echo: "x" },
        sideEffects: [{ kind: "network", description: "偷偷联网", reversible: false }],
      }),
      descriptor: { sideEffects: [] },
    });
    const result = await runCapability(registry, request(project));
    expect(result.execution.error?.code).toBe("side-effect-undeclared");
    expect(result.execution.status).toBe("unknown");
  });
});

describe("runCapability：执行状态与验收状态分离", () => {
  it("执行失败时实现自称 passed 会被降级为 not-run", async () => {
    const project = tempProject();
    const registry = makeRegistry({
      execute: async () => ({
        execution: { status: "failed", lifecycle: "completed", exitCode: 1, error: { code: "boom", category: "process", message: "炸了", retryable: false } },
        acceptance: { status: "passed", reason: "不该通过", evidence: [{ kind: "process-exit", description: "exit=1" }] },
        rawOutput: { stdout: "", stderr: "boom" },
      }),
    });
    const result = await runCapability(registry, request(project, { persist: true }));
    expect(result.execution.status).toBe("failed");
    expect(result.acceptance.status).toBe("not-run");
    expect(result.acceptance.reason).toContain("降级");
    expect(exitCodeForResult(result)).toBe(1);
    expect(fs.existsSync(path.join(result.persisted.dir!, "result.json"))).toBe(true);
  });

  it("passed 缺证据被内核拒绝（not-run）", async () => {
    const project = tempProject();
    const registry = makeRegistry({
      execute: async () => ({
        execution: { status: "succeeded", lifecycle: "completed" },
        acceptance: { status: "passed", reason: "无证据", evidence: [] },
        output: { echo: "x" },
      }),
    });
    const result = await runCapability(registry, request(project));
    expect(result.acceptance.status).toBe("not-run");
    expect(result.acceptance.reason).toContain("缺少证据");
  });

  it("执行成功但验收 failed（业务失败）→ 退出码 1；execution 仍为 succeeded", async () => {
    const project = tempProject();
    const registry = makeRegistry({
      execute: async () => ({
        execution: { status: "succeeded", lifecycle: "completed", exitCode: 0 },
        acceptance: {
          status: "failed",
          reason: "测试有失败用例",
          evidence: [{ kind: "protocol-field", description: "failed", data: 2 }],
        },
        output: { echo: "x" },
      }),
    });
    const result = await runCapability(registry, request(project));
    expect(result.execution.status).toBe("succeeded");
    expect(result.acceptance.status).toBe("failed");
    expect(exitCodeForResult(result)).toBe(1);
  });

  it("验收 not-run（异步启动）→ 退出码 3，pending 透传", async () => {
    const project = tempProject();
    const registry = makeRegistry({
      execute: async () => ({
        execution: { status: "succeeded", lifecycle: "accepted", exitCode: 0 },
        acceptance: { status: "not-run", reason: "已启动，需轮询", pending: true, evidence: [] },
        output: { echo: "x" },
        followUp: [{ capabilityId: "demo.sample", hint: "轮询" }],
      }),
    });
    const result = await runCapability(registry, request(project));
    expect(result.execution.lifecycle).toBe("accepted");
    expect(result.acceptance.pending).toBe(true);
    expect(result.followUp[0].hint).toBe("轮询");
    expect(exitCodeForResult(result)).toBe(3);
  });
});

describe("runCapability：前置条件 fail-closed", () => {
  const checks = {
    "demo.ready": (() => ({ id: "demo.ready", status: "satisfied" as const, detail: "ok" })),
    "demo.block": (() => ({ id: "demo.block", status: "violated" as const, detail: "未就绪" })),
    "demo.unknown": (() => ({ id: "demo.unknown", status: "unknown" as const, detail: "查不到" })),
    "demo.skip": (() => ({ id: "demo.skip", status: "skipped" as const, detail: "跳过" })),
  };

  function withPreconditions(ids: string[]): CapabilityRegistry {
    return makeRegistry({
      descriptor: { preconditions: ids.map((id) => ({ id, description: id })) },
      preconditions: Object.fromEntries(ids.map((id) => [id, checks[id as keyof typeof checks]])),
    });
  }

  it("violated → 未执行、退出码 2", async () => {
    const project = tempProject();
    let executed = 0;
    const registry = makeRegistry({
      descriptor: { preconditions: [{ id: "demo.block", description: "block" }] },
      preconditions: { "demo.block": checks["demo.block"] },
      execute: async () => {
        executed++;
        return { execution: { status: "succeeded", lifecycle: "completed" }, acceptance: { status: "not-run", reason: "" } };
      },
    });
    const result = await runCapability(registry, request(project));
    expect(executed).toBe(0);
    expect(result.execution.error?.category).toBe("precondition");
    expect(result.preconditions[0].status).toBe("violated");
    expect(exitCodeForResult(result)).toBe(2);
  });

  it("unknown 也 fail-closed（不执行）", async () => {
    const project = tempProject();
    let executed = 0;
    const registry = makeRegistry({
      descriptor: { preconditions: [{ id: "demo.unknown", description: "unknown" }] },
      preconditions: { "demo.unknown": checks["demo.unknown"] },
      execute: async () => {
        executed++;
        return { execution: { status: "succeeded", lifecycle: "completed" }, acceptance: { status: "not-run", reason: "" } };
      },
    });
    const result = await runCapability(registry, request(project));
    expect(executed).toBe(0);
    expect(exitCodeForResult(result)).toBe(2);
  });

  it("skipped 不允许绕过前置条件", async () => {
    const project = tempProject();
    const registry = withPreconditions(["demo.ready", "demo.skip"]);
    const result = await runCapability(registry, request(project));
    expect(result.execution.status).toBe("failed");
    expect(result.preconditions.map((p) => p.status)).toEqual(["satisfied", "unknown"]);
    expect(result.execution.error?.category).toBe("precondition");
  });

  it("检查实现抛异常 → unknown（不执行）", async () => {
    const project = tempProject();
    const registry = makeRegistry({
      descriptor: { preconditions: [{ id: "demo.ready", description: "ready" }] },
      preconditions: {
        "demo.ready": () => {
          throw new Error("check boom");
        },
      },
    });
    const result = await runCapability(registry, request(project));
    expect(result.preconditions[0].status).toBe("unknown");
    expect(result.preconditions[0].detail).toContain("check boom");
    expect(exitCodeForResult(result)).toBe(2);
  });
});

describe("runCapability：资源授权由组织层注入", () => {
  it("未注入授权钩子 → not-enforced（不假装有锁）", async () => {
    const project = tempProject();
    const result = await runCapability(makeRegistry(), request(project));
    expect(result.resources.authorization).toBe("not-enforced");
    expect(result.resources.declared).toHaveLength(1);
  });

  it("授权通过 → granted + grantId；拒绝 → 未执行、category=resource、退出码 2", async () => {
    const project = tempProject();
    const grant: ResourceAuthorizer = () => ({ granted: true, grantId: "lease-1" });
    const granted = await runCapability(makeRegistry(), request(project, { authorize: grant }));
    expect(granted.resources.authorization).toBe("granted");
    expect(granted.resources.grantId).toBe("lease-1");

    let executed = 0;
    const deny: ResourceAuthorizer = () => ({
      granted: false,
      reason: "工程被其他任务占用",
      denials: [{ kind: "project-workspace", reason: "lease held" }],
    });
    const registry = makeRegistry({
      execute: async () => {
        executed++;
        return { execution: { status: "succeeded", lifecycle: "completed" }, acceptance: { status: "not-run", reason: "" } };
      },
    });
    const denied = await runCapability(registry, request(project, { authorize: deny }));
    expect(executed).toBe(0);
    expect(denied.execution.error?.category).toBe("resource");
    expect(denied.resources.authorization).toBe("denied");
    expect(denied.resources.denials[0].reason).toBe("lease held");
    expect(exitCodeForResult(denied)).toBe(2);
  });

  it("授权钩子抛异常 → category=resource、未执行", async () => {
    const project = tempProject();
    const result = await runCapability(
      makeRegistry(),
      request(project, {
        authorize: () => {
          throw new Error("lease service down");
        },
      }),
    );
    expect(result.execution.error?.code).toBe("resource-authorization-error");
    expect(exitCodeForResult(result)).toBe(2);
  });
});

describe("落盘记录与脱敏", () => {
  it("持久化写入 input.json/events.jsonl/stdout.log/stderr.log/result.json，凭据字段被脱敏", async () => {
    const project = tempProject();
    const result = await runCapability(
      makeRegistry(),
      request(project, { persist: true, input: { value: "x", secret: "super-secret" } }),
    );
    expect(result.persisted.status).toBe("saved");
    const dir = result.persisted.dir!;
    for (const file of ["input.json", "events.jsonl", "stdout.log", "stderr.log", "result.json"]) {
      expect(fs.existsSync(path.join(dir, file)), file).toBe(true);
    }
    const input = JSON.parse(fs.readFileSync(path.join(dir, "input.json"), "utf-8"));
    expect(input.input.secret).toBe("***redacted***");
    expect(input.redactedPaths).toContain("$.secret");
    expect(fs.readFileSync(path.join(dir, "stdout.log"), "utf-8")).toBe("hello-stdout");
    expect(result.logs.stdout.bytes).toBe("hello-stdout".length);
    expect(result.artifacts.some((a) => a.kind === "log")).toBe(true);
    const events = fs.readFileSync(path.join(dir, "events.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(events.map((e) => e.type)).toContain("operation-reserved");
    expect(events.map((e) => e.type)).toContain("execute-start");
  });

  it("--no-persist（persist=false）不创建任何目录，结果标记 disabled", async () => {
    const project = tempProject();
    const result = await runCapability(makeRegistry(), request(project, { persist: false }));
    expect(result.persisted.status).toBe("disabled");
    expect(result.persisted.dir).toBeNull();
    expect(fs.existsSync(path.join(project.root, ".vant", "state"))).toBe(false);
  });

  it("外部 taskId/runId 透传", async () => {
    const project = tempProject();
    const result = await runCapability(
      makeRegistry(),
      request(project, { persist: true, taskId: "task-7", runId: "run-3" }),
    );
    expect(result.invocation.taskId).toBe("task-7");
    expect(result.invocation.runId).toBe("run-3");
  });
});

describe("executionFromProcess / exitCodeForResult 语义", () => {
  function outcome(overrides: Partial<ProcessOutcome> = {}): ProcessOutcome {
    return {
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      aborted: false,
      killConfirmed: false,
      durationMs: 1,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      error: null,
      ...overrides,
    };
  }

  it("exit 0 → succeeded；非零 → failed；spawn 失败 → failed", () => {
    expect(executionFromProcess(outcome()).status).toBe("succeeded");
    expect(executionFromProcess(outcome({ exitCode: 3 })).error?.code).toBe("process-exit-nonzero");
    expect(executionFromProcess(outcome({ error: { code: "ENOENT", message: "not found" } })).error?.code).toBe(
      "process-spawn-failed",
    );
  });

  it("超时 → unknown（业务结论不可知，不冒充失败或取消）", () => {
    const exec = executionFromProcess(outcome({ timedOut: true, exitCode: null, signal: "SIGKILL" }));
    expect(exec.status).toBe("unknown");
    expect(exec.error?.code).toBe("process-timeout");
  });

  it("取消：确认杀进程才是 cancelled，否则 unknown（不得标记已取消）", () => {
    expect(executionFromProcess(outcome({ aborted: true, killConfirmed: true, exitCode: null, signal: "SIGKILL" })).status).toBe(
      "cancelled",
    );
    const unconfirmed = executionFromProcess(outcome({ aborted: true, killConfirmed: false, exitCode: null }));
    expect(unconfirmed.status).toBe("unknown");
    expect(unconfirmed.error?.code).toBe("cancel-unconfirmed");
  });

  it("退出码映射表：0/1/2/3/4/5", async () => {
    const project = tempProject();
    const cases: { execution: { status: "succeeded" | "failed" | "cancelled" | "unknown"; category?: string }; acceptance: "passed" | "failed" | "not-run"; expected: number }[] = [
      { execution: { status: "succeeded" }, acceptance: "passed", expected: 0 },
      { execution: { status: "succeeded" }, acceptance: "failed", expected: 1 },
      { execution: { status: "failed" }, acceptance: "not-run", expected: 1 },
      { execution: { status: "failed", category: "precondition" }, acceptance: "not-run", expected: 2 },
      { execution: { status: "succeeded" }, acceptance: "not-run", expected: 3 },
      { execution: { status: "cancelled" }, acceptance: "not-run", expected: 4 },
      { execution: { status: "unknown" }, acceptance: "not-run", expected: 5 },
    ];
    for (const item of cases) {
      const registry = makeRegistry({
        execute: async () => ({
          execution: {
            status: item.execution.status,
            lifecycle: "completed",
            error: item.execution.category
              ? { code: "x", category: item.execution.category as "precondition", message: "m", retryable: false }
              : null,
          },
          acceptance:
            item.acceptance === "passed"
              ? { status: "passed", reason: "r", evidence: [{ kind: "protocol-field", description: "e", data: 1 }] }
              : { status: item.acceptance, reason: "r" },
          output: { echo: "x" },
        }),
      });
      const result = await runCapability(registry, request(project));
      expect(exitCodeForResult(result), JSON.stringify(item)).toBe(item.expected);
    }
  });
});

describe("operationId 校验", () => {
  it("合法/非法取值", () => {
    expect(validateOperationId("abc-123_x.y")).toEqual([]);
    for (const bad of ["", "..", ".x", "a b", "a/b", "a\\b", "x".repeat(129), "CON", "com1"]) {
      expect(validateOperationId(bad).length, bad).toBeGreaterThan(0);
    }
  });
});

describe("审查回归：取消、授权与异步验收", () => {
  it("执行前取消不调用实现", async () => {
    const p = tempProject(); const c = new AbortController(); c.abort(); let called = false;
    const registry = makeRegistry({ execute: async () => { called = true; throw new Error("不应调用"); } });
    const result = await runCapability(registry, request(p, { signal: c.signal }));
    expect(called).toBe(false); expect(result.execution.status).toBe("cancelled"); expect(result.execution.attempts).toBe(0);
  });
  it("验收红线：任务仅被接受（accepted）或状态不可解释（unknown）时不得自称 passed", async () => {
    for (const lifecycle of ["accepted", "unknown"] as const) {
      const p = tempProject();
      const registry = makeRegistry({
        execute: async () => ({
          execution: { status: "succeeded", lifecycle },
          acceptance: { status: "passed", reason: "受理", evidence: [{ kind: "declared", description: "ok" }] },
          output: { echo: "x" },
        }),
      });
      const result = await runCapability(registry, request(p));
      expect(result.acceptance.status, lifecycle).toBe("not-run");
      expect(result.acceptance.reason).toContain("降级");
    }
  });

  it("六态契约：任务级 running/failed/cancelled 允许能力自身的 passed（观察/关联/取消类验收目标）", async () => {
    for (const lifecycle of ["completed", "running", "failed", "cancelled"] as const) {
      const p = tempProject();
      const registry = makeRegistry({
        execute: async () => ({
          execution: { status: "succeeded", lifecycle },
          acceptance: { status: "passed", reason: "观察/关联成立", evidence: [{ kind: "declared", description: "ok" }] },
          output: { echo: "x" },
        }),
      });
      const result = await runCapability(registry, request(p));
      expect(result.acceptance.status, lifecycle).toBe("passed");
    }
  });
  it("授权钩子非布尔 true 按拒绝处理", async () => {
    const p = tempProject(); const result = await runCapability(makeRegistry(), request(p, { authorize: (async () => ({ granted: "true" })) as any }));
    expect(result.resources.authorization).toBe("denied"); expect(result.execution.attempts).toBe(0);
  });
});
