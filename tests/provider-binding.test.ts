/**
 * 阶段 B 验收：通用 Provider 绑定契约。
 *
 * 覆盖计划 §5 验收标准：
 * - 第三方样本 Provider 仅实现 Provider 模块即可接入（注册 + 通过执行内核运行成功）；
 * - 各 Provider 绑定分别校验；当前能力所需绑定缺失时明确失败（前置条件）；
 * - 已声明的无效绑定 fail-closed；无关 Provider 缺失绑定不阻断；
 * - 绝对路径 / 父目录穿越 / 链接越界 / 危险键在工具执行前被拒绝；
 * - 核心对 resolve 结果的强核对：谎报路径 / 夹带未声明键 / 抛错 / 返回错误 / 返回畸形一律拒绝。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilityRegistry } from "../src/core/execution/registry";
import { runCapability } from "../src/core/execution/runtime";
import type { ProcessExecutor } from "../src/core/execution/executor";
import {
  initProjectConfig,
  loadProjectConfig,
  resolveBindings,
  toProviderSet,
} from "../src/core/project/config";
import { resolveProjectRoot } from "../src/core/project/paths";
import { createUnityProvider } from "../src/providers/unity";
import { createSampleProvider, sampleBindingContract } from "./helpers/sample-provider";
import type { ProviderBindingResolution } from "../src/core/execution/types";
import { makeTempProject, tryLinkDir, type TempProject } from "./helpers/unity-fixtures";

const projects: TempProject[] = [];
afterEach(() => {
  for (const p of projects.splice(0)) p.cleanup();
});

const stubExecutor: ProcessExecutor = {
  run: async () => {
    throw new Error("本测试不执行真实进程");
  },
};

function tempProject(config: unknown = { schemaVersion: 1, bindings: { sample: { workspaceDir: "Client" } } }): TempProject {
  const project = makeTempProject({ config, withProjectVersion: false });
  projects.push(project);
  return project;
}

describe("第三方 Provider 接入（仅实现 Provider 模块，不改核心源文件）", () => {
  it("样本 Provider 注册、绑定解析、能力执行全链路成功", async () => {
    const project = tempProject();
    const registry = new CapabilityRegistry();
    registry.registerProvider(createSampleProvider());
    expect(registry.list().map((c) => c.id)).toEqual(["sample.cancel", "sample.echo", "sample.query", "sample.trigger"]);

    const result = await runCapability(registry, {
      capabilityId: "sample.echo",
      projectRoot: project.root,
      input: { message: "你好" },
      persist: false,
    });
    expect(result.execution.status).toBe("succeeded");
    expect(result.acceptance.status).toBe("passed");
    expect(result.output).toEqual({ message: "你好", workspaceDir: path.join(project.root, "Client") });
    // ctx.binding 注入了该 Provider 的已校验段
    expect(result.project.bindingDirs).toEqual({ sample: { workspaceDir: path.join(project.root, "Client") } });
  });

  it("当前能力所需绑定缺失时：明确失败（前置条件 violated，不执行）", async () => {
    // 绑定段整体缺失（外壳有效）→ 该能力的前置条件明确失败
    const project = tempProject({ schemaVersion: 1, bindings: {} });
    const registry = new CapabilityRegistry();
    registry.registerProvider(createSampleProvider());
    const result = await runCapability(registry, {
      capabilityId: "sample.echo",
      projectRoot: project.root,
      input: { message: "x" },
      persist: false,
    });
    expect(result.execution.status).toBe("failed");
    expect(result.execution.error?.category).toBe("precondition");
    expect(result.acceptance.status).toBe("not-run");
    expect(result.preconditions[0]).toMatchObject({ id: "sample.binding", status: "violated" });
  });
});

describe("核心强核对：resolve 结果不可信，路径以核心重解析为准", () => {
  it("Provider 谎报解析路径 → 绑定无效", () => {
    const project = tempProject();
    const providers = toProviderSet([createSampleProvider({ bindingBehavior: { liePath: "C:/elsewhere" } })]);
    const loaded = loadProjectConfig(resolveProjectRoot(project.root), providers);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.errors.join()).toContain("解析不一致");
  });

  it("resolve 夹带未声明的 dirs 键 → 绑定无效", () => {
    const project = tempProject();
    const providers = toProviderSet([createSampleProvider({ bindingBehavior: { smuggleKey: { evil: "C:/x" } } })]);
    const loaded = loadProjectConfig(resolveProjectRoot(project.root), providers);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.errors.join()).toContain('未声明的路径字段 "evil"');
  });

  it("resolve 抛错 / 返回 errors / 返回畸形 → 绑定无效且错误可读", () => {
    const project = tempProject();
    for (const behavior of ["throw", "return-errors", "return-garbage"] as const) {
      const providers = toProviderSet([createSampleProvider({ bindingBehavior: behavior })]);
      const loaded = loadProjectConfig(resolveProjectRoot(project.root), providers);
      expect(loaded.ok, behavior).toBe(false);
      if (!loaded.ok) {
        expect(loaded.errors.join(), behavior).toContain("bindings.sample");
      }
    }
  });

  it("可选路径字段未提供却出现在解析结果中 → 绑定无效", () => {
    const project = tempProject();
    const contract = sampleBindingContract("honest");
    const providers = toProviderSet([
      createSampleProvider({
        bindingBehavior: "honest",
      }),
    ]);
    // 直接对 resolveBindings 造一个"未提供 configFile 却报告了"的 provider
    const lyingOptional = {
      ...createSampleProvider(),
      binding: {
        ...contract,
        resolve: (): ProviderBindingResolution => ({
          ok: true,
          dirs: { workspaceDir: path.join(project.root, "Client") },
          files: { configFile: "C:/nope" },
          warnings: [],
        }),
      },
    };
    const loaded = loadProjectConfig(resolveProjectRoot(project.root), toProviderSet([lyingOptional]));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.errors.join()).toContain("configFile 未提供却出现在解析结果中");
    expect(providers.size).toBe(1);
  });
});

describe("失败语义（计划 §5）", () => {
  it("无关 Provider 缺失绑定不阻断：unity 能力照常可用（前置条件链路完整）", async () => {
    // 只绑定 unity；sample 未绑定（unbound），unity 的 doctor 前置条件因后端不可用而失败——但不是配置错误
    const project = tempProject({ schemaVersion: 1, bindings: { unity: { projectDir: "Client" } } });
    const registry = new CapabilityRegistry();
    registry.registerProvider(createUnityProvider({ executor: stubExecutor }));
    registry.registerProvider(createSampleProvider());
    const result = await runCapability(registry, {
      capabilityId: "unity.doctor",
      projectRoot: project.root,
      input: {},
      persist: false,
    });
    // 配置加载成功；失败来自前置条件（后端发现），错误类别是 precondition 而非 config
    expect(result.execution.error?.category).toBe("precondition");
    expect(result.acceptance.status).toBe("not-run");
  });

  it("已声明的无效绑定 fail-closed：另一个 Provider 的正确绑定也不可用", () => {
    const project = tempProject({
      schemaVersion: 1,
      bindings: {
        unity: { projectDir: "Client" },
        sample: { workspaceDir: "../../outside" },
      },
    });
    const registry = new CapabilityRegistry();
    registry.registerProvider(createUnityProvider({ executor: stubExecutor }));
    registry.registerProvider(createSampleProvider());
    const loaded = loadProjectConfig(resolveProjectRoot(project.root), toProviderSet(registry.listProviders()));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.errors.join()).toContain("禁止");
  });
});

describe("路径与危险键在执行前被拒绝", () => {
  it("绝对路径 / 穿越在 loadProjectConfig 即失败（不进入执行）", () => {
    for (const bad of ["C:/abs", "../outside", "a/../b"]) {
      const project = tempProject({ schemaVersion: 1, bindings: { sample: { workspaceDir: bad } } });
      const loaded = loadProjectConfig(resolveProjectRoot(project.root), toProviderSet([createSampleProvider()]));
      expect(loaded.ok, bad).toBe(false);
    }
  });

  it("绑定目录是越界链接 → 拒绝", () => {
    const project = tempProject();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "vcli-bind-out-"));
    const linkPath = path.join(project.root, "Linked");
    if (!tryLinkDir(outside, linkPath)) {
      expect(true).toBe(true);
      return;
    }
    fs.writeFileSync(
      project.configFile,
      JSON.stringify({ schemaVersion: 1, bindings: { sample: { workspaceDir: "Linked" } } }),
    );
    const loaded = loadProjectConfig(resolveProjectRoot(project.root), toProviderSet([createSampleProvider()]));
    expect(loaded.ok).toBe(false);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("__proto__ 等危险键在配置外壳层被拒绝（loadProjectConfig 全链路）", () => {
    const project = tempProject();
    fs.writeFileSync(
      project.configFile,
      '{ "schemaVersion": 1, "bindings": { "sample": { "workspaceDir": "Client" } }, "__proto__": { "x": 1 } }',
    );
    const loaded = loadProjectConfig(resolveProjectRoot(project.root), toProviderSet([createSampleProvider()]));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.errors.join()).toContain("危险键");
  });
});

describe("project init 与注册集合一致", () => {
  it("无 defaultBinding 的 Provider 不生成段；有则生成并可被 --binding 完整替换", () => {
    const noDefault = createSampleProvider();
    delete (noDefault as { defaultBinding?: unknown }).defaultBinding;
    const project = tempProject();
    fs.rmSync(project.configFile);
    const providers = toProviderSet([createUnityProvider({ executor: stubExecutor }), noDefault]);
    const created = initProjectConfig(resolveProjectRoot(project.root), providers, {
      unity: { projectDir: "." },
    });
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(Object.keys(created.bindings)).toEqual(["unity"]);
      expect(created.bindings.unity).toEqual({ projectDir: "." });
    }
  });
});

describe("一审修复回归", () => {
  it("resolve 返回 ok 但缺 dirs/files（畸形）→ 结构化拒绝而非崩溃", () => {
    const project = tempProject();
    const malformed = {
      ...createSampleProvider(),
      binding: {
        schema: createSampleProvider().binding.schema,
        pathFields: [{ field: "workspaceDir", kind: "dir" as const, required: true }],
        resolve: (): ProviderBindingResolution =>
          ({ ok: true, warnings: [] }) as unknown as ProviderBindingResolution,
      },
    };
    const loaded = loadProjectConfig(resolveProjectRoot(project.root), toProviderSet([malformed]));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.errors.join()).toContain("dirs 必须是对象");
  });

  it("注册后修改原始 provider 的 binding 契约不影响注册表校验规则", () => {
    const sample = createSampleProvider();
    const registry = new CapabilityRegistry();
    registry.registerProvider(sample);
    // 注册方事后污染原始对象（深拷贝 + 冻结防护应使其无效）
    // 运行时污染（JS 调用方绕过编译期 readonly 约束）
    (sample.binding.pathFields as unknown as { push(v: unknown): void }).push({ field: "smuggled", kind: "dir", required: false });
    (sample.binding.schema as { properties: Record<string, unknown> }).properties.smuggled = {
      type: "string",
    };
    const stored = registry.getProvider("sample")!;
    expect(stored.binding.pathFields.map((f) => f.field)).toEqual(["workspaceDir", "configFile"]);
    expect(Object.keys((stored.binding.schema as { properties: Record<string, unknown> }).properties)).toEqual([
      "workspaceDir",
      "configFile",
    ]);
    expect(Object.isFrozen(stored.binding.pathFields)).toBe(true);
    // describe 暴露的是注册时快照的契约
    const described = registry.describe("sample.echo")!;
    expect(described.provider.binding.pathFields.map((f) => f.field)).toEqual(["workspaceDir", "configFile"]);
    expect(Object.keys((described.provider.binding.schema as { properties?: Record<string, unknown> }).properties ?? {})).toEqual(["workspaceDir", "configFile"]);
  });

  it("capability describe 暴露 provider 绑定契约（schema + pathFields）", () => {
    const registry = new CapabilityRegistry();
    registry.registerProvider(createSampleProvider());
    const described = registry.describe("sample.echo")!;
    expect(described.provider.binding.schema.type).toBe("object");
    expect(described.provider.binding.pathFields).toEqual([
      { field: "workspaceDir", kind: "dir", required: true },
      { field: "configFile", kind: "file", required: false },
    ]);
  });

  it("createDefaultRegistry({ providers }) 完全替代内置装配", async () => {
    const { createDefaultRegistry } = await import("../src/default-registry");
    const registry = createDefaultRegistry({ providers: [createSampleProvider()] });
    expect(registry.providers().map((p) => p.id)).toEqual(["sample"]);
    expect(registry.list().map((c) => c.id)).toEqual(["sample.cancel", "sample.echo", "sample.query", "sample.trigger"]);
    // 缺省装配仍是内置 unity
    const builtin = createDefaultRegistry({ executor: stubExecutor });
    expect(builtin.providers().map((p) => p.id)).toEqual(["unity"]);
  });

  it("绑定段内部嵌套的危险键被 validateValue 纵深拒绝", () => {
    const project = tempProject();
    fs.writeFileSync(
      project.configFile,
      '{ "schemaVersion": 1, "bindings": { "sample": { "workspaceDir": "Client", "__proto__": { "x": 1 } } } }',
    );
    const loaded = loadProjectConfig(resolveProjectRoot(project.root), toProviderSet([createSampleProvider()]));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.errors.join()).toContain("危险键");
  });
});
