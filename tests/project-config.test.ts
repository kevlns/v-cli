import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  initProjectConfig,
  inspectProject,
  loadProjectConfig,
  PROJECT_CLI_CONFIG_RELATIVE,
  renderDefaultConfig,
  validateProjectCliConfig,
  VANT_PROJECT_CONFIG_RELATIVE,
} from "../src/core/project/config";
import { PathSafetyError, resolveInsideProject, resolveProjectRoot, splitSafeRelative } from "../src/core/project/paths";
import { OperationExistsError, OperationStore } from "../src/core/project/operation-store";
import { redactArgv, redactSecrets } from "../src/core/project/redact";
import { makeTempProject, tryLinkDir, type TempProject } from "./helpers/unity-fixtures";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

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

describe("工程级 v-cli 配置（.vant/config/v-cli.json）", () => {
  it("缺少配置：kind=missing + 初始化指引", () => {
    const root = newDir();
    const loaded = loadProjectConfig(resolveProjectRoot(root));
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

  it("未知字段/未知 binding/非法 testMode 被拒绝", () => {
    expect(validateProjectCliConfig({ schemaVersion: 2, bindings: {} }).join()).toContain("schemaVersion");
    expect(validateProjectCliConfig({ schemaVersion: 1, bindings: {}, extra: 1 }).join()).toContain('未知字段 "extra"');
    expect(validateProjectCliConfig({ schemaVersion: 1, bindings: { figma: {} } }).join()).toContain('未知 binding "figma"');
    expect(
      validateProjectCliConfig({ schemaVersion: 1, bindings: { unity: { projectDir: "C", testMode: "Nope" } } }).join(),
    ).toContain("testMode");
    expect(
      validateProjectCliConfig({ schemaVersion: 1, bindings: { unity: { projectDir: "C", extra: 1 } } }).join(),
    ).toContain('bindings.unity 含未知字段 "extra"');
  });

  it("binding 目录绝对路径 / 越界 → unsafe-binding（fail-closed）", () => {
    const root = newDir();
    const configDir = path.join(root, ".vant", "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "v-cli.json"),
      JSON.stringify({ schemaVersion: 1, bindings: { unity: { projectDir: "C:/absolute" } } }),
    );
    const loaded = loadProjectConfig(resolveProjectRoot(root));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.kind).toBe("unsafe-binding");
      expect(loaded.errors.join()).toContain("禁止绝对路径");
    }
  });

  it("projectDir='.' 表示工程根自身", () => {
    const p = project();
    fs.writeFileSync(p.configFile, JSON.stringify({ schemaVersion: 1, bindings: { unity: { projectDir: "." } } }));
    const loaded = loadProjectConfig(resolveProjectRoot(p.root));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.bindingDirs.unity).toBe(resolveProjectRoot(p.root).root);
  });

  it("project init：创建默认配置；已存在一律拒绝（无 --force）", () => {
    const root = newDir();
    const rootRef = resolveProjectRoot(root);
    const first = initProjectConfig(rootRef);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.action).toBe("created");
      const written = JSON.parse(fs.readFileSync(path.join(root, ...PROJECT_CLI_CONFIG_RELATIVE.split("/")), "utf-8"));
      expect(written).toEqual({ schemaVersion: 1, bindings: { unity: { projectDir: "Client" } } });
      expect(first.warnings.join()).toContain("当前不存在");
    }
    const second = initProjectConfig(rootRef);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toContain("不覆盖已有配置");
  });

  it("project init 不触碰 Vant 的 project.json（内容逐字节不变）", () => {
    const p = project({ withVantProjectConfig: { schemaVersion: 1, roles: [{ name: "client" }] } });
    const vantFile = path.join(p.root, ...VANT_PROJECT_CONFIG_RELATIVE.split("/"));
    const before = fs.readFileSync(vantFile, "utf-8");
    const result = initProjectConfig(resolveProjectRoot(p.root), { unityProjectDir: "Client" });
    // v-cli.json 已存在（由 fixture 写入）→ 拒绝；无论如何 Vant 配置不改
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(vantFile, "utf-8")).toBe(before);
    // 换一个已存在的 v-cli.json 场景：先删掉再 init，project.json 依然不变
    fs.rmSync(p.configFile);
    const created = initProjectConfig(resolveProjectRoot(p.root), { unityProjectDir: "Client" });
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.vantConfig.exists).toBe(true);
    expect(fs.readFileSync(vantFile, "utf-8")).toBe(before);
  });

  it("renderDefaultConfig 输出确定性（相同入参逐字节相同）", () => {
    const a = renderDefaultConfig({ unityProjectDir: "Client", editorVersion: "2022.3.62f3c1", testMode: "PlayMode" });
    const b = renderDefaultConfig({ unityProjectDir: "Client", editorVersion: "2022.3.62f3c1", testMode: "PlayMode" });
    expect(a.content).toBe(b.content);
    expect(a.sha256).toBe(b.sha256);
    expect(JSON.parse(a.content).bindings.unity.testMode).toBe("PlayMode");
  });

  it("inspectProject 只读：报告配置/布局/状态目录计数", () => {
    const p = project();
    const report = inspectProject(resolveProjectRoot(p.root));
    expect(report.config.valid).toBe(true);
    expect(report.config.kind).toBe("ok");
    expect(report.vant.configFiles).toContain("v-cli.json");
    expect(report.state.exists).toBe(false);
    expect(report.state.operationCount).toBe(0);
    fs.mkdirSync(path.join(p.root, ".vant", "state", "operations", "op-1"), { recursive: true });
    const after = inspectProject(resolveProjectRoot(p.root));
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
    expect(() => initProjectConfig(p, { unityProjectDir: "../outside" })).toThrow();
    expect(fs.existsSync(path.join(root, ".vant/config/v-cli.json"))).toBe(false);
  });
  it("读取越界配置目录链接时拒绝", () => {
    const root = newDir(), outside = newDir(); fs.mkdirSync(path.join(root, ".vant"));
    fs.writeFileSync(path.join(outside, "v-cli.json"), renderDefaultConfig().content);
    expect(tryLinkDir(outside, path.join(root, ".vant/config"))).toBe(true);
    const loaded = loadProjectConfig(resolveProjectRoot(root)); expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.kind).toBe("unsafe-binding");
  });
});
