import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  initProjectConfig,
  inspectProject,
  loadProjectConfig,
  PROJECT_CLI_CONFIG_RELATIVE,
  renderProjectConfig,
  toProviderSet,
  validateProjectCliConfig,
  VANT_PROJECT_CONFIG_RELATIVE,
  type ProviderSet,
} from "../src/core/project/config";
import { PathSafetyError, resolveInsideProject, resolveProjectRoot, splitSafeRelative } from "../src/core/project/paths";
import { OperationExistsError, OperationStore } from "../src/core/project/operation-store";
import { redactArgv, redactSecrets } from "../src/core/project/redact";
import { createUnityProvider } from "../src/providers/unity";
import type { ProcessExecutor } from "../src/core/execution/executor";
import { createSampleProvider } from "./helpers/sample-provider";
import { makeTempProject, tryLinkDir, type TempProject } from "./helpers/unity-fixtures";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

const stubExecutor: ProcessExecutor = {
  run: async () => {
    throw new Error("绑定测试不执行进程");
  },
};

/** 测试用 Provider 集合：真实 unity（绑定契约）+ 第三方样本 Provider */
function testProviders(withSample = true): ProviderSet {
  const providers = [createUnityProvider({ executor: stubExecutor })];
  if (withSample) providers.push(createSampleProvider());
  return toProviderSet(providers);
}

function project(options: Parameters<typeof makeTempProject>[0] = {}): TempProject {
  const p = makeTempProject(options);
  cleanups.push(p.cleanup);
  return p;
}

function newDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vcli-path-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("工程根锚定与路径安全", () => {
  it("resolveProjectRoot：缺失/非目录拒绝，正常目录返回 realRoot", () => {
    const root = newDir();
    expect(() => resolveProjectRoot(path.join(root, "nope"))).toThrow(PathSafetyError);
    const file = path.join(root, "f.txt");
    fs.writeFileSync(file, "x");
    expect(() => resolveProjectRoot(file)).toThrow(/不是目录/);
    const resolved = resolveProjectRoot(root);
    expect(resolved.root).toBe(root);
    expect(resolved.realRoot.length).toBeGreaterThan(0);
  });

  it("splitSafeRelative：绝对路径 / .. / . / 空段 / NUL 都拒绝", () => {
    for (const bad of ["C:/abs", "C:\\abs", "/abs", "\\\\server\\share", "a/../b", "../b", "./a", "a\0b", ""]) {
      expect(() => splitSafeRelative(bad, "x"), bad).toThrow(PathSafetyError);
    }
    expect(splitSafeRelative("Client/Assets", "x")).toEqual(["Client", "Assets"]);
    expect(splitSafeRelative("Client\\Assets", "x")).toEqual(["Client", "Assets"]);
    // 重复分隔符被折叠（仍在根内，不构成越界）
    expect(splitSafeRelative("a//b", "x")).toEqual(["a", "b"]);
  });

  it("目录链接（junction/symlink）越界：resolveInsideProject 拒绝", () => {
    const root = newDir();
    const outside = newDir();
    const linkPath = path.join(root, "escape");
    if (!tryLinkDir(outside, linkPath)) {
      // 无法创建链接（权限）时不判断具体行为
      expect(true).toBe(true);
      return;
    }
    fs.mkdirSync(path.join(root, "safe"), { recursive: true });
    expect(resolveInsideProject(resolveProjectRoot(root), "safe", "safe").path).toBe(path.join(root, "safe"));
    expect(() => resolveInsideProject(resolveProjectRoot(root), "escape", "escape")).toThrow(PathSafetyError);
    expect(() => resolveInsideProject(resolveProjectRoot(root), "escape/sub", "escape/sub")).toThrow(/逃逸工程根|符号链接/);
  });

  it("已存在的目标本身是符号链接时拒绝（不跟随写入）", () => {
    const root = newDir();
    const outside = newDir();
    const target = path.join(root, "linked");
    if (!tryLinkDir(outside, target)) {
      expect(true).toBe(true);
      return;
    }
    // fail-closed：指向根外的链接被"逃逸"拒绝，指向根内的链接被"符号链接"拒绝，两者都不得跟随
    expect(() => resolveInsideProject(resolveProjectRoot(root), "linked", "linked")).toThrow(PathSafetyError);
    expect(() => resolveInsideProject(resolveProjectRoot(root), "linked", "linked")).toThrow(/逃逸工程根|符号链接|联接/);
  });
});

