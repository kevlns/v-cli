/**
 * 阶段 E：Figma Provider 测试。
 *
 * 两层：
 * - FakeExecutor 单测：argv 构造、托管配置内容（无令牌字段）、输出解析全分支。
 * - win32 真实集成：用 v-cli 依赖的真实 @kevlns/figma-to-uprefab 对隔离样本
 *   （tests/fixtures/figma-contract，来自该仓库的正例 fixture）执行真实校验。
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilityRegistry } from "../src/core/execution/registry";
import { runCapability, type CapabilityRunRequest } from "../src/core/execution/runtime";
import { createFigmaProvider } from "../src/providers/figma";
import { parseContractOutput, parseDoctorOutput, parseToolError } from "../src/providers/figma/protocol";
import type { CapabilityRunResult } from "../src/core/execution/types";
import { FakeExecutor, type FakeCall, type FakeResponse } from "./helpers/fake-executor";
import { NodeProcessExecutor } from "../src/core/execution/executor";
import { fakeBackend } from "./helpers/unity-fixtures";
import { makeTempProject, type TempProject } from "./helpers/unity-fixtures";

const IS_WIN = process.platform === "win32";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

const FIGMA_CONFIG = {
  schemaVersion: 1,
  bindings: { figma: { projectDir: "Client", stagingRoot: "Client/Assets/Temp/_Staging" } },
};

function project(config: unknown = FIGMA_CONFIG): TempProject {
  const p = makeTempProject({ config, withProjectVersion: false });
  cleanups.push(p.cleanup);
  return p;
}

function fakeFigmaRegistry(handler: (call: FakeCall) => FakeResponse): { executor: FakeExecutor; registry: CapabilityRegistry } {
  const executor = new FakeExecutor(handler);
  const registry = new CapabilityRegistry();
  registry.registerProvider(createFigmaProvider({ executor, discoverBackend: () => fakeBackend() }));
  return { executor, registry };
}

function run(
  registry: CapabilityRegistry,
  p: TempProject,
  capabilityId: string,
  input: Record<string, unknown> = {},
  extra: Partial<CapabilityRunRequest> = {},
): Promise<CapabilityRunResult> {
  return runCapability(registry, {
    capabilityId,
    projectRoot: p.root,
    input,
    persist: false,
    ...extra,
  });
}

/** 插件真实输出形态（阶段 A 实测样本） */
const contractValid = (n: number) => `[figma-to-uprefab] Contract valid: ${n} root(s).\n`;
const contractIssue = (code: string, message: string, at?: string) =>
  `[figma-to-uprefab] contract: ${code}${at ? ` @ ${at}` : ""}: ${message}\n`;

describe("protocol 解析（真实输出形态）", () => {
  it("contract：valid 行 / issue 行 / 忽略无关行", () => {
    // 分流（真实形态）：valid 行走 stdout，issue 行走 stderr
    const parsed = parseContractOutput(
      contractValid(2) + "noise line",
      contractIssue("CON_INDEX_JSON", "bad json", "Assets/Temp/_Staging/figma-roots.index.json"),
    );
    expect(parsed.validRoots).toBe(2);
    expect(parsed.issues).toEqual([{ code: "CON_INDEX_JSON", message: "bad json", path: "Assets/Temp/_Staging/figma-roots.index.json" }]);
    expect(parsed.unrecognized).toBe(1);
  });

  it("doctor：[ok]/[FAIL] 行", () => {
    const parsed = parseDoctorOutput("[figma-to-uprefab] [ok]   config: fine\n[figma-to-uprefab] [FAIL] token: No Figma token\n");
    expect(parsed.checks).toEqual([
      { name: "config", ok: true, message: "fine" },
      { name: "token", ok: false, message: "No Figma token" },
    ]);
  });

  it("stderr 工具码：CFG_* 提取", () => {
    expect(parseToolError("[figma-to-uprefab] CFG_USER_FILE_MISSING: User config file was not found: x\n")).toEqual({
      code: "CFG_USER_FILE_MISSING",
      message: "User config file was not found: x",
    });
    expect(parseToolError("no code here")).toBeNull();
  });
});

