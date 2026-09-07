import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(__dirname, "../dist/cli.mjs");
const FIXTURE_ROOT = resolve(__dirname, "fixtures", "installed");
const BROKEN_ROOT = resolve(__dirname, "fixtures", "broken");
const homes: string[] = [];

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), "v-cli-it-"));
  homes.push(home);
  return home;
}

function run(args: string[], home: string, extraEnv: Record<string, string> = {}): string {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: "utf-8",
    env: { ...process.env, V_CLI_HOME: home, ...extraEnv },
  });
}

function runWithStatus(
  args: string[],
  home: string,
  extraEnv: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf-8",
    env: { ...process.env, V_CLI_HOME: home, ...extraEnv },
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function writePlugin(home: string, fileName: string, content: string): void {
  const cmdDir = join(home, "commands");
  mkdirSync(cmdDir, { recursive: true });
  writeFileSync(join(cmdDir, fileName), content, "utf-8");
}

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error("先执行 npm run build 再跑集成测试");
});

afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe("CLI 集成", () => {
  it("--version 为 0.2.5", () => {
    expect(run(["--version"], newHome()).trim()).toBe("0.2.5");
  });

  it("--help 列出内置命令与官方插件命令", () => {
    const help = run(["--help"], newHome());
    for (const name of ["doctor", "plugin", "ts", "agent", "xlmerge", "unity"]) {
      expect(help).toContain(name);
    }
  });

  it("ts 1710000000 转出正确时间", () => {
    expect(run(["ts", "1710000000"], newHome())).toContain("2024");
  });

  it("--json 在子命令后也生效且输出合法 JSON（builtin 自声明 --json）", () => {
    const data = JSON.parse(run(["ts", "1710000000", "--json"], newHome()));
    expect(data.seconds).toBe(1710000000);
    expect(data.iso).toBe("2024-03-09T16:00:00.000Z");
  });

  it("全局 --json 在前置段被消费，ctx.json 生效", () => {
    const data = JSON.parse(run(["--json", "ts", "1710000000"], newHome()));
    expect(data.seconds).toBe(1710000000);
  });

  it("doctor --json 输出结构化体检报告（含 officialPlugins，官方依赖已安装）", () => {
    const data = JSON.parse(run(["doctor", "--json"], newHome()));
    expect(data).toHaveProperty("version");
    expect(data).toHaveProperty("node");
    expect(data.configWritable).toBe(true);
    expect(Array.isArray(data.officialPlugins)).toBe(true);
    expect(data.officialPlugins.length).toBe(2);
    // 官方依赖已随 npm install 装入仓库 → 诚实 available（unity 非 win32 为 platform-mismatch）
    const xl = data.officialPlugins.find((o: { name: string }) => o.name === "xlmerge");
    expect(xl).toBeTruthy();
    expect(xl.status).toBe("available");
    expect(xl.version).toBe("1.3.1");
    const unity = data.officialPlugins.find((o: { name: string }) => o.name === "unity");
    expect(unity).toBeTruthy();
    expect(unity.status).toBe(process.platform === "win32" ? "available" : "platform-mismatch");
    if (process.platform === "win32") expect(unity.version).toBe("0.1.4");
  });

  it("plugin list 包含内置命令与官方插件行（官方依赖已安装）", () => {
    const data = JSON.parse(run(["plugin", "list", "--json"], newHome()));
    const names = data.filter((r: { source: string }) => r.source === "builtin").map((r: { name: string }) => r.name);
    for (const name of ["doctor", "plugin", "ts", "agent"]) expect(names).toContain(name);
    const official = data.filter((r: { source: string }) => r.source === "official");
    expect(official.map((r: { name: string }) => r.name).sort()).toEqual(["unity", "xlmerge"]);
    const xl = official.find((r: { name: string }) => r.name === "xlmerge");
    expect(xl.status).toBe("available");
    expect(xl.version).toBe("1.3.1");
    const unity = official.find((r: { name: string }) => r.name === "unity");
    expect(unity.status).toBe(process.platform === "win32" ? "available" : "platform-mismatch");
    if (process.platform === "win32") expect(unity.version).toBe("0.1.4");
  });

  it("plugin list --json 在 fixture 下官方插件可用（win32 主机含 unity）", () => {
    const data = JSON.parse(
      run(["plugin", "list", "--json"], newHome(), { V_CLI_PLUGIN_RESOLVE_FROM: FIXTURE_ROOT }),
    );
    const official = data.filter((r: { source: string }) => r.source === "official");
    const xl = official.find((r: { name: string }) => r.name === "xlmerge");
    expect(xl.status).toBe("available");
    expect(xl.version).toBe("1.2.1-beta.2");
    const unity = official.find((r: { name: string }) => r.name === "unity");
    expect(unity.status).toBe(process.platform === "win32" ? "available" : "platform-mismatch");
  });
});

