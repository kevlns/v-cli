import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const CLI = resolve(__dirname, "../dist/cli.mjs");
const SDK = resolve(__dirname, "../dist/sdk.mjs");
const PKG_ROOT = resolve(__dirname, "..");
const IS_WIN = process.platform === "win32";
const temps: string[] = [];

function newTemp(prefix = "vcli-cap-cli-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function run(
  args: string[],
  extraEnv: Record<string, string> = {},
): { status: number; stdout: string; stderr: string; json?: unknown } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf-8",
    env: { ...process.env, V_CLI_HOME: newTemp("vcli-cap-home-"), ...extraEnv },
    timeout: 120_000,
  });
  let json: unknown;
  const out = r.stdout ?? "";
  if (out.trim().startsWith("{") || out.trim().startsWith("[")) {
    try {
      json = JSON.parse(out);
    } catch {
      json = undefined;
    }
  }
  return { status: r.status ?? -1, stdout: out, stderr: r.stderr ?? "", json };
}

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error("先执行 npm run build 再跑集成测试");
});

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 建带 .vant/config/v-cli.json 的临时工程；可控制是否有 ProjectSettings */
function initProject(options: { withProjectVersion?: boolean; unityProjectDir?: string } = {}): {
  root: string;
  configFile: string;
} {
  const root = newTemp();
  execFileSync(process.execPath, [CLI, "project", "init", "--project", root, "--json"], {
    encoding: "utf-8",
    env: { ...process.env, V_CLI_HOME: newTemp("vcli-cap-home-") },
  });
  const configFile = join(root, ".vant", "config", "v-cli.json");
  if (options.unityProjectDir) {
    const config = JSON.parse(readFileSync(configFile, "utf-8"));
    config.bindings.unity.projectDir = options.unityProjectDir;
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  }
  if (options.withProjectVersion !== false) {
    const clientDir = join(root, options.unityProjectDir ?? "Client");
    mkdirSync(join(clientDir, "ProjectSettings"), { recursive: true });
    writeFileSync(
      join(clientDir, "ProjectSettings", "ProjectVersion.txt"),
      "m_EditorVersion: 2022.3.62f3c1\nm_EditorVersionWithRevision: 2022.3.62f3c1 (1623fc0bbb97)\n",
      "utf-8",
    );
  }
  return { root, configFile };
}