describe("figma provider（FakeExecutor）：argv / 托管配置 / 分支", () => {
  it("contract argv：--project/--config 受控；托管配置写入 .vant/state 且无令牌字段；staging 相对 Unity 工程", async () => {
    const p = project();
    let managedConfigArg: string | undefined;
    const { executor, registry } = fakeFigmaRegistry((call) => {
      managedConfigArg = call.env?.FIGMA_TO_UPREFAB_CONFIG;
      void call;
      return { exitCode: 0, stdout: contractValid(1) };
    });
    const result = await run(registry, p, "figma.contract");
    expect(result.execution.status).toBe("succeeded");
    expect(result.acceptance.status).toBe("passed");
    expect(result.output).toMatchObject({ validRoots: 1, issueCount: 0, issueCodes: [], allowMissingIr: false });

    const argv = executor.calls[0]!.args.slice(1);
    expect(argv[0]).toBe("contract");
    expect(argv).toContain("--project");
    expect(argv[argv.indexOf("--project") + 1]).toBe(p.clientDir);
    expect(argv).toContain("--config");
    expect(argv[argv.indexOf("--config") + 1]).toContain(path.join(".vant", "state", "figma", "user-config.json"));
    expect(managedConfigArg).toBeTruthy();

    const managed = JSON.parse(fs.readFileSync(managedConfigArg!, "utf-8")) as {
      schemaVersion: number;
      projects: Record<string, { uiSystem: string; staging: { root: string }; figmaAccessToken?: unknown }>;
    };
    const key = Object.keys(managed.projects)[0]!;
    const expectedKey = path.resolve(p.clientDir).split(path.sep).join("/");
    expect(key).toBe(process.platform === "win32" ? expectedKey.toLowerCase() : expectedKey);
    expect(managed.projects[key]!.uiSystem).toBe("UGUI");
    expect(managed.projects[key]!.staging.root).toBe("Assets/Temp/_Staging");
    expect(managed.projects[key]!.figmaAccessToken).toBeUndefined();
  });

  it("allowMissingIr 绑定 → --allow-missing-ir 转发", async () => {
    const p = project({
      schemaVersion: 1,
      bindings: { figma: { projectDir: "Client", stagingRoot: "Client/Assets/Temp/_Staging", allowMissingIr: true } },
    });
    const { executor, registry } = fakeFigmaRegistry(() => ({ exitCode: 0, stdout: contractValid(1) }));
    const result = await run(registry, p, "figma.contract");
    expect(result.acceptance.status).toBe("passed");
    expect(executor.calls[0]!.args.slice(1)).toContain("--allow-missing-ir");
    expect(result.output).toMatchObject({ allowMissingIr: true });
  });

  it("valid roots=0 → failed（空 staging 无可验收内容）", async () => {
    const p = project();
    const { executor, registry } = fakeFigmaRegistry(() => ({ exitCode: 0, stdout: contractValid(0) }));
    const result = await run(registry, p, "figma.contract");
    expect(result.execution.status).toBe("succeeded");
    expect(result.acceptance.status).toBe("failed");
    expect(result.acceptance.reason).toContain("roots=0");
  });

  it("exit 1 + issues → acceptance failed，码入 output 与证据", async () => {
    const p = project();
    const { executor, registry } = fakeFigmaRegistry(() => ({
      exitCode: 1,
      stdout: "",
      stderr: contractIssue("CON_INDEX_MISSING", "Root index does not exist: Assets/Temp/_Staging/figma-roots.index.json"),
    }));
    const result = await run(registry, p, "figma.contract");
    expect(result.execution.status).toBe("succeeded");
    expect(result.acceptance.status).toBe("failed");
    expect(result.output).toMatchObject({ validRoots: null, issueCount: 1, issueCodes: ["CON_INDEX_MISSING"] });
    expect(result.acceptance.evidence.some((e) => e.description.includes("CON_INDEX_MISSING"))).toBe(true);
  });

  it("exit 1 + stderr CFG_* → 调用环境问题（config 类失败，无 staging 结论）", async () => {
    const p = project();
    const { executor, registry } = fakeFigmaRegistry(() => ({
      exitCode: 1,
      stdout: "",
      stderr: "[figma-to-uprefab] CFG_USER_FILE_MISSING: User config file was not found\n",
    }));
    const result = await run(registry, p, "figma.contract");
    expect(result.execution.status).toBe("failed");
    expect(result.execution.error?.code).toBe("figma-cfg_user_file_missing");
    expect(result.acceptance.status).toBe("not-run");
  });

  it("输出不可解释（exit 0 无 valid 行）→ unknown 协议失败", async () => {
    const p = project();
    const { executor, registry } = fakeFigmaRegistry(() => ({ exitCode: 0, stdout: "something else\n" }));
    const result = await run(registry, p, "figma.contract");
    expect(result.execution.status).toBe("unknown");
    expect(result.execution.error?.code).toBe("figma-output-uninterpretable");
    expect(result.acceptance.status).toBe("not-run");
  });

  it("doctor：全 ok → passed；有 FAIL → failed 且逐项入 output（token FAIL 如实报告）", async () => {
    const p = project();
    {
      const { executor, registry } = fakeFigmaRegistry(() => ({
        exitCode: 0,
        stdout: "[figma-to-uprefab] [ok]   config: fine\n[figma-to-uprefab] [ok]   staging: exists\n",
      }));
      const result = await run(registry, p, "figma.doctor");
      expect(result.acceptance.status).toBe("passed");
      expect(result.output).toMatchObject({ allOk: true });
      expect((result.output as { checks: unknown[] }).checks).toHaveLength(2);
    }
    {
      const { executor, registry } = fakeFigmaRegistry(() => ({
        exitCode: 1,
        stdout:
          "[figma-to-uprefab] [FAIL] token: No Figma token\n[figma-to-uprefab] [ok]   config: fine\n[figma-to-uprefab] [FAIL] editor: Editor not found\n",
      }));
      const result = await run(registry, p, "figma.doctor");
      expect(result.execution.status).toBe("succeeded");
      expect(result.acceptance.status).toBe("failed");
      const output = result.output as { allOk: boolean; checks: { name: string; ok: boolean }[] };
      expect(output.allOk).toBe(false);
      expect(output.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["token", "editor"]);
    }
  });

  it("缺少绑定 → 前置条件 violated（figma.project-binding），零后端调用", async () => {
    const p = project({ schemaVersion: 1, bindings: {} });
    const { executor, registry } = fakeFigmaRegistry(() => ({ exitCode: 0, stdout: contractValid(1) }));
    const result = await run(registry, p, "figma.contract");
    expect(executor.calls).toHaveLength(0);
    expect(result.preconditions.find((x) => x.id === "figma.project-binding")?.status).toBe("violated");
    expect(result.execution.error?.category).toBe("precondition");
  });

  it("绑定越界（stagingRoot 出工程）→ 配置层 unsafe-binding（核心强核对）", async () => {
    const p = project({ schemaVersion: 1, bindings: { figma: { projectDir: "Client", stagingRoot: "../outside" } } });
    const { executor, registry } = fakeFigmaRegistry(() => ({ exitCode: 0, stdout: contractValid(1) }));
    await expect(run(registry, p, "figma.contract")).rejects.toThrow();
    expect(executor.calls).toHaveLength(0);
  });
});