describe("工程级 v-cli 配置（.vant/config/v-cli.json，通用外壳 + Provider 绑定契约）", () => {
  it("缺少配置：kind=missing + 初始化指引", () => {
    const root = newDir();
    const loaded = loadProjectConfig(resolveProjectRoot(root), testProviders());
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.kind).toBe("missing");
      expect(loaded.hint).toContain("v-cli project init");
    }
  });

  it("Vant 职责字段（roles/workflow）被明确拒绝（不做双份真源）", () => {
    const errors = validateProjectCliConfig({
      schemaVersion: 1,
      roles: ["client"],
      bindings: { unity: { projectDir: "Client" } },
    });
    expect(errors.join()).toContain('字段 "roles" 属于 Vant 组织层');
    expect(validateProjectCliConfig({ schemaVersion: 1, workflow: {}, bindings: {} }).join()).toContain("workflow");
  });

  it("原型污染危险键（顶层与 bindings）被外壳直接拒绝", () => {
    // __proto__ 必须经 JSON.parse 构造为自有键（赋值只会改原型，不产生可枚举自有属性）
    const raw = JSON.parse('{ "schemaVersion": 1, "bindings": {}, "__proto__": { "x": 1 } }');
    expect(validateProjectCliConfig(raw).join()).toContain("危险键");
    const withBindings = JSON.parse('{ "schemaVersion": 1, "bindings": { "constructor": { "a": 1 } } }');
    expect(validateProjectCliConfig(withBindings).join()).toContain("危险键");
  });

  it("未知顶层字段 / 非法 binding 键格式被外壳拒绝", () => {
    expect(validateProjectCliConfig({ schemaVersion: 2, bindings: {} }).join()).toContain("schemaVersion");
    expect(validateProjectCliConfig({ schemaVersion: 1, bindings: {}, extra: 1 }).join()).toContain('未知字段 "extra"');
    expect(validateProjectCliConfig({ schemaVersion: 1, bindings: { "Bad-ID": {} } }).join()).toContain("未知 binding");
  });

  it("未知 Provider 绑定段（合法键格式）在加载时 fail-closed", () => {
    const root = newDir();
    const configDir = path.join(root, ".vant", "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "v-cli.json"),
      JSON.stringify({ schemaVersion: 1, bindings: { figma: { anything: true } } }),
    );
    const loaded = loadProjectConfig(resolveProjectRoot(root), testProviders());
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.kind).toBe("invalid");
      expect(loaded.errors.join()).toContain('未知 Provider 绑定 "figma"');
    }
  });

  it("绑定段字段由 Provider 契约校验：testMode 非法 / 未知字段被拒绝", () => {
    const root = newDir();
    const configDir = path.join(root, ".vant", "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "v-cli.json"),
      JSON.stringify({ schemaVersion: 1, bindings: { unity: { projectDir: "Client", testMode: "Nope" } } }),
    );
    const loaded = loadProjectConfig(resolveProjectRoot(root), testProviders());
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.errors.join()).toContain("testMode");

    fs.writeFileSync(
      path.join(configDir, "v-cli.json"),
      JSON.stringify({ schemaVersion: 1, bindings: { unity: { projectDir: "Client", extra: 1 } } }),
    );
    const loaded2 = loadProjectConfig(resolveProjectRoot(root), testProviders());
    expect(loaded2.ok).toBe(false);
    if (!loaded2.ok) expect(loaded2.errors.join()).toContain("extra");
  });

  it("无关 Provider 缺失绑定不阻断：其余已声明绑定正常解析，缺失方列入 unbound", () => {
    const p = project();
    fs.writeFileSync(p.configFile, JSON.stringify({ schemaVersion: 1, bindings: { unity: { projectDir: "Client" } } }));
    const loaded = loadProjectConfig(resolveProjectRoot(p.root), testProviders());
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.resolved.unity.dirs.projectDir).toBe(path.join(p.root, "Client"));
      expect(loaded.unbound).toEqual(["sample"]);
    }
  });

  it("binding 目录绝对路径 / 越界 → unsafe-binding（fail-closed）", () => {
    const root = newDir();
    const configDir = path.join(root, ".vant", "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "v-cli.json"),
      JSON.stringify({ schemaVersion: 1, bindings: { unity: { projectDir: "C:/absolute" } } }),
    );
    const loaded = loadProjectConfig(resolveProjectRoot(root), testProviders());
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.kind).toBe("unsafe-binding");
      expect(loaded.errors.join()).toContain("禁止绝对路径");
    }
  });

  it("projectDir='.' 表示工程根自身", () => {
    const p = project();
    fs.writeFileSync(p.configFile, JSON.stringify({ schemaVersion: 1, bindings: { unity: { projectDir: "." } } }));
    const loaded = loadProjectConfig(resolveProjectRoot(p.root), testProviders());
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.resolved.unity.dirs.projectDir).toBe(resolveProjectRoot(p.root).root);
  });

  it("project init：不存在创建；已存在幂等补全（手工字段保留）；再跑 unchanged", () => {
    const root = newDir();
    const rootRef = resolveProjectRoot(root);
    const first = initProjectConfig(rootRef, testProviders());
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.action).toBe("created");
      expect(first.dryRun).toBe(false);
      const written = JSON.parse(fs.readFileSync(path.join(root, ...PROJECT_CLI_CONFIG_RELATIVE.split("/")), "utf-8"));
      expect(written).toEqual({
        schemaVersion: 1,
        bindings: { unity: { projectDir: "Client" }, sample: { workspaceDir: "Sample" } },
      });
      expect(first.warnings.join()).toContain("当前不存在");
      expect(first.added).toEqual(["unity", "sample"]);
    }
    // 模拟旧工程（只有 unity 段且带手工钉扎）：init → 幂等补全，unity 段逐字节不动
    const fileRef = path.join(root, ...PROJECT_CLI_CONFIG_RELATIVE.split("/"));
    const oldStyle = { schemaVersion: 1, bindings: { unity: { projectDir: "Client", editorVersion: "2022.3.59f1c1" } } };
    fs.writeFileSync(fileRef, JSON.stringify(oldStyle, null, 2) + "\n", "utf-8");
    const reconciled = initProjectConfig(rootRef, testProviders());
    expect(reconciled.ok).toBe(true);
    if (reconciled.ok) {
      expect(reconciled.action).toBe("reconciled");
      expect(reconciled.added).toEqual(["sample"]);
      const after = JSON.parse(fs.readFileSync(fileRef, "utf-8")) as { bindings: Record<string, unknown> };
      expect(after.bindings.unity).toEqual(oldStyle.bindings.unity);
      expect(after.bindings.sample).toEqual({ workspaceDir: "Sample" });
    }
    // 再跑：全部齐备 → unchanged，文件不变
    const before = fs.readFileSync(fileRef, "utf-8");
    const third = initProjectConfig(rootRef, testProviders());
    expect(third.ok).toBe(true);
    if (third.ok) expect(third.action).toBe("unchanged");
    expect(fs.readFileSync(fileRef, "utf-8")).toBe(before);
  });

  it("幂等补全：dry-run 不写文件；非法 JSON / 未知 Provider 段拒绝", () => {
    const root = newDir();
    const rootRef = resolveProjectRoot(root);
    const fileRef = path.join(root, ...PROJECT_CLI_CONFIG_RELATIVE.split("/"));
    fs.mkdirSync(path.dirname(fileRef), { recursive: true });

    fs.writeFileSync(fileRef, JSON.stringify({ schemaVersion: 1, bindings: { unity: { projectDir: "Client" } } }, null, 2) + "\n", "utf-8");
    const dry = initProjectConfig(rootRef, testProviders(), {}, { dryRun: true });
    expect(dry.ok).toBe(true);
    if (dry.ok) {
      expect(dry.action).toBe("reconciled");
      expect(dry.dryRun).toBe(true);
      expect(dry.added).toEqual(["sample"]);
    }
    expect((JSON.parse(fs.readFileSync(fileRef, "utf-8")) as { bindings: Record<string, unknown> }).bindings).toEqual({ unity: { projectDir: "Client" } });

    fs.writeFileSync(fileRef, "{ not json", "utf-8");
    const broken = initProjectConfig(rootRef, testProviders());
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.reason).toContain("--reset");

    fs.writeFileSync(fileRef, JSON.stringify({ schemaVersion: 1, bindings: { ghost: {} } }, null, 2) + "\n", "utf-8");
    const ghost = initProjectConfig(rootRef, testProviders());
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) expect(ghost.reason).toContain("ghost");
  });

  it("--reset：旧配置字节级备份 + 原子重置为默认段（--binding 生效）；dry-run 不写", () => {
    const root = newDir();
    const rootRef = resolveProjectRoot(root);
    const fileRef = path.join(root, ...PROJECT_CLI_CONFIG_RELATIVE.split("/"));
    fs.mkdirSync(path.dirname(fileRef), { recursive: true });
    const original = JSON.stringify({ schemaVersion: 1, bindings: { unity: { projectDir: "Custom", editorVersion: "2022.3.59f1c1" } } }, null, 2) + "\n";
    fs.writeFileSync(fileRef, original, "utf-8");

    const dry = initProjectConfig(rootRef, testProviders(), {}, { reset: true, dryRun: true });
    expect(dry.ok).toBe(true);
    if (dry.ok) {
      expect(dry.action).toBe("reset");
      expect(dry.dryRun).toBe(true);
    }
    expect(fs.readFileSync(fileRef, "utf-8")).toBe(original);

    const reset = initProjectConfig(rootRef, testProviders(), { sample: { workspaceDir: "Other" } }, { reset: true });
    expect(reset.ok).toBe(true);
    if (reset.ok) {
      expect(reset.action).toBe("reset");
      expect(reset.backupPath).toBeTruthy();
      expect(fs.readFileSync(reset.backupPath!, "utf-8")).toBe(original);
      expect(reset.backupPath!.split(path.sep).join("/")).toContain(".vant/state/config-backups/");
      const after = JSON.parse(fs.readFileSync(fileRef, "utf-8")) as { bindings: Record<string, unknown> };
      expect(after.bindings.unity).toEqual({ projectDir: "Client" });
      expect(after.bindings.sample).toEqual({ workspaceDir: "Other" });
      expect(reset.added).toEqual(["unity", "sample"]);
    }
  });

  it("project init 的 overrides 完整替换默认段；未知 Provider 覆盖被拒绝", () => {
    const root = newDir();
    const rootRef = resolveProjectRoot(root);
    const created = initProjectConfig(rootRef, testProviders(), {
      unity: { projectDir: "Client", editorVersion: "2022.3.62f3c1" },
    });
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.bindings.unity).toEqual({ projectDir: "Client", editorVersion: "2022.3.62f3c1" });
      expect(created.bindings.sample).toEqual({ workspaceDir: "Sample" });
    }
    const refused = initProjectConfig(resolveProjectRoot(newDir()), testProviders(), {
      nope: { x: 1 },
    } as Record<string, Record<string, unknown>>);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain("未知 Provider 绑定覆盖");
  });

  it("project init 不触碰 Vant 的 project.json（补全/创建/reset 三路径内容逐字节不变）", () => {
    const p = project({ withVantProjectConfig: { schemaVersion: 1, roles: [{ name: "client" }] } });
    const vantFile = path.join(p.root, ...VANT_PROJECT_CONFIG_RELATIVE.split("/"));
    const before = fs.readFileSync(vantFile, "utf-8");
    const reconciled = initProjectConfig(resolveProjectRoot(p.root), testProviders());
    expect(reconciled.ok).toBe(true);
    expect(fs.readFileSync(vantFile, "utf-8")).toBe(before);
    fs.rmSync(p.configFile);
    const created = initProjectConfig(resolveProjectRoot(p.root), testProviders());
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.vantConfig.exists).toBe(true);
    expect(fs.readFileSync(vantFile, "utf-8")).toBe(before);
    const reset = initProjectConfig(resolveProjectRoot(p.root), testProviders(), {}, { reset: true });
    expect(reset.ok).toBe(true);
    expect(fs.readFileSync(vantFile, "utf-8")).toBe(before);
  });

  it("renderProjectConfig 输出确定性（相同入参逐字节相同）", () => {
    const rootRef = resolveProjectRoot(newDir());
    const a = renderProjectConfig(rootRef, testProviders().values(), {
      unity: { projectDir: "Client", editorVersion: "2022.3.62f3c1", testMode: "PlayMode" },
    });
    const b = renderProjectConfig(rootRef, testProviders().values(), {
      unity: { projectDir: "Client", editorVersion: "2022.3.62f3c1", testMode: "PlayMode" },
    });
    expect(a.content).toBe(b.content);
    expect(a.sha256).toBe(b.sha256);
    expect((JSON.parse(a.content).bindings.unity as Record<string, unknown>).testMode).toBe("PlayMode");
  });

  it("inspectProject 只读：报告配置/逐 Provider 绑定状态/状态目录计数", () => {
    const p = project();
    const report = inspectProject(resolveProjectRoot(p.root), testProviders());
    expect(report.config.valid).toBe(true);
    expect(report.config.kind).toBe("ok");
    expect(report.vant.configFiles).toContain("v-cli.json");
    expect(report.state.exists).toBe(false);
    expect(report.state.operationCount).toBe(0);
    const unityBinding = report.config.providerBindings.find((b) => b.providerId === "unity");
    expect(unityBinding?.state).toBe("bound");
    expect(unityBinding?.dirs.projectDir).toBe(path.join(p.root, "Client"));
    const sampleBinding = report.config.providerBindings.find((b) => b.providerId === "sample");
    expect(sampleBinding?.state).toBe("missing-binding");
    fs.mkdirSync(path.join(p.root, ".vant", "state", "operations", "op-1"), { recursive: true });
    const after = inspectProject(resolveProjectRoot(p.root), testProviders());
    expect(after.state.operationCount).toBe(1);
  });
});