describe("CLI 集成：官方插件命令拦截与转发（fixture 注入）", () => {
  it("xlmerge 后置词元 verbatim 转发（含 --json/--/自有选项）", () => {
    const out = run(["xlmerge", "detect", "--json", "--x", "--", "--repo", "r"], newHome(), {
      V_CLI_PLUGIN_RESOLVE_FROM: FIXTURE_ROOT,
    });
    const payload = JSON.parse(out.split("\n")[0]);
    expect(payload.argv).toEqual(["detect", "--json", "--x", "--", "--repo", "r"]);
  });

  it("前置全局 --json 被消费、不转发", () => {
    const out = run(["--json", "xlmerge", "detect"], newHome(), {
      V_CLI_PLUGIN_RESOLVE_FROM: FIXTURE_ROOT,
    });
    const payload = JSON.parse(out.split("\n")[0]);
    expect(payload.argv).toEqual(["detect"]);
  });

  it("插件 --help 落到插件（不经过 commander）", () => {
    const out = run(["xlmerge", "--help"], newHome(), { V_CLI_PLUGIN_RESOLVE_FROM: FIXTURE_ROOT });
    const payload = JSON.parse(out.split("\n")[0]);
    expect(payload.argv).toEqual(["--help"]);
  });

  it("注入环境：V_CLI_HOST_VERSION / V_CLI_PLUGIN_API / V_CLI_INVOKED_BY", () => {
    const out = run(["xlmerge", "detect"], newHome(), { V_CLI_PLUGIN_RESOLVE_FROM: FIXTURE_ROOT });
    const payload = JSON.parse(out.split("\n")[0]);
    expect(payload.env).toEqual({
      V_CLI_HOST_VERSION: "0.2.5",
      V_CLI_PLUGIN_API: "1",
      V_CLI_INVOKED_BY: "v-cli",
    });
  });

  it("插件退出码原样传播（--exit-42 → 42）", () => {
    const r = runWithStatus(["xlmerge", "--exit-42"], newHome(), {
      V_CLI_PLUGIN_RESOLVE_FROM: FIXTURE_ROOT,
    });
    expect(r.status).toBe(42);
  });

  it.skipIf(process.platform !== "win32")("unity 命令在 win32 路由到 u-cli-mod 包", () => {
    const out = run(["unity", "doctor", "proj"], newHome(), { V_CLI_PLUGIN_RESOLVE_FROM: FIXTURE_ROOT });
    const payload = JSON.parse(out.split("\n")[0]);
    expect(payload.argv).toEqual(["doctor", "proj"]);
  });

  it.skipIf(process.platform === "win32")("unity 命令在非 win32 平台 fail-closed", () => {
    const r = runWithStatus(["unity", "doctor", "proj"], newHome(), {
      V_CLI_PLUGIN_RESOLVE_FROM: FIXTURE_ROOT,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("仅支持平台 [win32]");
    expect(r.stderr).toContain(`当前平台为 ${process.platform}`);
  });

  it("官方插件不可用（resolveFrom 指向缺 manifest 的包）→ 非零退出 + stderr 解释", () => {
    const r = runWithStatus(["xlmerge", "detect"], newHome(), {
      V_CLI_PLUGIN_RESOLVE_FROM: BROKEN_ROOT,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("@kevlns/xlmerge");
    expect(r.stderr).toContain("不可用");
  });

  it("--bogus xlmerge 被 commander 拒绝（不静默吞掉、不路由到插件）", () => {
    const r = runWithStatus(["--bogus", "xlmerge"], newHome(), {
      V_CLI_PLUGIN_RESOLVE_FROM: FIXTURE_ROOT,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/unknown option/i);
    expect(r.stderr).not.toContain("不可用"); // 未被当作官方命令拦截路由
    expect(r.stdout).not.toContain("fixture-stderr-marker"); // 插件未被调用
  });
});

describe("CLI 集成：信号转发（仅 POSIX；子进程收到 SIGTERM 并自杀，v-cli 映射 143）", () => {
  it.skipIf(process.platform === "win32")(
    "v-cli 收到 SIGTERM 后转发给插件子进程，退出码 128+15",
    async () => {
      const home = newHome();
      const receipt = join(home, "term-receipt.txt");
      const ready = join(home, "ready.txt");
      const child = spawn(
        process.execPath,
        [CLI, "xlmerge", "--hold"],
        {
          env: {
            ...process.env,
            V_CLI_HOME: home,
            V_CLI_PLUGIN_RESOLVE_FROM: FIXTURE_ROOT,
            V_CLI_TEST_TERM_FILE: receipt,
            V_CLI_TEST_READY_FILE: ready,
          },
        },
      );
      try {
        const deadline = Date.now() + 10000;
        while (!existsSync(ready) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(existsSync(ready), "插件未就绪").toBe(true);
        child.kill("SIGTERM");
        const code = await new Promise<number | null>((resolvePromise, reject) => {
          const timer = setTimeout(() => reject(new Error("CLI 未在 10s 内退出")), 10000);
          child.on("close", (c) => {
            clearTimeout(timer);
            resolvePromise(c);
          });
          child.on("error", reject);
        });
        expect(code).toBe(143);
        expect(readFileSync(receipt, "utf-8")).toBe("TERM");
      } finally {
        child.kill("SIGKILL");
      }
    },
    20000,
  );
});

describe("CLI 集成：agent 索引", () => {
  it("agent index --json 包含三类命令与 builtin agent 命令自身", () => {
    const rows = JSON.parse(run(["agent", "index", "--json"], newHome()));
    const names = rows.map((r: { name: string }) => r.name);
    for (const n of ["doctor", "plugin", "ts", "agent", "xlmerge", "unity"]) expect(names).toContain(n);
    const agentRow = rows.find((r: { name: string }) => r.name === "agent");
    expect(agentRow.type).toBe("builtin");
  });

  it("agent index --json 对官方插件给出 full 元数据（fixture 下）", () => {
    const rows = JSON.parse(
      run(["agent", "index", "--json"], newHome(), { V_CLI_PLUGIN_RESOLVE_FROM: FIXTURE_ROOT }),
    );
    const xl = rows.find((r: { name: string }) => r.name === "xlmerge");
    expect(xl.metadataStatus).toBe("full");
    expect(xl.whenToUse).toContain("fixture");
    expect(xl.commands.map((c: { path: string[] }) => c.path.join(" "))).toEqual(["detect", "apply"]);
    expect(xl.globalOptions[0].flags).toBe("--repo <path>");
  });

  it("agent describe xlmerge --json 给出完整记录（fixture 下）", () => {
    const row = JSON.parse(
      run(["agent", "describe", "xlmerge", "--json"], newHome(), { V_CLI_PLUGIN_RESOLVE_FROM: FIXTURE_ROOT }),
    );
    expect(row.name).toBe("xlmerge");
    expect(row.type).toBe("official");
    expect(row.package).toBe("@kevlns/xlmerge");
    expect(row.status).toBe("available");
    expect(row.whenToUse).toContain("fixture");
  });

  it("agent describe 未知名 → 非零退出 + stderr 错误", () => {
    const r = runWithStatus(["agent", "describe", "no-such-cmd", "--json"], newHome());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("未找到命令");
  });

  it("agent describe 支持文本模式", () => {
    const out = run(["agent", "describe", "ts"], newHome());
    expect(out).toContain("命令: ts (builtin)");
    expect(out).toContain("描述:");
  });
});

describe("CLI 集成：本地插件（apiVersion 1 契约）", () => {
  const GOOD_PLUGIN = `export default {
  name: "hello",
  description: "本地测试插件",
  apiVersion: 1,
  register(program, ctx) {
    program.action(() => ctx.log.result("hello-from-plugin"));
  },
};
`;

  function homeWithPlugins(): string {
    const home = newHome();
    writePlugin(home, "good.mjs", GOOD_PLUGIN);
    writePlugin(home, "broken.mjs", "this is not valid js {{{");
    writePlugin(home, "wrong-shape.mjs", "export default { name: 123 }");
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
    const failed = local.filter((r: { name: string }) => r.name === "(加载失败)");
    expect(failed.length).toBe(2);
  });

  it("doctor --json 统计插件与错误", () => {
    const home = homeWithPlugins();
    const data = JSON.parse(run(["doctor", "--json"], home));
    expect(data.localPluginCount).toBe(3);
    expect(data.localPlugins.filter((p: { error: string | null }) => p.error).length).toBe(2);
  });

  it("旧版插件（缺 apiVersion）被拒绝并给出解释性错误", () => {
    const home = newHome();
    writePlugin(
      home,
      "legacy.mjs",
      `export default { name: "legacy", description: "旧版", register() {} }`,
    );
    const data = JSON.parse(run(["plugin", "list", "--json"], home));
    const failed = data.find((r: { name: string }) => r.name === "(加载失败)");
    expect(failed.description).toContain("apiVersion 必须为 1");
    expect(failed.description).toContain("旧版插件");
  });

  it("本地插件不能占用官方命令名（xlmerge）", () => {
    const home = newHome();
    writePlugin(home, "shadow.mjs", `export default { name: "xlmerge", description: "sh", apiVersion: 1, register() {} }`);
    const data = JSON.parse(run(["plugin", "list", "--json"], home));
    const failed = data.find((r: { name: string }) => r.name === "(加载失败)");
    expect(failed.description).toContain("官方插件命令");
  });

  it("register 抛异常的插件不出现在 --help（无幽灵命令）", () => {
    const home = newHome();
    writePlugin(
      home,
      "bad-register.mjs",
      `export default { name: "badreg", description: "注册即炸", apiVersion: 1, register() { throw new Error("boom"); } }`,
    );
    const help = run(["--help"], home);
    expect(help).not.toContain("badreg");
    expect(help).toContain("doctor");
  });

  it("畸形 agent 自定义元数据（commands[].path 缺失）不崩溃：agent index/describe 仍正常", () => {
    const home = newHome();
    writePlugin(
      home,
      "badagent.mjs",
      `export default { name: "badagent", description: "畸形元数据", apiVersion: 1, agent: { commands: [{ description: "缺 path" }] }, register() {} }`,
    );
    const index = runWithStatus(["agent", "index", "--json"], home);
    expect(index.status, index.stderr).toBe(0);
    const rows = JSON.parse(index.stdout);
    const failed = rows.find((r: { name: string }) => r.name === "badagent");
    expect(failed).toBeTruthy();
    expect(failed.description).toContain("path");
    expect(failed.metadataStatus).toBe("minimal");
    // describe 不受影响、正常退出
    const desc = runWithStatus(["agent", "describe", "ts"], home);
    expect(desc.status).toBe(0);
    expect(desc.stdout).toContain("命令: ts (builtin)");
  });

  it("register 抛异常的插件被隔离：不阻断其他命令，警告进 stderr", () => {
    const home = newHome();
    writePlugin(
      home,
      "bad-register.mjs",
      `export default { name: "badreg", description: "注册即炸", apiVersion: 1, register() { throw new Error("boom"); } }`,
    );
    writePlugin(home, "good.mjs", GOOD_PLUGIN);
    const hello = runWithStatus(["hello"], home);
    expect(hello.status).toBe(0);
    expect(hello.stdout).toContain("hello-from-plugin");
    expect(hello.stderr).toContain("bad-register.mjs");
    expect(hello.stderr).toContain("register 失败");
    const list = JSON.parse(run(["plugin", "list", "--json"], home));
    expect(list.some((r: { name: string }) => r.name === "hello")).toBe(true);
  });
});
