import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolve } from "node:path";
import {
  OFFICIAL_PLUGINS,
  OFFICIAL_COMMAND_NAMES,
  defaultResolvePackage,
  discoverAllOfficialPlugins,
  discoverOfficialPlugin,
  isOfficialCommand,
  type DiscoveryIo,
} from "../src/core/official";

const FIXTURES = resolve(__dirname, "fixtures", "installed");

function fsIo(platform?: string, resolvePackage?: (pkg: string) => string | undefined): DiscoveryIo {
  return {
    platform,
    resolvePackage,
    existsFile: (p) => fs.existsSync(p),
    readFile: (p) => fs.readFileSync(p, "utf-8"),
  };
}

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v-cli-official-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** 在临时目录写一个“合法清单 + 可控 package.json”的插件，返回 package.json 路径 */
function writeTempPlugin(
  dir: string,
  pkgJson: Record<string, unknown>,
  manifestOverrides: Record<string, unknown> = {},
): string {
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkgJson), "utf-8");
  fs.writeFileSync(
    path.join(dir, "v-cli.plugin.json"),
    JSON.stringify({
      schemaVersion: 1,
      package: "@kevlns/xlmerge",
      command: "xlmerge",
      bin: "xlmerge",
      description: "d",
      platforms: ["darwin", "linux", "win32"],
      runtime: {},
      environment: [],
      agent: { whenToUse: "w", globalOptions: [], commands: [] },
      ...manifestOverrides,
    }),
    "utf-8",
  );
  return path.join(dir, "package.json");
}

describe("官方插件白名单", () => {
  it("白名单恰为两个官方插件（严格，不随扫描变化）", () => {
    expect(OFFICIAL_PLUGINS.map((p) => p.package).sort()).toEqual([
      "@kevlns/u-cli-mod",
      "@kevlns/xlmerge",
    ]);
    expect(OFFICIAL_COMMAND_NAMES.has("xlmerge")).toBe(true);
    expect(OFFICIAL_COMMAND_NAMES.has("unity")).toBe(true);
    expect(isOfficialCommand("xlmerge")).toBe(true);
    expect(isOfficialCommand("unity")).toBe(true);
    expect(isOfficialCommand("doctor")).toBe(false);
  });

  it("白名单不解析非白名单包（defaultResolvePackage 对未知包返回 undefined）", () => {
    expect(defaultResolvePackage("@kevlns/not-registered")).toBeUndefined();
    expect(defaultResolvePackage("some-other-tool")).toBeUndefined();
  });
});

