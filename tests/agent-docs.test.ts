import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolve } from "node:path";
import {
  atomicWrite,
  bundledCandidatePaths,
  performAgentInit,
  readBundledAgentsMd,
  readOfficialAgentsMd,
  resolveBundledAgentsMd,
  sha256Hex,
  type BundledDocs,
} from "../src/core/agent-docs";
import { VERSION } from "../src/version";

const REPO_ROOT = resolve(__dirname, "..");
const CLI = resolve(REPO_ROOT, "dist", "cli.mjs");
const BUNDLED_MD = resolve(REPO_ROOT, "AGENTS.md");
const BUNDLED_CONTENT = fs.readFileSync(BUNDLED_MD, "utf-8");
const BUNDLED_SHA256 = sha256Hex(BUNDLED_CONTENT);
const REPO_PKG = JSON.parse(fs.readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8"));

const dirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v-cli-docs-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  // Delete in reverse creation order: junction/symlink containers are created
  // after their real targets. Removing the target first leaves a dangling
  // Windows junction that fs.rmSync reports as ENOTEMPTY.
  for (const d of dirs.splice(0).reverse()) fs.rmSync(d, { recursive: true, force: true });
});

function fakeDocs(content: string): BundledDocs {
  return {
    file: "unused",
    content,
    sha256: sha256Hex(content),
    bytes: Buffer.byteLength(content, "utf-8"),
  };
}

/** 平台安全符号链接：Windows 无开发者模式/管理员时创建失败 → 返回 false */
function makeFileSymlink(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link, "file");
    return true;
  } catch {
    return false;
  }
}

