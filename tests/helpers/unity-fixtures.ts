/**
 * Unity 真实协议 fixture（按 u-cli-mod 包内 AGENTS.md / v-cli.plugin.json /
 * 该仓库自带 Windows E2E harness 的读取方式构造），不含任何真实工程数据。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OfficialPluginInfo } from "../../src/core/official";

export const FAKE_BACKEND_BIN = path.join("C:", "fake", "u-cli-mod", "dist", "cli.js");

export function fakeBackend(overrides: Partial<OfficialPluginInfo> = {}): OfficialPluginInfo {
  return {
    source: "official",
    package: "@kevlns/u-cli-mod",
    name: "unity",
    description: "fake backend",
    status: "available",
    platform: process.platform,
    version: "0.2.4",
    bin: FAKE_BACKEND_BIN,
    ...overrides,
  };
}

/** doctor 输出（u-cli-mod doctor 的 JSON，非 exec 信封） */
export function doctorJson(options: {
  editorVersion?: string | null;
  routeSupported?: boolean;
  cliState?: string;
  pipelineState?: string;
  pipelineInstalled?: boolean;
  pipelinePresent?: boolean;
  supportedVersions?: string[];
  unityProcesses?: string[];
  extra?: Record<string, unknown>;
} = {}): string {
  const doc = {
    projectPath: "C:/proj",
    editorVersion: options.editorVersion === undefined ? "2022.3.62f3c1" : options.editorVersion,
    editorRevision: "1623fc0bbb97",
    routeSupported: options.routeSupported ?? true,
    routeRevision: "1623fc0bbb97",
    cli: { version: "1.0.0", path: "C:/cache/cli.exe", state: options.cliState ?? "valid" },
    pipeline: {
      version: "0.5.0-exp.1",
      patchVersion: 3,
      installedPatchVersion: 3,
      sourceReady: true,
      present: options.pipelinePresent ?? true,
      installed: options.pipelineInstalled ?? true,
      state: options.pipelineState ?? "current",
      verification: { mismatches: [], lineEndingDifferences: [], error: null },
    },
    unityProcesses: options.unityProcesses ?? [],
    supportedVersions: options.supportedVersions ?? ["2022.3.62f3c1"],
    ...(options.extra ?? {}),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** exec 的 JSON 信封：{ success, data: { success, result } } */
export function execEnvelope(
  result: unknown,
  options: { outerSuccess?: boolean; innerSuccess?: boolean; error?: string } = {},
): string {
  const outerSuccess = options.outerSuccess ?? true;
  const innerSuccess = options.innerSuccess ?? outerSuccess;
  const payload: Record<string, unknown> = { success: innerSuccess, result };
  if (options.error) payload.error = options.error;
  const data: Record<string, unknown> = outerSuccess
    ? payload
    : { success: false, error: options.error ?? "outer failure" };
  return `${JSON.stringify({ success: outerSuccess, data }, null, 2)}\n`;
}

/** 包装器让出控制权的 stderr（依据包内 AGENTS.md 的让位说明构造，非逐字复制） */
export const HANDOFF_STDERR =
  "[u-cli-mod] run_tests 仍在 Unity Editor 内继续执行：等待 30.0s 后让出控制权（未中断）。\n" +
  "[u-cli-mod] 完整输出日志：C:/proj/Library/editor-pipeline-cli/exec-logs/2026-01-01T00-00-00-000Z-run_tests.log\n";

export interface TempProject {
  root: string;
  clientDir: string;
  configFile: string;
  cleanup(): void;
}

/** 建一个带 .vant/config/v-cli.json + Client/ProjectSettings/ProjectVersion.txt 的临时工程 */
export function makeTempProject(options: {
  projectDir?: string;
  config?: unknown;
  withProjectVersion?: boolean;
  withVantProjectConfig?: unknown;
} = {}): TempProject {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vcli-cap-test-"));
  const configDir = path.join(root, ".vant", "config");
  fs.mkdirSync(configDir, { recursive: true });
  const projectDir = options.projectDir ?? "Client";
  const config = options.config ?? { schemaVersion: 1, bindings: { unity: { projectDir } } };
  fs.writeFileSync(path.join(configDir, "v-cli.json"), `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  if (options.withVantProjectConfig !== undefined) {
    fs.writeFileSync(
      path.join(configDir, "project.json"),
      `${JSON.stringify(options.withVantProjectConfig, null, 2)}\n`,
      "utf-8",
    );
  }
  const clientDir = path.join(root, projectDir === "." ? "" : projectDir);
  if (options.withProjectVersion !== false) {
    fs.mkdirSync(path.join(clientDir, "ProjectSettings"), { recursive: true });
    fs.writeFileSync(
      path.join(clientDir, "ProjectSettings", "ProjectVersion.txt"),
      "m_EditorVersion: 2022.3.62f3c1\nm_EditorVersionWithRevision: 2022.3.62f3c1 (1623fc0bbb97)\n",
      "utf-8",
    );
  }
  return {
    root,
    clientDir,
    configFile: path.join(configDir, "v-cli.json"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** 尝试建立目录链接（win32 junction / 其他平台 symlink）；失败返回 false（测试跳过） */
export function tryLinkDir(target: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}