describe("discoverOfficialPlugin", () => {
  it("fixture 下 discovery 成功：available + 完整元数据 + bin 绝对路径", () => {
    const pkgJsonPath = path.join(FIXTURES, "node_modules", "@kevlns", "xlmerge", "package.json");
    const info = discoverOfficialPlugin(
      OFFICIAL_PLUGINS[0],
      fsIo("win32", () => pkgJsonPath),
    );
    expect(info.status).toBe("available");
    expect(info.package).toBe("@kevlns/xlmerge");
    expect(info.name).toBe("xlmerge");
    expect(info.version).toBe("1.2.1-beta.2");
    expect(info.requiredPlatforms).toEqual(["darwin", "linux", "win32"]);
    expect(info.bin).toBe(path.join(FIXTURES, "node_modules", "@kevlns", "xlmerge", "bin", "xlmerge.js"));
    expect(info.whenToUse).toContain("fixture");
    expect(info.globalOptions?.[0].flags).toBe("--repo <path>");
    expect(info.commands?.map((c) => c.path.join(" "))).toEqual(["detect", "apply"]);
    expect(info.environment?.[0].name).toBe("XLMERGE_FIXTURE");
    expect(info.error).toBeUndefined();
    // 全量清单元数据透传：arguments/options/output/exitCodes/safety
    const detect = info.commands?.[0]!;
    expect(detect.usage).toBe("xlmerge --repo <repo> detect");
    expect(detect.arguments).toEqual([]);
    expect(detect.options).toEqual([]);
    expect(detect.output).toEqual({ format: "json", description: "fixture 输出" });
    expect(detect.exitCodes).toEqual({ "0": "success" });
    expect(detect.safety).toEqual(["read-only"]);
    const apply = info.commands?.[1]!;
    expect(apply.options[0].flags).toBe("--manifest <file>");
    expect(apply.options[0].description).toBe("manifest 文件（fixture）");
    expect(apply.exitCodes).toEqual({ "0": "success", "1": "error" });
    expect(apply.safety).toEqual(["writes-worktree", "commits-by-default"]);
  });

  it("包不可解析 → missing（含包名与原因）", () => {
    const info = discoverOfficialPlugin(OFFICIAL_PLUGINS[0], fsIo("win32", () => undefined));
    expect(info.status).toBe("missing");
    expect(info.error).toContain("@kevlns/xlmerge");
    expect(info.bin).toBeUndefined();
  });

  it("清单缺文件 → missing", () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "@kevlns/xlmerge", bin: { xlmerge: "bin.js" } }),
      "utf-8",
    );
    const info = discoverOfficialPlugin(OFFICIAL_PLUGINS[0], fsIo("win32", () => path.join(dir, "package.json")));
    expect(info.status).toBe("missing");
    expect(info.error).toContain("v-cli.plugin.json");
  });

  it("清单 schema 无效 → invalid（含校验错误）", () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "@kevlns/xlmerge", bin: { xlmerge: "bin.js" }, vCli: { manifest: "v-cli.plugin.json" } }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(dir, "v-cli.plugin.json"),
      JSON.stringify({ schemaVersion: 2, package: "@kevlns/xlmerge", command: "xlmerge" }),
      "utf-8",
    );
    const info = discoverOfficialPlugin(OFFICIAL_PLUGINS[0], fsIo("win32", () => path.join(dir, "package.json")));
    expect(info.status).toBe("invalid");
    expect(info.error).toContain("schemaVersion");
  });

  it("身份不一致（package/bin 不匹配）→ invalid", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@kevlns/other" }), "utf-8");
    fs.writeFileSync(path.join(dir, "v-cli.plugin.json"), JSON.stringify({
      schemaVersion: 1,
      package: "@kevlns/xlmerge",
      command: "xlmerge",
      bin: "xlmerge",
      description: "d",
      platforms: ["win32"],
      runtime: {},
      environment: [],
      agent: { whenToUse: "w", globalOptions: [], commands: [] },
    }), "utf-8");
    const info = discoverOfficialPlugin(OFFICIAL_PLUGINS[0], fsIo("win32", () => path.join(dir, "package.json")));
    expect(info.status).toBe("invalid");
    expect(info.error).toContain("身份校验失败");
  });

  it("平台不匹配 → platform-mismatch（unity 仅 win32，注入 linux）", () => {
    const pkgJsonPath = path.join(FIXTURES, "node_modules", "@kevlns", "u-cli-mod", "package.json");
    const spec = OFFICIAL_PLUGINS.find((p) => p.command === "unity")!;
    const info = discoverOfficialPlugin(spec, fsIo("linux", () => pkgJsonPath));
    expect(info.status).toBe("platform-mismatch");
    expect(info.requiredPlatforms).toEqual(["win32"]);
    expect(info.error).toContain("linux");
  });

  it("bin 目标非字符串 -> invalid（绝不抛出）", () => {
    const dir = tmpDir();
    const pkgJsonPath = writeTempPlugin(dir, {
      name: "@kevlns/xlmerge",
      bin: { xlmerge: 123 },
      vCli: { manifest: "v-cli.plugin.json" },
    });
    const info = discoverOfficialPlugin(OFFICIAL_PLUGINS[0], fsIo("win32", () => pkgJsonPath));
    expect(info.status).toBe("invalid");
    expect(info.error).toContain("不是字符串");
  });

  it("package.json bin 为字符串（非对象）-> invalid（绝不抛出）", () => {
    const dir = tmpDir();
    const pkgJsonPath = writeTempPlugin(dir, {
      name: "@kevlns/xlmerge",
      bin: "xlmerge",
      vCli: { manifest: "v-cli.plugin.json" },
    });
    const info = discoverOfficialPlugin(OFFICIAL_PLUGINS[0], fsIo("win32", () => pkgJsonPath));
    expect(info.status).toBe("invalid");
    expect(info.error).toContain("身份校验失败");
  });

  it("bin 目标逃逸包目录（../outside.js）-> invalid", () => {
    const dir = tmpDir();
    const pkgJsonPath = writeTempPlugin(dir, {
      name: "@kevlns/xlmerge",
      bin: { xlmerge: "../outside.js" },
      vCli: { manifest: "v-cli.plugin.json" },
    });
    const info = discoverOfficialPlugin(OFFICIAL_PLUGINS[0], fsIo("win32", () => pkgJsonPath));
    expect(info.status).toBe("invalid");
    expect(info.error).toContain("逃逸");
  });

  it("bin 文件不存在 -> missing（诚实报告，绝不抛出）", () => {
    const dir = tmpDir();
    const pkgJsonPath = writeTempPlugin(dir, {
      name: "@kevlns/xlmerge",
      bin: { xlmerge: "missing-bin.js" },
      vCli: { manifest: "v-cli.plugin.json" },
    });
    const info = discoverOfficialPlugin(OFFICIAL_PLUGINS[0], fsIo("win32", () => pkgJsonPath));
    expect(info.status).toBe("missing");
    expect(info.error).toContain("bin 文件不存在");
    expect(info.bin).toBeUndefined();
  });

  it("内置命令不受官方发现影响（互不干扰）", () => {
    const all = discoverAllOfficialPlugins(fsIo("win32", (pkg) => {
      const p = path.join(FIXTURES, "node_modules", pkg, "package.json");
      return fs.existsSync(p) ? p : undefined;
    }));
    for (const info of all) {
      expect(["available", "missing", "invalid", "platform-mismatch"]).toContain(info.status);
      expect(isOfficialCommand(info.name)).toBe(true);
      expect(info.source).toBe("official");
    }
    expect(all.map((i) => i.name).sort()).toEqual(["unity", "xlmerge"]);
  });

  it("whitelist 解析器绝不被要求解析非白名单包", () => {
    const calls: string[] = [];
    discoverAllOfficialPlugins(
      fsIo("win32", (pkg) => {
        calls.push(pkg);
        const p = path.join(FIXTURES, "node_modules", pkg, "package.json");
        return fs.existsSync(p) ? p : undefined;
      }),
    );
    expect(calls).toEqual(["@kevlns/xlmerge", "@kevlns/u-cli-mod"]);
  });
});