function runCli(
  args: string[],
  opts: { cwd?: string; home?: string; env?: Record<string, string>; cli?: string } = {},
): { status: number; stdout: string; stderr: string } {
  const home = opts.home ?? path.join(tmpDir(), "home");
  fs.mkdirSync(home, { recursive: true });
  const r = spawnSync(process.execPath, [opts.cli ?? CLI, ...args], {
    encoding: "utf-8",
    cwd: opts.cwd ?? REPO_ROOT,
    env: { ...process.env, V_CLI_HOME: home, ...(opts.env ?? {}) },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

beforeAll(() => {
  if (!fs.existsSync(CLI)) throw new Error("先执行 npm run build 再跑 agent docs/init 测试");
});

describe("agent-docs 解析器（base 注入，无全局路径假设）", () => {
  it("dist 布局：base 指向 <pkg>/dist/cli.mjs → 解析到 <pkg>/AGENTS.md", () => {
    const tmp = tmpDir();
    fs.mkdirSync(path.join(tmp, "dist"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "docs-content\n", "utf-8");
    const base = path.join(tmp, "dist", "cli.mjs");
    expect(bundledCandidatePaths(base)).toContain(path.join(tmp, "AGENTS.md"));
    const found = resolveBundledAgentsMd({ base });
    expect(found).toBe(path.join(tmp, "AGENTS.md"));
    expect(readBundledAgentsMd({ base }).content).toBe("docs-content\n");
  });

  it("npm 安装布局：<prefix>/lib/node_modules/@kevlns/v-cli/dist/cli.mjs → 包根 AGENTS.md", () => {
    const tmp = tmpDir();
    const pkgRoot = path.join(tmp, "prefix", "lib", "node_modules", "@kevlns", "v-cli");
    fs.mkdirSync(path.join(pkgRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(pkgRoot, "AGENTS.md"), "installed-docs\n", "utf-8");
    const base = path.join(pkgRoot, "dist", "cli.mjs");
    expect(resolveBundledAgentsMd({ base })).toBe(path.join(pkgRoot, "AGENTS.md"));
  });

  it("源布局：src 下模块 → 上溯到 name 匹配的 package.json 包根", () => {
    const tmp = tmpDir();
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({ name: "@kevlns/v-cli", version: VERSION }),
      "utf-8",
    );
    fs.mkdirSync(path.join(tmp, "src", "core"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "src-docs\n", "utf-8");
    const base = path.join(tmp, "src", "core", "agent-docs.ts");
    expect(resolveBundledAgentsMd({ base })).toBe(path.join(tmp, "AGENTS.md"));
    expect(readBundledAgentsMd({ base }).bytes).toBe(Buffer.byteLength("src-docs\n", "utf-8"));
    expect(readBundledAgentsMd({ base }).sha256).toBe(sha256Hex("src-docs\n"));
  });

  it("嵌套安装布局：<dir>/node_modules/@kevlns/v-cli 包根（模块在包外 dist 副本时）", () => {
    const tmp = tmpDir();
    const pkgRoot = path.join(tmp, "node_modules", "@kevlns", "v-cli");
    fs.mkdirSync(pkgRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pkgRoot, "package.json"),
      JSON.stringify({ name: "@kevlns/v-cli", version: VERSION }),
      "utf-8",
    );
    fs.writeFileSync(path.join(pkgRoot, "AGENTS.md"), "nested-docs\n", "utf-8");
    // 执行副本在包外（如某处拷贝的 bundle），包根在祖先 node_modules 树中
    const base = path.join(tmp, "somewhere", "dist", "cli.mjs");
    fs.mkdirSync(path.dirname(base), { recursive: true });
    expect(resolveBundledAgentsMd({ base })).toBe(path.join(pkgRoot, "AGENTS.md"));
  });

  it("缺失：任何候选都不存在 → undefined；readBundledAgentsMd 抛带候选信息的错误且不含 undefined", () => {
    const tmp = tmpDir();
    const base = path.join(tmp, "dist", "cli.mjs");
    fs.mkdirSync(path.dirname(base), { recursive: true });
    expect(resolveBundledAgentsMd({ base })).toBeUndefined();
    const msg = (() => {
      try {
        readBundledAgentsMd({ base });
        return "";
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    })();
    expect(msg).toMatch(/无法定位 @kevlns\/v-cli 内置 AGENTS\.md/);
    expect(msg).toContain("候选位置");
    expect(msg).not.toContain("undefined");
  });

  it("dist 同级缺 AGENTS.md → 先 undefined；包根补齐后同一 base 解析成功", () => {
    const tmp = tmpDir();
    // dist 存在但包根没有 AGENTS.md；上行的嵌套“安装”也没有 → 必须 undefined
    fs.mkdirSync(path.join(tmp, "dist"), { recursive: true });
    const base = path.join(tmp, "dist", "cli.mjs");
    expect(resolveBundledAgentsMd({ base })).toBeUndefined();
    // 补上包根 package.json + AGENTS.md 后解析成功
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({ name: "@kevlns/v-cli" }),
      "utf-8",
    );
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "late-docs\n", "utf-8");
    expect(resolveBundledAgentsMd({ base })).toBe(path.join(tmp, "AGENTS.md"));
  });

  it("sha256Hex 与已知向量一致", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("official 插件 AGENTS.md 解析", () => {
  function fakeOfficialPackage(pkg: string, version: string, docs?: string): string {
    const root = path.join(tmpDir(), "node_modules", ...pkg.split("/"));
    fs.mkdirSync(root, { recursive: true });
    const packageJson = path.join(root, "package.json");
    fs.writeFileSync(packageJson, JSON.stringify({ name: pkg, version }), "utf-8");
    if (docs !== undefined) fs.writeFileSync(path.join(root, "AGENTS.md"), docs, "utf-8");
    return packageJson;
  }

  it("按官方 command 读取包根 AGENTS.md 并返回身份/哈希", () => {
    const packageJson = fakeOfficialPackage("@kevlns/u-cli-mod", "9.9.9", "# unity norms\n");
    const docs = readOfficialAgentsMd("unity", {
      resolvePackage: (pkg) => (pkg === "@kevlns/u-cli-mod" ? packageJson : undefined),
    });
    expect(docs.package).toBe("@kevlns/u-cli-mod");
    expect(docs.command).toBe("unity");
    expect(docs.version).toBe("9.9.9");
    expect(docs.content).toBe("# unity norms\n");
    expect(docs.sha256).toBe(sha256Hex(docs.content));
  });

  it("未知命令 / 未安装 / 缺文档均给出清晰错误", () => {
    expect(() => readOfficialAgentsMd("nope")).toThrow(/未找到官方插件命令/);
    expect(() => readOfficialAgentsMd("xlmerge", { resolvePackage: () => undefined })).toThrow(/未安装官方插件包/);
    const packageJson = fakeOfficialPackage("@kevlns/xlmerge", "1.0.0");
    expect(() =>
      readOfficialAgentsMd("xlmerge", { resolvePackage: () => packageJson }),
    ).toThrow(/未提供可读的 AGENTS\.md/);
  });
});

describe("performAgentInit（真实 IO，临时目录）", () => {
  const DOCS = fakeDocs("# AGENTS.md\n\nhello\n");

  it("新目录写入：action=written、内容/字节/SHA-256 正确", () => {
    const dir = tmpDir();
    const result = performAgentInit({ directory: dir, docs: DOCS });
    expect(result.ok).toBe(true);
    expect(result.action).toBe("written");
    expect(result.dryRun).toBe(false);
    expect(result.target).toBe(path.join(dir, "AGENTS.md"));
    expect(result.package).toBe("@kevlns/v-cli");
    expect(result.version).toBe(VERSION);
    expect(result.sha256).toBe(DOCS.sha256);
    expect(result.bytes).toBe(DOCS.bytes);
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe(DOCS.content);
    // 原子写入不留临时文件
    expect(fs.readdirSync(dir).sort()).toEqual(["AGENTS.md"]);
  });

  it("已存在且未 --force → refused，文件原样保留", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "existing\n", "utf-8");
    const result = performAgentInit({ directory: dir, docs: DOCS });
    expect(result.ok).toBe(false);
    expect(result.action).toBe("refused");
    expect(result.reason).toContain("已存在");
    expect(result.reason).toContain("--force");
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe("existing\n");
  });

  it("已存在 + --force → overwritten，内容被原子替换", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "old\n", "utf-8");
    const result = performAgentInit({ directory: dir, docs: DOCS, force: true });
    expect(result.ok).toBe(true);
    expect(result.action).toBe("overwritten");
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe(DOCS.content);
    expect(fs.readdirSync(dir).sort()).toEqual(["AGENTS.md"]);
  });

  it("--dry-run：不写任何文件，只报告动作（write/overwrite）", () => {
    const dir = tmpDir();
    const fresh = performAgentInit({ directory: dir, docs: DOCS, dryRun: true });
    expect(fresh.ok).toBe(true);
    expect(fresh.dryRun).toBe(true);
    expect(fresh.action).toBe("write");
    expect(fs.readdirSync(dir)).toEqual([]);

    fs.writeFileSync(path.join(dir, "AGENTS.md"), "existing\n", "utf-8");
    const overwrite = performAgentInit({ directory: dir, docs: DOCS, force: true, dryRun: true });
    expect(overwrite.ok).toBe(true);
    expect(overwrite.action).toBe("overwrite");
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe("existing\n");
  });

  it("--dry-run 且已存在未 --force → refused（与真实运行一致）", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "existing\n", "utf-8");
    const result = performAgentInit({ directory: dir, docs: DOCS, dryRun: true });
    expect(result.ok).toBe(false);
    expect(result.action).toBe("refused");
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe("existing\n");
  });

  it("目录不存在 → refused；文件路径当目录 → refused", () => {
    const missing = performAgentInit({ directory: path.join(tmpDir(), "nope"), docs: DOCS });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toContain("不存在");

    const fileAsDir = path.join(tmpDir(), "plain.txt");
    fs.writeFileSync(fileAsDir, "x", "utf-8");
    const notDir = performAgentInit({ directory: fileAsDir, docs: DOCS });
    expect(notDir.ok).toBe(false);
    expect(notDir.reason).toContain("不是目录");
  });

  it("符号链接目标 fail-closed（含 --force；链接目标与链接本身都不动）", (ctx) => {
    const dir = tmpDir();
    const elsewhere = path.join(dir, "elsewhere.txt");
    fs.writeFileSync(elsewhere, "precious\n", "utf-8");
    if (!makeFileSymlink(elsewhere, path.join(dir, "AGENTS.md"))) {
      ctx.skip("当前环境无法创建符号链接（Windows 需开发者模式/管理员）");
      return;
    }
    for (const force of [false, true]) {
      const result = performAgentInit({ directory: dir, docs: DOCS, force });
      expect(result.ok).toBe(false);
      expect(result.action).toBe("refused");
      expect(result.reason).toContain("符号链接");
    }
    expect(fs.readFileSync(elsewhere, "utf-8")).toBe("precious\n");
    expect(fs.lstatSync(path.join(dir, "AGENTS.md")).isSymbolicLink()).toBe(true);
  });

  it("目标是一个目录 → refused", () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "AGENTS.md"));
    const result = performAgentInit({ directory: dir, docs: DOCS });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("目录");
  });

  it("显式目录是符号链接/联接 → refused（fail-closed，不跟随）；默认 cwd 场景仍可写入", (ctx) => {
    const realDir = tmpDir();
    const link = path.join(tmpDir(), "linked-dir");
    try {
      fs.symlinkSync(realDir, link, process.platform === "win32" ? "junction" : "dir");
    } catch {
      ctx.skip("当前环境无法创建目录符号链接/联接");
      return;
    }
    const refused = performAgentInit({ directory: link, docs: DOCS, explicitDirectory: true });
    expect(refused.ok).toBe(false);
    expect(refused.action).toBe("refused");
    expect(refused.reason).toContain("符号链接");
    expect(fs.readdirSync(realDir)).toEqual([]);
    // 非显式（默认 cwd 等价）→ 允许跟随写入
    const followed = performAgentInit({ directory: link, docs: DOCS });
    expect(followed.ok).toBe(true);
    expect(followed.action).toBe("written");
    expect(fs.readFileSync(path.join(realDir, "AGENTS.md"), "utf-8")).toBe(DOCS.content);
  });

  it("atomicWrite：失败时不留临时文件（目标为目录场景）", () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "AGENTS.md"));
    expect(() => atomicWrite(path.join(dir, "AGENTS.md"), "x")).toThrowError();
    expect(fs.readdirSync(dir).sort()).toEqual(["AGENTS.md"]);
  });

  it("atomicWrite：覆盖/失败路径绝不留残余、绝不删除既有文件", () => {
    const dir = tmpDir();
    // 覆盖既有文件：rename 原子替换，目录里始终只有目标文件
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "precious\n", "utf-8");
    atomicWrite(path.join(dir, "AGENTS.md"), "new\n");
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe("new\n");
    expect(fs.readdirSync(dir).sort()).toEqual(["AGENTS.md"]);
    // 目标为目录：本次调用创建的临时文件被清理；既有 AGENTS.md 原样保留
    fs.mkdirSync(path.join(dir, "AGENTS.md-dir"));
    const target = path.join(dir, "AGENTS.md-dir");
    expect(() => atomicWrite(target, "x")).toThrowError();
    expect(fs.readdirSync(dir).sort()).toEqual(["AGENTS.md", "AGENTS.md-dir"]);
    expect(fs.readdirSync(target)).toEqual([]);
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe("new\n");
  });
});

