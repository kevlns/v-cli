import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolve } from "node:path";

const GENERATOR = resolve(__dirname, "..", "scripts", "generate-agents.mjs");
const REPO_ROOT = resolve(__dirname, "..");

const dirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v-cli-agents-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function writeManifest(
  dir: string,
  name: string,
  packageName: string,
  command: string,
  extra: { bin?: string; usage?: string } = {},
): string {
  const file = path.join(dir, `${name}.plugin.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        schemaVersion: 1,
        package: packageName,
        command,
        bin: extra.bin ?? command,
        description: `描述 ${command}`,
        platforms: ["darwin", "linux", "win32"],
        runtime: { node: ">=20" },
        environment: [],
        agent: {
          whenToUse: `何时使用 ${command}`,
          globalOptions: [{ flags: "--flag <v>", description: "选项" }],
          commands: [
            {
              path: ["run"],
              usage: extra.usage ?? `${command} run`,
              description: "运行",
              arguments: [],
              options: [],
              output: { format: "json", description: "o" },
              exitCodes: { 0: "success" },
              safety: ["read-only"],
            },
          ],
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  return file;
}

function runGenerator(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [GENERATOR, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

describe("generate-agents.mjs", () => {
  it("两清单生成确定输出（两次运行字节一致）", () => {
    const dir = tmpDir();
    const m1 = writeManifest(dir, "m1", "@kevlns/aaa", "alpha");
    const m2 = writeManifest(dir, "m2", "@kevlns/zzz", "zeta");
    const out1 = path.join(dir, "AGENTS-1.md");
    const out2 = path.join(dir, "AGENTS-2.md");
    const r1 = runGenerator(["--manifest", m1, "--manifest", m2, "--output", out1]);
    const r2 = runGenerator(["--manifest", m1, "--manifest", m2, "--output", out2]);
    expect(r1.status).toBe(0);
    expect(r2.status).toBe(0);
    expect(fs.readFileSync(out1, "utf-8")).toBe(fs.readFileSync(out2, "utf-8"));
  });

  it("内容包含标记行、按包名排序、命令路由与 whenToUse", () => {
    const dir = tmpDir();
    const m1 = writeManifest(dir, "m1", "@kevlns/zzz", "zeta");
    const m2 = writeManifest(dir, "m2", "@kevlns/aaa", "alpha");
    const out = path.join(dir, "AGENTS.md");
    const r = runGenerator(["--manifest", m1, "--manifest", m2, "--output", out]);
    expect(r.status).toBe(0);
    const content = fs.readFileSync(out, "utf-8");
    expect(content).toContain("<!-- v-cli-agents:generated -->");
    expect(content.indexOf("@kevlns/aaa")).toBeLessThan(content.indexOf("@kevlns/zzz"));
    expect(content).toContain("`v-cli alpha …`");
    expect(content).toContain("`v-cli zeta …`");
    expect(content).toContain("何时使用 alpha");
    expect(content).toContain("v-cli agent index --json");
  });

  it("用法前缀改写为控制器形式，安全标签独立成行（确定性）", () => {
    const dir = tmpDir();
    // command 前缀：usage “alpha run” -> “v-cli alpha run”
    const m1 = writeManifest(dir, "m1", "@kevlns/aaa", "alpha");
    // bin 前缀：command=unity、bin=u-cli-mod，usage “u-cli-mod doctor <p>” -> “v-cli unity doctor <p>”
    const m2 = writeManifest(dir, "m2", "@kevlns/bbb", "unity", {
      bin: "u-cli-mod",
      usage: "u-cli-mod doctor <project> [options]",
    });
    const out = path.join(dir, "AGENTS.md");
    const r = runGenerator(["--manifest", m1, "--manifest", m2, "--output", out]);
    expect(r.status).toBe(0);
    const content = fs.readFileSync(out, "utf-8");
    expect(content).toContain("用法：`v-cli alpha run`");
    expect(content).toContain("用法：`v-cli unity doctor <project> [options]`");
    expect(content).toContain("安全标签：read-only");
    expect(content).not.toContain("`alpha run`");
    expect(content).not.toContain("u-cli-mod doctor");
  });

  it("默认模式（无 --manifest）：从已安装官方依赖生成；未安装且无 sibling 清单时给出未安装说明", () => {
    const dir = tmpDir();
    // 独立 cwd：只有 package.json，无 node_modules、无 ../xlmerge|../u-cli-mod sibling
    // 仓库 -> installed 模式必为“未安装”
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "@kevlns/v-cli", version: "0.2.0-beta.2" }),
      "utf-8",
    );
    const r = spawnSync(process.execPath, [GENERATOR], { cwd: dir, encoding: "utf-8" });
    expect(r.status).toBe(0);
    const content = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8");
    expect(content).toContain("未安装");
    expect(content).toContain("v-cli agent index --json");
    // 未安装模式下，与已生成的 bootstrap 内容相比必然漂移
    const check = spawnSync(process.execPath, [GENERATOR, "--check"], { cwd: dir, encoding: "utf-8" });
    expect(check.status).toBe(0); // 与自己刚生成的一致
    expect(check.stdout).toContain("最新");
  });

  it("默认模式 sibling 回退：官方依赖未安装时用 ../xlmerge + ../u-cli-mod 清单（确定性）", () => {
    // 布局：root/v-cli（cwd，仅 package.json）；root/{xlmerge,u-cli-mod}（sibling 仓库）
    const root = tmpDir();
    const repoDir = path.join(root, "v-cli");
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, "package.json"),
      JSON.stringify({ name: "@kevlns/v-cli", version: "0.2.0-beta.2" }),
      "utf-8",
    );
    const xl = path.join(root, "xlmerge");
    fs.mkdirSync(xl, { recursive: true });
    const uc = path.join(root, "u-cli-mod");
    fs.mkdirSync(uc, { recursive: true });
    writeManifest(xl, "v-cli", "@kevlns/xlmerge", "xlmerge", { usage: "xlmerge --repo <r> detect" });
    writeManifest(uc, "v-cli", "@kevlns/u-cli-mod", "unity", {
      bin: "u-cli-mod",
      usage: "u-cli-mod doctor <p>",
    });
    fs.writeFileSync(
      path.join(xl, "package.json"),
      JSON.stringify({ name: "@kevlns/xlmerge", version: "1.2.1-beta.2" }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(uc, "package.json"),
      JSON.stringify({ name: "@kevlns/u-cli-mod", version: "0.1.0-beta.2" }),
      "utf-8",
    );

    const r = spawnSync(process.execPath, [GENERATOR], { cwd: repoDir, encoding: "utf-8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("sibling 清单回退");
    const content = fs.readFileSync(path.join(repoDir, "AGENTS.md"), "utf-8");
    // 两个插件齐全、带版本行、命令路由改写为控制器形式、安全标签独立成行
    expect(content).toContain("**版本**：1.2.1-beta.2");
    expect(content).toContain("**版本**：0.1.0-beta.2");
    expect(content).toContain("`v-cli xlmerge --repo <r> detect`");
    expect(content).toContain("`v-cli unity doctor <p>`");
    expect(content).toContain("安全标签：read-only");
    expect(content).not.toContain("`xlmerge --repo <r> detect`");
    expect(content).not.toContain("`u-cli-mod doctor`");
    // 复位后第二次运行字节一致（确定性）
    const r2 = spawnSync(process.execPath, [GENERATOR], { cwd: repoDir, encoding: "utf-8" });
    expect(r2.status).toBe(0);
    expect(fs.readFileSync(path.join(repoDir, "AGENTS.md"), "utf-8")).toBe(content);
  });

  it("默认模式：已安装官方依赖优先于 sibling 回退（installed 胜出）", () => {
    const root = tmpDir();
    const repoDir = path.join(root, "v-cli");
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, "package.json"),
      JSON.stringify({ name: "@kevlns/v-cli", version: "0.2.0-beta.2" }),
      "utf-8",
    );
    // sibling 版本 9.9.9：若被回退路径使用，输出会含 9.9.9
    const xs = path.join(root, "xlmerge");
    fs.mkdirSync(xs, { recursive: true });
    writeManifest(xs, "v-cli", "@kevlns/xlmerge", "xlmerge");
    fs.writeFileSync(
      path.join(xs, "package.json"),
      JSON.stringify({ name: "@kevlns/xlmerge", version: "9.9.9" }),
      "utf-8",
    );
    // 已安装依赖：node_modules/@kevlns/xlmerge（真实安装布局）
    const installedPkg = path.join(repoDir, "node_modules", "@kevlns", "xlmerge");
    fs.mkdirSync(installedPkg, { recursive: true });
    writeManifest(installedPkg, "v-cli", "@kevlns/xlmerge", "xlmerge");
    fs.writeFileSync(
      path.join(installedPkg, "package.json"),
      JSON.stringify({ name: "@kevlns/xlmerge", version: "1.2.1-beta.2" }),
      "utf-8",
    );

    const r = spawnSync(process.execPath, [GENERATOR], { cwd: repoDir, encoding: "utf-8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("installed deps 模式");
    const content = fs.readFileSync(path.join(repoDir, "AGENTS.md"), "utf-8");
    expect(content).toContain("**版本**：1.2.1-beta.2");
    expect(content).not.toContain("9.9.9");
  });

  it("--check 无漂移 → 退出 0", () => {
    const dir = tmpDir();
    const m = writeManifest(dir, "m", "@kevlns/aaa", "alpha");
    const out = path.join(dir, "AGENTS.md");
    runGenerator(["--manifest", m, "--output", out]);
    const check = runGenerator(["--check", "--manifest", m, "--output", out]);
    expect(check.status).toBe(0);
    expect(check.stdout).toContain("最新");
  });

  it("--check 检测漂移 → 非零退出且不写文件", () => {
    const dir = tmpDir();
    const m = writeManifest(dir, "m", "@kevlns/aaa", "alpha");
    const out = path.join(dir, "AGENTS.md");
    runGenerator(["--manifest", m, "--output", out]);
    const before = fs.readFileSync(out, "utf-8");
    fs.appendFileSync(out, "\n手工改动\n", "utf-8");
    const check = runGenerator(["--check", "--manifest", m, "--output", out]);
    expect(check.status).not.toBe(0);
    expect(check.stderr).toContain("漂移");
    expect(fs.readFileSync(out, "utf-8")).toBe(before + "\n手工改动\n");
  });

  it("--check 目标不存在 → 非零退出并提示先生成", () => {
    const dir = tmpDir();
    const m = writeManifest(dir, "m", "@kevlns/aaa", "alpha");
    const out = path.join(dir, "missing.md");
    const check = runGenerator(["--check", "--manifest", m, "--output", out]);
    expect(check.status).not.toBe(0);
    expect(check.stderr).toContain("不存在");
  });

  it("重复 --manifest 传同文件时去重", () => {
    const dir = tmpDir();
    const m = writeManifest(dir, "m", "@kevlns/aaa", "alpha");
    const out = path.join(dir, "AGENTS.md");
    const r = runGenerator(["--manifest", m, "--manifest", m, "--output", out]);
    expect(r.status).toBe(0);
    const content = fs.readFileSync(out, "utf-8");
    expect(content.match(/@kevlns\/aaa/g)).toHaveLength(1);
  });

  it("schemaVersion != 1 的清单 → 非零退出", () => {
    const dir = tmpDir();
    const bad = path.join(dir, "bad.plugin.json");
    fs.writeFileSync(bad, JSON.stringify({ schemaVersion: 2 }), "utf-8");
    const out = path.join(dir, "AGENTS.md");
    const r = runGenerator(["--manifest", bad, "--output", out]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("schemaVersion");
  });

  it("未知参数 → 非零退出", () => {
    const r = runGenerator(["--nope"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("未知参数");
  });
});

describe("generate-agents.mjs（committed AGENTS.md 与 npm scripts 通路）", () => {
  // 默认门禁模式：本仓库（sibling 存在）现在即可无参通过；依赖发布安装后
  // 自动切到 installed-deps 模式，CI 中（无 sibling）同样生效，无硬编码参数。
  it("npm run check:agents（默认模式）保持漂移为零（sibling 缺失时跳过）", () => {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const npmCli =
      process.env.npm_execpath && fs.existsSync(process.env.npm_execpath)
        ? process.env.npm_execpath
        : path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    const args = fs.existsSync(npmCli) ? [npmCli, "run", "check:agents"] : [npmCmd, "run", "check:agents"];
    const r = execFileSync(process.execPath, args, {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    }).trim();
    expect(r).toContain("最新");
  });

  it("npm run check:agents 可转发显式 --manifest/--output 参数（不依赖实时 sibling 版本）", () => {
    const dir = tmpDir();
    const xl = writeManifest(dir, "xl", "@kevlns/xlmerge", "xlmerge");
    const uc = writeManifest(dir, "unity", "@kevlns/u-cli-mod", "unity", {
      bin: "u-cli-mod",
      usage: "u-cli-mod doctor <p>",
    });
    const output = path.join(dir, "AGENTS.md");
    const generated = runGenerator([
      "--manifest",
      xl,
      "--manifest",
      uc,
      "--output",
      output,
    ]);
    expect(generated.status).toBe(0);

    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const npmCli =
      process.env.npm_execpath && fs.existsSync(process.env.npm_execpath)
        ? process.env.npm_execpath
        : path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    const extraArgs = [
      "--",
      "--manifest",
      xl,
      "--manifest",
      uc,
      "--output",
      output,
    ];
    const args = fs.existsSync(npmCli)
      ? [npmCli, "run", "check:agents", ...extraArgs]
      : [npmCmd, "run", "check:agents", ...extraArgs];
    const r = execFileSync(process.execPath, args, {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    }).trim();
    expect(r).toContain("最新");
  });
});