describe("操作记录（.vant/state/operations）", () => {
  it("同一 operationId 第二次预留被拒绝（绝不覆盖）", () => {
    const p = project();
    const root = resolveProjectRoot(p.root);
    const store = OperationStore.reserve(root, "op-fixed");
    store.writeInput({ a: 1 });
    store.writeResult({ ok: true });
    expect(fs.existsSync(path.join(store.dir!, "input.json"))).toBe(true);
    // 已存在文件不被覆盖：再写同名文件只会记录失败
    expect(() => OperationStore.reserve(root, "op-fixed")).toThrow(OperationExistsError);
    expect(fs.readFileSync(path.join(store.dir!, "input.json"), "utf-8")).toContain('"a": 1');
  });

  it("operationId 越界（含路径分隔符 / ..）被拒绝", () => {
    const p = project();
    const root = resolveProjectRoot(p.root);
    for (const bad of ["../x", "a/b", "a\\b", "..", ".h"]) {
      expect(() => OperationStore.reserve(root, bad)).toThrow(PathSafetyError);
    }
    expect(fs.existsSync(path.join(p.root, ".vant", "state", "operations"))).toBe(false);
  });

  it("operations 目录是越界链接时拒绝写入", () => {
    const p = project();
    const outside = newDir();
    const operations = path.join(p.root, ".vant", "state", "operations");
    fs.mkdirSync(path.dirname(operations), { recursive: true });
    if (!tryLinkDir(outside, operations)) {
      expect(true).toBe(true);
      return;
    }
    expect(() => OperationStore.reserve(resolveProjectRoot(p.root), "op-link")).toThrow(PathSafetyError);
  });

  it("不落盘模式：无目录、事件丢弃、files 为空", () => {
    const p = project();
    const store = OperationStore.disabled("op-x");
    store.writeInput({ a: 1 });
    store.event("t", "m");
    store.writeResult({ ok: true });
    expect(store.dir).toBeNull();
    expect(store.persistedFiles).toEqual([]);
    expect(fs.existsSync(path.join(p.root, ".vant", "state"))).toBe(false);
  });
});