describe("CLI 集成：agent docs（dist 构建）", () => {
  it("文本模式逐字节输出内置 AGENTS.md 原文（不多不少）", () => {
    const r = runCli(["agent", "docs"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(BUNDLED_CONTENT);
  });

  it("--json 输出稳定对象 { package, version, sha256, content }", () => {
    const r = runCli(["agent", "docs", "--json"]);
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data).toEqual({
      package: "@kevlns/v-cli",
      version: VERSION,
      sha256: BUNDLED_SHA256,
      content: BUNDLED_CONTENT,
    });
    // 独立重算哈希：content 与 sha256 自洽，且等于仓库文件哈希
    expect(sha256Hex(data.content)).toBe(data.sha256);
    expect(data.sha256).toBe(sha256Hex(BUNDLED_CONTENT));
    expect(REPO_PKG.version).toBe(VERSION);
  });

  it("前置全局 --json 同样生效", () => {
    const r = runCli(["--json", "agent", "docs"]);
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.package).toBe("@kevlns/v-cli");
    expect(data.content).toBe(BUNDLED_CONTENT);
  });

  it("传 official command 输出已安装插件包根 AGENTS.md", () => {
    const expected = fs.readFileSync(
      resolve(REPO_ROOT, "node_modules", "@kevlns", "u-cli-mod", "AGENTS.md"),
      "utf-8",
    );
    const r = runCli(["agent", "docs", "unity"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(expected);
    expect(r.stdout).toContain("使用规范（Agent 必须遵守）");
  });

  it("插件文档 --json 输出插件身份与自洽哈希", () => {
    const r = runCli(["agent", "docs", "xlmerge", "--json"]);
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.package).toBe("@kevlns/xlmerge");
    expect(data.version).toBe("1.3.0");
    expect(data.content).toContain("不默认走无头自动合并");
    expect(sha256Hex(data.content)).toBe(data.sha256);
  });

  it("未知 official command 退出 1 并给出清晰错误", () => {
    const r = runCli(["agent", "docs", "nope"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("未找到官方插件命令");
  });
});

describe("CLI 集成：agent init（dist 构建，真实临时目录）", () => {
  it("默认目录为 cwd：不传参数时把 AGENTS.md 写入当前工作目录", () => {
    const dir = tmpDir();
    const r = runCli(["agent", "init"], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("已写入");
    expect(r.stdout).toContain(dir);
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe(BUNDLED_CONTENT);
  });

  it("显式目录参数", () => {
    const dir = tmpDir();
    const other = tmpDir();
    const r = runCli(["agent", "init", dir], { cwd: other });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe(BUNDLED_CONTENT);
    expect(fs.existsSync(path.join(other, "AGENTS.md"))).toBe(false);
  });

  it("已存在默认拒绝：退出 1、无任何改动、stderr 给指引", () => {
    const dir = tmpDir();
    const existing = "我的已有内容\n";
    fs.writeFileSync(path.join(dir, "AGENTS.md"), existing, "utf-8");
    const r = runCli(["agent", "init", dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("已存在");
    expect(r.stderr).toContain("--force");
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe(existing);
    expect(fs.readdirSync(dir)).toEqual(["AGENTS.md"]);
  });

  it("--force 覆盖已存在文件", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "old\n", "utf-8");
    const r = runCli(["agent", "init", dir, "--force"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("已覆盖");
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe(BUNDLED_CONTENT);
    expect(fs.readdirSync(dir)).toEqual(["AGENTS.md"]);
  });

  it("--dry-run：不写文件，报告目标与动作（文本与 --json）", () => {
    const dir = tmpDir();
    const text = runCli(["agent", "init", dir, "--dry-run"]);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain("[dry-run]");
    expect(text.stdout).toContain("将写入");
    expect(fs.readdirSync(dir)).toEqual([]);

    const json = runCli(["agent", "init", dir, "--dry-run", "--json"]);
    expect(json.status).toBe(0);
    const data = JSON.parse(json.stdout);
    expect(data.ok).toBe(true);
    expect(data.dryRun).toBe(true);
    expect(data.action).toBe("write");
    expect(data.directory).toBe(dir);
    expect(data.target).toBe(path.join(dir, "AGENTS.md"));
    expect(data.package).toBe("@kevlns/v-cli");
    expect(data.version).toBe(VERSION);
    expect(data.sha256).toBe(BUNDLED_SHA256);
    expect(data.bytes).toBe(Buffer.byteLength(BUNDLED_CONTENT, "utf-8"));
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("--json 成功结果稳定（written 路径）", () => {
    const dir = tmpDir();
    const r = runCli(["agent", "init", dir, "--json"]);
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.ok).toBe(true);
    expect(data.action).toBe("written");
    expect(data.target).toBe(path.join(dir, "AGENTS.md"));
    expect(data.sha256).toBe(BUNDLED_SHA256);
  });

  it("--json 拒绝结果稳定（refused 路径，含 reason）", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "existing\n", "utf-8");
    const r = runCli(["agent", "init", dir, "--json"]);
    expect(r.status).toBe(1);
    const data = JSON.parse(r.stdout);
    expect(data.ok).toBe(false);
    expect(data.dryRun).toBe(false);
    expect(data.action).toBe("refused");
    expect(data.reason).toContain("已存在");
    expect(r.stderr).toContain("已存在");
  });

  it("目录不存在 → 退出 1", () => {
    const missing = path.join(tmpDir(), "no-such-dir");
    const r = runCli(["agent", "init", missing]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("不存在");
  });

  it("文件（非目录）→ 退出 1", () => {
    const fileAsDir = path.join(tmpDir(), "plain.txt");
    fs.writeFileSync(fileAsDir, "x", "utf-8");
    const r = runCli(["agent", "init", fileAsDir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("不是目录");
  });

  it("符号链接目标 fail-closed（默认与 --force 都拒绝；链接目标不被触碰）", (ctx) => {
    const dir = tmpDir();
    const elsewhere = path.join(dir, "elsewhere.txt");
    fs.writeFileSync(elsewhere, "precious\n", "utf-8");
    if (!makeFileSymlink(elsewhere, path.join(dir, "AGENTS.md"))) {
      ctx.skip("当前环境无法创建符号链接（Windows 需开发者模式/管理员）");
      return;
    }
    for (const extra of [[], ["--force"]]) {
      const r = runCli(["agent", "init", dir, ...extra]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("符号链接");
    }
    expect(fs.readFileSync(elsewhere, "utf-8")).toBe("precious\n");
    expect(fs.lstatSync(path.join(dir, "AGENTS.md")).isSymbolicLink()).toBe(true);
  });

  it("CLI 显式传入联接目录 → fail-closed（退出 1，真实目录不被写入）", (ctx) => {
    const realDir = tmpDir();
    const link = path.join(tmpDir(), "linked-dir");
    try {
      fs.symlinkSync(realDir, link, process.platform === "win32" ? "junction" : "dir");
    } catch {
      ctx.skip("当前环境无法创建目录符号链接/联接");
      return;
    }
    for (const extra of [[], ["--force"], ["--dry-run"]]) {
      const r = runCli(["agent", "init", link, ...extra]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("符号链接");
      expect(fs.readdirSync(realDir)).toEqual([]);
    }
  });

  it("真实构建包缺少 AGENTS.md → docs/init 退出 1，错误不含 undefined", () => {
    const pkg = tmpDir();
    const dist = path.join(pkg, "dist");
    fs.mkdirSync(dist, { recursive: true });
    const copiedCli = path.join(dist, "cli.mjs");
    fs.copyFileSync(CLI, copiedCli);
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "@kevlns/v-cli", version: VERSION }),
      "utf-8",
    );
    // commander 是有意 external；复制依赖以模拟一个结构完整但漏包 AGENTS.md 的安装。
    fs.cpSync(path.join(REPO_ROOT, "node_modules", "commander"), path.join(pkg, "node_modules", "commander"), {
      recursive: true,
    });

    const json = runCli(["agent", "docs", "--json"], { cli: copiedCli, cwd: pkg });
    expect(json.status).toBe(1);
    const data = JSON.parse(json.stdout);
    expect(data).toEqual({ ok: false, error: expect.stringContaining("无法定位") });
    expect(data.error).toContain("候选位置");
    expect(data.error).not.toContain("undefined");
    expect(json.stderr).toContain("无法定位");

    const text = runCli(["agent", "docs"], { cli: copiedCli, cwd: pkg });
    expect(text.status).toBe(1);
    expect(text.stderr).not.toContain("undefined");

    const init = runCli(["agent", "init", "--json"], { cli: copiedCli, cwd: pkg });
    expect(init.status).toBe(1);
    const initData = JSON.parse(init.stdout);
    expect(initData.ok).toBe(false);
    expect(initData.error).toContain("无法定位");
  });
});

describe("CLI 集成：帮助面（AI Agent 快速开始）", () => {
  it("v-cli --help 含 AI Agent 快速开始与推荐顺序（四行按序）", () => {
    const r = runCli(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("AI Agent 快速开始");
    const lines = [
      "1. v-cli agent docs",
      "2. v-cli agent index --json",
      "3. v-cli agent describe <name> --json",
      "4. v-cli agent init .",
    ];
    let prev = -1;
    for (const line of lines) {
      expect(r.stdout).toContain(line);
      const idx = r.stdout.indexOf(line);
      expect(idx).toBeGreaterThan(prev);
      prev = idx;
    }
  });

  it("帮助输出确定（两次运行逐字节一致）", () => {
    const a = runCli(["--help"]);
    const b = runCli(["--help"]);
    expect(a.stdout).toBe(b.stdout);
    expect(a.stderr).toBe(b.stderr);
  });

  it("v-cli agent --help 含目的/子命令/JSON 行为/示例", () => {
    const r = runCli(["agent", "--help"]);
    expect(r.status).toBe(0);
    for (const needle of ["docs", "init", "--json", "已存在默认拒绝", "v-cli agent docs", "v-cli agent index --json"]) {
      expect(r.stdout).toContain(needle);
    }
  });

  it("v-cli agent docs --help 含 JSON 行为/退出码/示例", () => {
    const r = runCli(["agent", "docs", "--help"]);
    expect(r.status).toBe(0);
    for (const needle of ["sha256", "content", "退出码", "v-cli agent docs xlmerge --json", "ok: false", "稀疏对象"]) {
      expect(r.stdout).toContain(needle);
    }
  });

  it("v-cli agent init --help 含默认/覆盖规则/JSON/示例", () => {
    const r = runCli(["agent", "init", "--help"]);
    expect(r.status).toBe(0);
    for (const needle of [
      "默认当前工作目录",
      "--force",
      "--dry-run",
      "--json",
      "符号链接",
      "联接",
      "ok: false",
      "v-cli agent init ./myproj",
      "v-cli agent init --dry-run",
    ]) {
      expect(r.stdout).toContain(needle);
    }
  });

  it("help 出现在错误提示之后（showHelpAfterError 与新增节共存）", () => {
    const r = runCli(["--bogus"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr.toLowerCase()).toMatch(/unknown option/);
  });
});

describe("CLI 集成：agent index/describe 元数据包含 docs/init", () => {
  it("agent index --json：agent 行 commands 含 index/describe/docs/init 及完整契约", () => {
    const r = runCli(["agent", "index", "--json"]);
    expect(r.status).toBe(0);
    const rows = JSON.parse(r.stdout);
    const agentRow = rows.find((row: { name: string }) => row.name === "agent");
    expect(agentRow.type).toBe("builtin");
    expect(agentRow.metadataStatus).toBe("full");
    const paths = agentRow.commands.map((c: { path: string[] }) => c.path.join(" "));
    expect(paths).toEqual(["index", "describe", "docs", "init"]);
    const docs = agentRow.commands.find((c: { path: string[] }) => c.path.join(" ") === "docs");
    expect(docs.usage).toBe("v-cli agent docs [command] [--json]");
    expect(docs.arguments?.[0]).toEqual({
      name: "command",
      required: false,
      description: "官方插件命令名（如 unity、xlmerge）",
    });
    expect(docs.options?.[0].flags).toBe("--json");
    expect(docs.output.format).toBe("stdout");
    expect(docs.output.description).toContain("stdout");
    expect(docs.exitCodes["1"]).toContain("缺失");
    expect(docs.safety).toContain("read-only");
    const init = agentRow.commands.find((c: { path: string[] }) => c.path.join(" ") === "init");
    expect(init.arguments?.[0]).toEqual({
      name: "directory",
      required: false,
      description: "目标目录（默认当前工作目录；须已存在且为目录）",
    });
    expect(init.options.map((o: { flags: string }) => o.flags)).toEqual([
      "--force",
      "--dry-run",
      "--json",
    ]);
    expect(init.safety).toContain("fail-closed-symlink");
    expect(init.safety).toContain("refuses-existing");
  });

  it("agent describe agent --json：docs/init 详情可被 agent 读取", () => {
    const r = runCli(["agent", "describe", "agent", "--json"]);
    expect(r.status).toBe(0);
    const row = JSON.parse(r.stdout);
    expect(row.name).toBe("agent");
    expect(row.type).toBe("builtin");
    expect(row.whenToUse).toContain("AGENTS");
    const paths = row.commands.map((c: { path: string[] }) => c.path.join(" "));
    expect(paths).toContain("docs");
    expect(paths).toContain("init");
  });

  it("agent describe agent 文本模式展示用法/选项/退出码/安全标签", () => {
    const r = runCli(["agent", "describe", "agent"]);
    expect(r.status).toBe(0);
    for (const needle of ["docs", "init", "--force", "--dry-run", "退出码", "安全"]) {
      expect(r.stdout).toContain(needle);
    }
  });
});