describe("defaultResolvePackage（全局安装布局：从 v-cli 本体位置向上查找）", () => {
  function writePackage(pkgRoot: string, name: string): void {
    fs.mkdirSync(pkgRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pkgRoot, "package.json"),
      JSON.stringify({ name, version: "1.0.0" }),
      "utf-8",
    );
  }

  it("同级布局：<prefix>/node_modules/@kevlns/{v-cli,xlmerge}（全局安装形态）", () => {
    const prefix = tmpDir();
    const vcliDist = path.join(prefix, "node_modules", "@kevlns", "v-cli", "dist", "cli.mjs");
    writePackage(path.join(prefix, "node_modules", "@kevlns", "xlmerge"), "@kevlns/xlmerge");
    writePackage(path.join(prefix, "node_modules", "@kevlns", "u-cli-mod"), "@kevlns/u-cli-mod");
    const unrelatedCwd = tmpDir();

    expect(defaultResolvePackage("@kevlns/xlmerge", { base: vcliDist, cwd: unrelatedCwd })).toBe(
      path.join(prefix, "node_modules", "@kevlns", "xlmerge", "package.json"),
    );
    expect(defaultResolvePackage("@kevlns/u-cli-mod", { base: vcliDist, cwd: unrelatedCwd })).toBe(
      path.join(prefix, "node_modules", "@kevlns", "u-cli-mod", "package.json"),
    );
    expect(
      defaultResolvePackage("@kevlns/not-registered", { base: vcliDist, cwd: unrelatedCwd }),
    ).toBeUndefined();
  });

  it("嵌套布局：v-cli 自身 node_modules 下的官方依赖优先被解析", () => {
    const prefix = tmpDir();
    const vcliDist = path.join(prefix, "node_modules", "@kevlns", "v-cli", "dist", "cli.mjs");
    // 同级未安装；嵌套安装
    writePackage(
      path.join(prefix, "node_modules", "@kevlns", "v-cli", "node_modules", "@kevlns", "xlmerge"),
      "@kevlns/xlmerge",
    );
    const unrelatedCwd = tmpDir();
    expect(defaultResolvePackage("@kevlns/xlmerge", { base: vcliDist, cwd: unrelatedCwd })).toBe(
      path.join(
        prefix,
        "node_modules",
        "@kevlns",
        "v-cli",
        "node_modules",
        "@kevlns",
        "xlmerge",
        "package.json",
      ),
    );
  });

  it("resolveFrom 根优先于本体位置（fixture/本地开发钩子）", () => {
    const prefix = tmpDir();
    const vcliDist = path.join(prefix, "node_modules", "@kevlns", "v-cli", "dist", "cli.mjs");
    writePackage(path.join(prefix, "node_modules", "@kevlns", "xlmerge"), "@kevlns/xlmerge");
    const fixtureRoot = tmpDir();
    writePackage(path.join(fixtureRoot, "node_modules", "@kevlns", "xlmerge"), "@kevlns/xlmerge");
    expect(
      defaultResolvePackage("@kevlns/xlmerge", {
        base: vcliDist,
        cwd: tmpDir(),
        resolveFrom: fixtureRoot,
      }),
    ).toBe(path.join(fixtureRoot, "node_modules", "@kevlns", "xlmerge", "package.json"));
  });
});