describe("win32 真实插件集成（隔离样本，无网络）", () => {
  function stagingProject(): TempProject {
    const p = project();
    const staging = path.join(p.clientDir, "Assets", "Temp", "_Staging");
    fs.mkdirSync(staging, { recursive: true });
    fs.cpSync(path.join(__dirname, "fixtures", "figma-contract"), staging, { recursive: true });
    return p;
  }

  (IS_WIN ? it : it.skip)("真实正例：fixture staging 通过真实插件校验（roots=1 passed）", async () => {
    const p = stagingProject();
    const registry = new CapabilityRegistry();
    registry.registerProvider(createFigmaProvider({ executor: new NodeProcessExecutor() }));
    const result = await run(registry, p, "figma.contract");
    expect(result.execution.status).toBe("succeeded");
    expect(result.acceptance.status).toBe("passed");
    expect(result.output).toMatchObject({ validRoots: 1, issueCount: 0, issueCodes: [] });
    expect(result.provider.tool?.name).toBe("figma");
  });

  (IS_WIN ? it : it.skip)("真实反例：index 非法 JSON → failed 且 CON_INDEX_JSON 入 output", async () => {
    const p = stagingProject();
    fs.writeFileSync(path.join(p.clientDir, "Assets", "Temp", "_Staging", "figma-roots.index.json"), "not json", "utf-8");
    expect(fs.existsSync(path.join(p.clientDir, "Assets", "Temp", "_Staging", "figma-roots.index.json"))).toBe(true);
    const registry = new CapabilityRegistry();
    registry.registerProvider(createFigmaProvider({ executor: new NodeProcessExecutor() }));
    const result = await run(registry, p, "figma.contract");
    expect(result.execution.status).toBe("succeeded");
    expect(result.acceptance.status).toBe("failed");
    expect(result.output).toMatchObject({ issueCodes: ["CON_INDEX_JSON"] });
  });

  (IS_WIN ? it : it.skip)("真实反例：staging 目录不存在 → CON_INDEX_MISSING failed", async () => {
    const p = project(); // 未拷 fixture：staging 目录不存在（fixture 不创建它）
    const registry = new CapabilityRegistry();
    registry.registerProvider(createFigmaProvider({ executor: new NodeProcessExecutor() }));
    const result = await run(registry, p, "figma.contract");
    expect(result.acceptance.status).toBe("failed");
    expect(result.output).toMatchObject({ issueCodes: ["CON_INDEX_MISSING"] });
  });
});