describe("CLI：project init / inspect", () => {
  it("--help 暴露 project / capability 内置命令", () => {
    const help = run(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("project");
    expect(help.stdout).toContain("capability");
  });

  it("project init 创建 .vant/config/v-cli.json，重复执行被拒绝（退出 1）", () => {
    const root = newTemp();
    const first = run(["project", "init", "--project", root, "--json"]);
    expect(first.status).toBe(0);
    const payload = first.json as { ok: boolean; action: string; relativeFile: string; warnings: string[] };
    expect(payload.ok).toBe(true);
    expect(payload.action).toBe("created");
    expect(payload.relativeFile).toBe(".vant/config/v-cli.json");
    const config = JSON.parse(readFileSync(join(root, ".vant", "config", "v-cli.json"), "utf-8"));
    expect(config).toEqual({ schemaVersion: 1, bindings: { unity: { projectDir: "Client" } } });

    const second = run(["project", "init", "--project", root, "--json"]);
    expect(second.status).toBe(1);
    expect((second.json as { action: string }).action).toBe("refused");
    expect(second.stderr).toContain("不覆盖已有配置");
  });

  it("project init 不覆盖 Vant 的 project.json", () => {
    const root = newTemp();
    const vantFile = join(root, ".vant", "config", "project.json");
    mkdirSync(join(root, ".vant", "config"), { recursive: true });
    writeFileSync(vantFile, '{"schemaVersion":1,"roles":[{"name":"client"}]}\n', "utf-8");
    const before = readFileSync(vantFile, "utf-8");
    expect(run(["project", "init", "--project", root, "--json"]).status).toBe(0);
    expect(readFileSync(vantFile, "utf-8")).toBe(before);
  });

  it("project inspect --json 报告配置/绑定/状态目录/provider（只读）", () => {
    const { root } = initProject();
    const r = run(["project", "inspect", "--project", root, "--json"]);
    expect(r.status).toBe(0);
    const payload = r.json as {
      config: { valid: boolean; bindingDirs: Record<string, string> };
      state: { exists: boolean; operationCount: number };
      providers: { id: string; state: string; capabilityCount: number }[];
    };
    expect(payload.config.valid).toBe(true);
    expect(payload.config.bindingDirs.unity).toBe(join(root, "Client"));
    expect(payload.state.exists).toBe(false);
    const unity = payload.providers.find((p) => p.id === "unity")!;
    expect(unity.capabilityCount).toBe(7);
    expect(unity.state).toBe(IS_WIN ? "available" : "platform-mismatch");
  });

  it("工程根不存在 → inspect 退出 1", () => {
    const root = newTemp();
    const r = run(["project", "inspect", "--project", join(root, "missing"), "--json"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("工程根不存在");
  });
});

describe("CLI：capability list / describe（不执行工具）", () => {
  it("list --json 列 provider 与 7 个 unity 能力", () => {
    const r = run(["capability", "list", "--json"]);
    expect(r.status).toBe(0);
    const payload = r.json as {
      providers: { id: string; state: string }[];
      capabilities: { id: string; preconditions: string[] }[];
    };
    expect(payload.providers.map((p) => p.id)).toEqual(["unity"]);
    expect(payload.capabilities.map((c) => c.id)).toEqual([
      "unity.compile",
      "unity.compile-status",
      "unity.doctor",
      "unity.editor-status",
      "unity.test-cancel",
      "unity.test-start",
      "unity.test-status",
    ]);
    expect(payload.capabilities.find((c) => c.id === "unity.compile")?.preconditions).toContain(
      "unity.pipeline-ready",
    );
  });

  it("describe --json 输出完整契约（schema/前置条件/副作用/资源/重试）", () => {
    const r = run(["capability", "describe", "unity.test-status", "--json"]);
    expect(r.status).toBe(0);
    const d = r.json as {
      id: string;
      inputSchema: { additionalProperties: boolean };
      outputSchema: { required: string[] };
      preconditions: { id: string }[];
      sideEffects: { kind: string }[];
      resources: { mode: string }[];
      retry: { safe: boolean; maxAttempts: number };
      provider: { id: string };
    };
    expect(d.id).toBe("unity.test-status");
    expect(d.inputSchema.additionalProperties).toBe(false);
    expect(d.outputSchema.required).toContain("failCount");
    expect(d.preconditions.map((p) => p.id)).toContain("unity.pipeline-ready");
    expect(d.sideEffects.map((s) => s.kind)).toContain("process-exec");
    expect(d.retry.maxAttempts).toBeGreaterThanOrEqual(1);
    expect(d.provider.id).toBe("unity");
  });

  it("未知 capability / 未知 provider → 退出 1", () => {
    expect(run(["capability", "describe", "nope.nope"]).status).toBe(1);
    const bad = run(["capability", "list", "--provider", "nope"]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("未知 provider");
  });
});

describe("CLI：capability run（退出码与结果对齐）", () => {
  it("未注册 capability → 退出 2，JSON 稀疏错误对象", () => {
    const root = newTemp();
    const r = run(["capability", "run", "nope.nope", "--project", root, "--json"]);
    expect(r.status).toBe(2);
    const payload = r.json as { ok: boolean; error: { code: string; message: string } };
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe("capability-unknown");
  });

  it("工程未初始化 → 退出 2 且给出 project init 指引", () => {
    const root = newTemp();
    const r = run(["capability", "run", "unity.doctor", "--project", root, "--json"]);
    expect(r.status).toBe(2);
    const payload = r.json as { error: { code: string; details: { hint: string } } };
    expect(payload.error.code).toBe("project-config-missing");
    expect(payload.error.details.hint).toContain("v-cli project init");
  });

  it("前置条件不足（无 ProjectSettings）→ 退出 2；记录 input.json/result.json", () => {
    const { root } = initProject({ withProjectVersion: false });
    const r = run(["capability", "run", "unity.doctor", "--project", root, "--operation-id", "op-cli-1", "--json"]);
    expect(r.status).toBe(2);
    const result = r.json as {
      execution: { status: string; error: { category: string; code: string } };
      acceptance: { status: string; pending: boolean };
      preconditions: { id: string; status: string }[];
      persisted: { status: string; dir: string; files: string[] };
      project: { root: string };
    };
    expect(result.execution.error.code).toBe("precondition-failed");
    expect(result.execution.error.category).toBe("precondition");
    expect(result.acceptance.status).toBe("not-run");
    expect(result.preconditions.find((p) => p.id === "unity.project-version-file")?.status).toBe("violated");
    expect(result.persisted.status).toBe("saved");
    expect(existsSync(join(result.persisted.dir, "input.json"))).toBe(true);
    expect(existsSync(join(result.persisted.dir, "result.json"))).toBe(true);
  });

  it("operationId 已存在 → 退出 2（拒绝覆盖）", () => {
    const { root } = initProject({ withProjectVersion: false });
    expect(run(["capability", "run", "unity.doctor", "--project", root, "--operation-id", "op-cli-2"]).status).toBe(2);
    const second = run(["capability", "run", "unity.doctor", "--project", root, "--operation-id", "op-cli-2", "--json"]);
    expect(second.status).toBe(2);
    expect((second.json as { error: { code: string } }).error.code).toBe("operation-exists");
    expect(second.stderr).toContain("拒绝覆盖");
  });

  it("输入非法（--set 给未知字段）→ 退出 2，不执行", () => {
    const { root } = initProject();
    const r = run([
      "capability",
      "run",
      "unity.doctor",
      "--project",
      root,
      "--set",
      "projectPath=C:/other",
      "--json",
    ]);
    expect(r.status).toBe(2);
    const result = r.json as { execution: { attempts: number; error: { code: string } } };
    expect(result.execution.error.code).toBe("input-invalid");
    expect(result.execution.attempts).toBe(0);
  });

  it("--no-persist 不创建 .vant/state；persisted.status=disabled", () => {
    const { root } = initProject({ withProjectVersion: false });
    const r = run(["capability", "run", "unity.doctor", "--project", root, "--no-persist", "--json"]);
    expect(r.status).toBe(2);
    const result = r.json as { persisted: { status: string; dir: null } };
    expect(result.persisted.status).toBe("disabled");
    expect(result.persisted.dir).toBeNull();
    expect(existsSync(join(root, ".vant", "state"))).toBe(false);
  });

  it("文本模式给出行摘要（非 JSON）", () => {
    const { root } = initProject({ withProjectVersion: false });
    const r = run(["capability", "run", "unity.doctor", "--project", root]);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("capability: unity.doctor@0.1.0");
    expect(r.stdout).toContain("execution: failed");
    expect(r.stdout).toContain("acceptance: not-run");
  });

  it("非 win32：unity provider 为 platform-mismatch → 前置条件 fail-closed（退出 2）", () => {
    if (IS_WIN) return;
    const { root } = initProject();
    const r = run(["capability", "run", "unity.doctor", "--project", root, "--json"]);
    expect(r.status).toBe(2);
    const result = r.json as { preconditions: { id: string; status: string }[] };
    expect(result.preconditions.find((p) => p.id === "unity.backend-available")?.status).toBe("violated");
  });

  it.skipIf(!IS_WIN)(
    "win32：真实调用已安装 u-cli-mod doctor（执行成功；验收按就绪判据，退出 0/1）",
    () => {
      const { root } = initProject();
      const r = run(["capability", "run", "unity.doctor", "--project", root, "--json"]);
      expect([0, 1]).toContain(r.status);
      const result = r.json as {
        execution: { status: string; exitCode: number | null };
        acceptance: { status: string; reason: string };
        output: { routeSupported: boolean; editorVersion: string; ready: boolean };
        provider: { tool: { name: string; version: string } };
        persisted: { files: string[] };
      };
      expect(result.execution.status).toBe("succeeded");
      expect(result.execution.exitCode).toBe(0);
      expect(result.provider.tool.name).toBe("unity");
      expect(result.output.routeSupported).toBe(true);
      expect(result.output.editorVersion).toBe("2022.3.62f3c1");
      expect(["passed", "failed"]).toContain(result.acceptance.status);
      if (result.acceptance.status === "passed") expect(r.status).toBe(0);
      else expect(r.status).toBe(1);
      expect(result.persisted.files).toContain("stdout.log");
      expect(existsSync(join(root, ".vant", "state", "operations"))).toBe(true);
    },
    120_000,
  );
});

describe("SDK：dist/sdk.mjs 导入与包出口", () => {
  it("SDK 导出注册表/执行内核/工程配置/操作记录", async () => {
    const sdk = await import(/* @vite-ignore */ `file://${SDK}`);
    expect(typeof sdk.createDefaultRegistry).toBe("function");
    expect(typeof sdk.runCapability).toBe("function");
    expect(typeof sdk.exitCodeForResult).toBe("function");
    expect(typeof sdk.CapabilityRegistry).toBe("function");
    expect(typeof sdk.createUnityProvider).toBe("function");
    expect(typeof sdk.loadProjectConfig).toBe("function");
    expect(typeof sdk.OperationStore).toBe("function");
    const registry = sdk.createDefaultRegistry();
    expect(registry.list()).toHaveLength(7);
    const described = registry.describe("unity.doctor");
    expect(described.provider.id).toBe("unity");
  });

  it("package.json exports/types 指向存在的 d.ts 与 mjs", () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf-8"));
    expect(pkg.exports["."]).toEqual({ types: "./dist/sdk.d.ts", import: "./dist/sdk.mjs" });
    expect(pkg.types).toBe("./dist/sdk.d.ts");
    expect(existsSync(join(PKG_ROOT, "dist", "sdk.d.ts"))).toBe(true);
    expect(existsSync(join(PKG_ROOT, "dist", "sdk.mjs"))).toBe(true);
    const dts = readFileSync(join(PKG_ROOT, "dist", "sdk.d.ts"), "utf-8");
    expect(dts).toContain("CapabilityRegistry");
    expect(dts).toContain("runCapability");
    expect(dts).toContain("CapabilityRunResult");
  });

  it("SDK 执行内核可脱离 CLI 独立运行（注入假执行器 + 不落盘）", async () => {
    const sdk = await import(/* @vite-ignore */ `file://${SDK}`);
    const calls: string[][] = [];
    const executor = {
      run: async (invocation: { args: string[] }) => {
        calls.push(invocation.args);
        return {
          exitCode: 0,
          signal: null,
          stdout:
            invocation.args[1] === "doctor"
              ? '{"routeSupported":true,"cli":{"state":"valid"},"pipeline":{"installed":true,"state":"current"},"editorVersion":"2022.3.62f3c1","editorRevision":"r","supportedVersions":["2022.3.62f3c1"],"unityProcesses":[]}'
              : "",
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
        };
      },
    };
    const registry = new sdk.CapabilityRegistry();
    registry.registerProvider(
      sdk.createUnityProvider({
        executor,
        discoverBackend: () => ({
          source: "official",
          package: "@kevlns/u-cli-mod",
          name: "unity",
          description: "",
          status: "available",
          platform: process.platform,
          version: "0.2.4",
          bin: "C:/fake/cli.js",
        }),
      }),
    );
    const { root } = initProject();
    const result = await sdk.runCapability(registry, {
      capabilityId: "unity.doctor",
      projectRoot: root,
      input: {},
      persist: false,
    });
    expect(result.execution.status).toBe("succeeded");
    expect(result.acceptance.status).toBe("passed");
    expect(sdk.exitCodeForResult(result)).toBe(0);
    expect(calls[0][1]).toBe("doctor");
  });
});

it("拒绝 --set 原型属性路径，返回机器可读请求错误", () => {
  const r = run(["capability", "run", "unity.doctor", "--set", "__proto__.polluted=true", "--json"]);
  expect(r.status).toBe(2); expect(r.stdout).toContain("set-path-invalid");
  expect(({} as any).polluted).toBeUndefined();
});