describe("凭据脱敏", () => {
  it("键名匹配的字段被替换；argv 两种形态都被替换", () => {
    const { value, redactedPaths } = redactSecrets({
      token: "abc",
      nested: { password: "p", apiKey: "k", keep: "v" },
      list: [{ secret: "s" }],
      normal: 1,
    });
    expect(value.token).toBe("***redacted***");
    expect(value.nested.password).toBe("***redacted***");
    expect(value.nested.apiKey).toBe("***redacted***");
    expect(value.nested.keep).toBe("v");
    expect(value.list[0].secret).toBe("***redacted***");
    expect(redactedPaths).toEqual(
      expect.arrayContaining(["$.token", "$.nested.password", "$.nested.apiKey", "$.list[0].secret"]),
    );

    expect(redactArgv(["exec", "--token=abc", "--api-key", "k", "command", "x"]).value).toEqual([
      "exec",
      "--token=***redacted***",
      "--api-key",
      "***redacted***",
      "command",
      "x",
    ]);
  });
});

describe("审查回归：初始化和读取配置路径", () => {
  it("初始化非法绑定时不创建配置", () => {
    const root = newDir(); const p = resolveProjectRoot(root);
    const result = initProjectConfig(p, testProviders(), { unity: { projectDir: "../outside" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("未通过校验");
    expect(fs.existsSync(path.join(root, ".vant/config/v-cli.json"))).toBe(false);
  });
  it("读取越界配置目录链接时拒绝", () => {
    const root = newDir(), outside = newDir(); fs.mkdirSync(path.join(root, ".vant"));
    fs.writeFileSync(path.join(outside, "v-cli.json"), renderProjectConfig(resolveProjectRoot(root), testProviders().values()).content);
    expect(tryLinkDir(outside, path.join(root, ".vant/config"))).toBe(true);
    const loaded = loadProjectConfig(resolveProjectRoot(root), testProviders()); expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.kind).toBe("unsafe-binding");
  });
});

describe("inspect 归因（invalid 配置逐 Provider 状态）", () => {
  it("单 Provider 段错误归因到该 Provider；前缀相近 id 不互串", () => {
    const root = newDir();
    const configDir = path.join(root, ".vant", "config");
    fs.mkdirSync(configDir, { recursive: true });
    // 两个 id 前缀相近的 Provider；只有 sample 段非法（schema 拒绝未知字段）
    fs.writeFileSync(
      path.join(configDir, "v-cli.json"),
      JSON.stringify({ schemaVersion: 1, bindings: { sample: { workspaceDir: "S", extra: 1 } } }),
    );
    const providers = toProviderSet([
      createSampleProvider(),
      { ...createSampleProvider({ id: "sample2" }), defaultBinding: undefined },
    ]);
    providers.delete("sample2");
    providers.set("sample2", { ...createSampleProvider({ id: "sample2" }) });
    const report = inspectProject(resolveProjectRoot(root), providers);
    expect(report.config.valid).toBe(false);
    const sample = report.config.providerBindings.find((b) => b.providerId === "sample")!;
    expect(sample.state).toBe("invalid");
    expect(sample.errors.join()).toContain("sample");
    const sample2 = report.config.providerBindings.find((b) => b.providerId === "sample2")!;
    expect(sample2.state).toBe("missing-binding");
  });

  it("外壳级（全局）错误时，已声明 Provider 报 invalid 并携带全局错误，不再误报 bound", () => {
    const root = newDir();
    const configDir = path.join(root, ".vant", "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "v-cli.json"),
      JSON.stringify({ schemaVersion: 1, bindings: { sample: { workspaceDir: "S" } }, extra: 1 }),
    );
    const report = inspectProject(resolveProjectRoot(root), testProviders());
    expect(report.config.valid).toBe(false);
    const sample = report.config.providerBindings.find((b) => b.providerId === "sample")!;
    expect(sample.state).toBe("invalid");
    expect(sample.errors.join()).toContain("未知字段");
  });

  it("未知 Provider 绑定段被独立点名", () => {
    const root = newDir();
    const configDir = path.join(root, ".vant", "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "v-cli.json"),
      JSON.stringify({ schemaVersion: 1, bindings: { ghost: { x: 1 } } }),
    );
    const report = inspectProject(resolveProjectRoot(root), testProviders());
    expect(report.config.valid).toBe(false);
    const ghost = report.config.providerBindings.find((b) => b.providerId === "ghost")!;
    expect(ghost.state).toBe("invalid");
    expect(ghost.errors.join()).toContain('未知 Provider 绑定 "ghost"');
  });

  it("配置缺失时按注册集合全部报告 missing-binding", () => {
    const root = newDir();
    const report = inspectProject(resolveProjectRoot(root), testProviders());
    expect(report.config.kind).toBe("missing");
    expect(report.config.providerBindings.map((b) => b.state)).toEqual(["missing-binding", "missing-binding"]);
    expect(report.config.providerBindings.every((b) => b.errors.length === 1)).toBe(true);
  });
});

describe("init 修订一审修复回归", () => {
  it("dry-run --reset：不创建备份目录/文件（零副作用预演）", () => {
    const root = newDir();
    const rootRef = resolveProjectRoot(root);
    const fileRef = path.join(root, ...PROJECT_CLI_CONFIG_RELATIVE.split("/"));
    fs.mkdirSync(path.dirname(fileRef), { recursive: true });
    fs.writeFileSync(fileRef, JSON.stringify({ schemaVersion: 1, bindings: { unity: { projectDir: "Client" } } }, null, 2) + "\n", "utf-8");
    const dry = initProjectConfig(rootRef, testProviders(), {}, { reset: true, dryRun: true });
    expect(dry.ok).toBe(true);
    if (dry.ok) expect(dry.backupPath).toBeUndefined();
    expect(fs.existsSync(path.join(root, ".vant", "state", "config-backups"))).toBe(false);
  });

  it("--binding 指向已有段 → 拒绝并指路 --reset（显式意图不可静默丢弃）", () => {
    const root = newDir();
    const rootRef = resolveProjectRoot(root);
    const fileRef = path.join(root, ...PROJECT_CLI_CONFIG_RELATIVE.split("/"));
    fs.mkdirSync(path.dirname(fileRef), { recursive: true });
    fs.writeFileSync(fileRef, JSON.stringify({ schemaVersion: 1, bindings: { unity: { projectDir: "Client" } } }, null, 2) + "\n", "utf-8");
    const result = initProjectConfig(rootRef, testProviders(), { unity: { projectDir: "ZZZ" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("--reset");
    // 文件未动
    expect(JSON.parse(fs.readFileSync(fileRef, "utf-8")).bindings.unity).toEqual({ projectDir: "Client" });
  });

  it("schemaVersion≠1 的现有配置 → 拒绝（不降级改写）", () => {
    const root = newDir();
    const rootRef = resolveProjectRoot(root);
    const fileRef = path.join(root, ...PROJECT_CLI_CONFIG_RELATIVE.split("/"));
    fs.mkdirSync(path.dirname(fileRef), { recursive: true });
    fs.writeFileSync(fileRef, JSON.stringify({ schemaVersion: 2, bindings: { unity: { projectDir: "Client" } } }, null, 2) + "\n", "utf-8");
    const result = initProjectConfig(rootRef, testProviders());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("schemaVersion");
    expect(fs.readFileSync(fileRef, "utf-8")).toContain('"schemaVersion": 2'); // 未被改写
  });

  it("齐备但含未知 Provider 段 → 拒绝（不静默报 unchanged）", () => {
    const root = newDir();
    const rootRef = resolveProjectRoot(root);
    const fileRef = path.join(root, ...PROJECT_CLI_CONFIG_RELATIVE.split("/"));
    fs.mkdirSync(path.dirname(fileRef), { recursive: true });
    fs.writeFileSync(
      fileRef,
      JSON.stringify({ schemaVersion: 1, bindings: { unity: { projectDir: "Client" }, sample: { workspaceDir: "S" }, ghost: {} } }, null, 2) + "\n",
      "utf-8",
    );
    const result = initProjectConfig(rootRef, testProviders());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("ghost");
  });

  it("非规范格式（CRLF/4 空格）补全：值与键序保留，格式规范化（行为钉死）", () => {
    const root = newDir();
    const rootRef = resolveProjectRoot(root);
    const fileRef = path.join(root, ...PROJECT_CLI_CONFIG_RELATIVE.split("/"));
    fs.mkdirSync(path.dirname(fileRef), { recursive: true });
    fs.writeFileSync(fileRef, '{\r\n    "schemaVersion": 1,\r\n    "bindings": {\r\n        "unity": {\r\n            "projectDir": "Client"\r\n        }\r\n    }\r\n}\r\n', "utf-8");
    const result = initProjectConfig(rootRef, testProviders());
    expect(result.ok).toBe(true);
    const after = JSON.parse(fs.readFileSync(fileRef, "utf-8")) as { bindings: Record<string, unknown> };
    expect(Object.keys(after.bindings)).toEqual(["unity", "sample"]); // 键序保留 + 追加
    expect(after.bindings.unity).toEqual({ projectDir: "Client" });
    expect(fs.readFileSync(fileRef, "utf-8")).not.toContain("\r\n"); // 格式规范化
  });

  it("unchanged 路径的 dryRun 字段如实", () => {
    const root = newDir();
    const rootRef = resolveProjectRoot(root);
    const first = initProjectConfig(rootRef, testProviders());
    expect(first.ok).toBe(true);
    const second = initProjectConfig(rootRef, testProviders(), {}, { dryRun: true });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.action).toBe("unchanged");
      expect(second.dryRun).toBe(true);
    }
  });
});

describe("init 修订二审修复回归", () => {
  it("配置文件为符号链接 → init 幂等补全拒绝（对齐 loadProjectConfig fail-closed）", () => {
    const p = project();
    const outside = newDir();
    const linkPath = p.configFile;
    fs.rmSync(linkPath);
    if (!tryLinkDir(outside, linkPath)) {
      expect(true).toBe(true);
      return;
    }
    // 链接指向目录：替换为文件链接不可靠——直接断言 init 被拒绝（PathSafetyError 转 refused 或抛出均可接受为 fail-closed）
    let refusedOrThrew = false;
    try {
      const result = initProjectConfig(resolveProjectRoot(p.root), testProviders());
      refusedOrThrew = !result.ok;
    } catch {
      refusedOrThrew = true;
    }
    expect(refusedOrThrew).toBe(true);
  });

  it("结果携带 existed：dry-run reset + 已存在文件 → existed=true 且无 backupPath", () => {
    const root = newDir();
    const rootRef = resolveProjectRoot(root);
    const fileRef = path.join(root, ...PROJECT_CLI_CONFIG_RELATIVE.split("/"));
    fs.mkdirSync(path.dirname(fileRef), { recursive: true });
    fs.writeFileSync(fileRef, JSON.stringify({ schemaVersion: 1, bindings: { unity: { projectDir: "Client" } } }, null, 2) + "\n", "utf-8");
    const dry = initProjectConfig(rootRef, testProviders(), {}, { reset: true, dryRun: true });
    expect(dry.ok).toBe(true);
    if (dry.ok) {
      expect(dry.existed).toBe(true);
      expect(dry.backupPath).toBeUndefined();
    }
    const created = initProjectConfig(rootRef, testProviders(), {}, { reset: true, dryRun: true });
    void created;
    // 全新目录 + dry-run reset：existed=false
    const fresh = newDir();
    const freshDry = initProjectConfig(resolveProjectRoot(fresh), testProviders(), {}, { reset: true, dryRun: true });
    expect(freshDry.ok).toBe(true);
    if (freshDry.ok) expect(freshDry.existed).toBe(false);
  });
});