describe("阶段 E 一审修复回归", () => {
  it("P2-2：stagingRoot 绑到 projectDir 外 → 绑定期拒绝（不进运行）", async () => {
    const p = project({
      schemaVersion: 1,
      bindings: { figma: { projectDir: "Client", stagingRoot: "Elsewhere/Staging" } },
    });
    fs.mkdirSync(path.join(p.root, "Elsewhere", "Staging"), { recursive: true });
    const { executor, registry } = fakeFigmaRegistry(() => ({ exitCode: 0, stdout: contractValid(1) }));
    await expect(run(registry, p, "figma.contract")).rejects.toThrow(/stagingRoot 必须位于/);
    expect(executor.calls).toHaveLength(0);
  });

  it("P2-1：doctor CFG-only（stderr 仅工具码、无检查行）→ config 类 not-run", async () => {
    const p = project();
    const { registry } = fakeFigmaRegistry(() => ({
      exitCode: 1,
      stdout: "",
      stderr: "[figma-to-uprefab] CFG_USER_FILE_MISSING: User config file was not found\n",
    }));
    const result = await run(registry, p, "figma.doctor");
    expect(result.execution.error?.code).toBe("figma-cfg_user_file_missing");
    expect(result.acceptance.status).toBe("not-run");
  });

  it("P2-1：abort/超时 → unknown/not-run（不冒充失败或取消）", async () => {
    const p = project();
    {
      const { registry } = fakeFigmaRegistry(() => ({ exitCode: null, aborted: true, killConfirmed: false, stdout: "", stderr: "" }));
      const result = await run(registry, p, "figma.contract");
      expect(result.execution.status).toBe("unknown");
      expect(result.acceptance.status).toBe("not-run");
    }
    {
      const { registry } = fakeFigmaRegistry(() => ({ exitCode: null, timedOut: true, stdout: "", stderr: "" }));
      const result = await run(registry, p, "figma.doctor");
      expect(result.execution.status).toBe("unknown");
    }
  });

  it("P3-1：issue 消息内嵌换行的续行并入上一条 issue（消息完整）", () => {
    const parsed = parseContractOutput("", contractIssue("CON_INDEX_JSON", "SyntaxError: Unexpected token 'o', \"not json") + '[figma-to-uprefab] " is not valid JSON\n');
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]!.message).toContain("not valid JSON");
    expect(parsed.unrecognized).toBe(0);
  });

  (IS_WIN ? it : it.skip)("P2-1 真实 doctor：token/editor FAIL 如实列示且 reason 附言与事实一致", async () => {
    const p = project();
    fs.mkdirSync(path.join(p.clientDir, "Assets", "Temp", "_Staging"), { recursive: true });
    fs.cpSync(path.join(__dirname, "fixtures", "figma-contract"), path.join(p.clientDir, "Assets", "Temp", "_Staging"), { recursive: true });
    const registry = new CapabilityRegistry();
    registry.registerProvider(createFigmaProvider({ executor: new NodeProcessExecutor() }));
    const result = await run(registry, p, "figma.doctor");
    expect(result.execution.status).toBe("succeeded");
    expect(result.acceptance.status).toBe("failed");
    // 失败项全部属于离线预期集合 → 附言出现；任一意外失败项 → 附言消失
    const output = result.output as { checks: { name: string; ok: boolean }[] };
    const failedNames = output.checks.filter((c) => !c.ok).map((c) => c.name);
    const offlineExpected = new Set(["token", "editor", "unity-package"]);
    const hasUnexpected = failedNames.some((n) => !offlineExpected.has(n));
    expect(hasUnexpected).toBe(false);
    expect(result.acceptance.reason).toContain("离线环境为预期 FAIL");
  }, 30_000);
});
