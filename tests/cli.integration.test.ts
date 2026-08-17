import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(__dirname, "../dist/cli.mjs");
const homes: string[] = [];

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), "v-cli-it-"));
  homes.push(home);
  return home;
}

function run(args: string[], home: string): string {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: "utf-8",
    env: { ...process.env, V_CLI_HOME: home },
  });
}

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error("先执行 npm run build 再跑集成测试");
});

afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe("CLI 集成", () => {
  it("--version 输出版本号", () => {
    expect(run(["--version"], newHome()).trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("--help 列出三个内置命令", () => {
    const help = run(["--help"], newHome());
    for (const name of ["doctor", "plugin", "ts"]) expect(help).toContain(name);
  });

  it("ts 1710000000 转出正确时间", () => {
    expect(run(["ts", "1710000000"], newHome())).toContain("2024");
  });

  it("--json 在子命令后也生效且输出合法 JSON", () => {
    const data = JSON.parse(run(["ts", "1710000000", "--json"], newHome()));
    expect(data.seconds).toBe(1710000000);
    expect(data.iso).toBe("2024-03-09T16:00:00.000Z");
  });

  it("doctor --json 输出结构化体检报告", () => {
    const data = JSON.parse(run(["doctor", "--json"], newHome()));
    expect(data).toHaveProperty("version");
    expect(data).toHaveProperty("node");
    expect(data.configWritable).toBe(true);
  });

  it("plugin list 包含内置命令", () => {
    const data = JSON.parse(run(["plugin", "list", "--json"], newHome()));
    const names = data.filter((r: { source: string }) => r.source === "builtin").map((r: { name: string }) => r.name);
    for (const name of ["doctor", "plugin", "ts"]) expect(names).toContain(name);
  });
});

const GOOD_PLUGIN = `export default {
  name: "hello",
  description: "本地测试插件",
  register(program, ctx) {
    program.action(() => ctx.log.result("hello-from-plugin"));
  },
};
`;

describe("CLI 集成：本地插件（真实子进程，动态 import 原生可用）", () => {
  function homeWithPlugins(): string {
    const home = newHome();
    const cmdDir = join(home, "commands");
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(join(cmdDir, "good.mjs"), GOOD_PLUGIN, "utf-8");
    writeFileSync(join(cmdDir, "broken.mjs"), "this is not valid js {{{", "utf-8");
    writeFileSync(join(cmdDir, "wrong-shape.mjs"), "export default { name: 123 }", "utf-8");
    return home;
  }

  it("合法插件注册为命令并可执行", () => {
    const home = homeWithPlugins();
    expect(run(["hello"], home).trim()).toBe("hello-from-plugin");
  });

  it("坏插件不阻断：plugin list 显示 hello 与失败项", () => {
    const home = homeWithPlugins();
    const data = JSON.parse(run(["plugin", "list", "--json"], home));
    const local = data.filter((r: { source: string }) => r.source === "local");
    expect(local.some((r: { name: string }) => r.name === "hello")).toBe(true);
    // broken + wrong-shape 两个失败项：name 为 (加载失败)，description 含错误信息
    const failed = local.filter((r: { name: string }) => r.name === "(加载失败)");
    expect(failed.length).toBe(2);
  });

  it("doctor --json 统计插件与错误", () => {
    const home = homeWithPlugins();
    const data = JSON.parse(run(["doctor", "--json"], home));
    expect(data.localPluginCount).toBe(3);
    expect(data.localPlugins.filter((p: { error: string | null }) => p.error).length).toBe(2);
  });
});
