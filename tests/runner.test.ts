import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolve } from "node:path";
import { mapExitCode, runPluginBin } from "../src/core/runner";
import { VERSION } from "../src/version";

const ECHO_BIN = resolve(__dirname, "fixtures", "bins", "echo-argv.mjs");

const dirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v-cli-runner-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function runEcho(argv: string[], extraEnv: Record<string, string> = {}) {
  const outFile = path.join(tmpDir(), "out.json");
  const result = await runPluginBin({
    bin: ECHO_BIN,
    argv,
    env: { V_CLI_TEST_OUTPUT_FILE: outFile, ...extraEnv },
  });
  const payload = JSON.parse(fs.readFileSync(outFile, "utf-8"));
  return { result, payload };
}

describe("runPluginBin（异步子进程运行器）", () => {
  it("argv 原样转发（含 --json、--、--help）", async () => {
    const { payload } = await runEcho(["detect", "--json", "--", "--help", "-x"]);
    expect(payload.argv).toEqual(["detect", "--json", "--", "--help", "-x"]);
  });

  it("注入 V_CLI_HOST_VERSION / V_CLI_PLUGIN_API / V_CLI_INVOKED_BY", async () => {
    const { payload } = await runEcho(["detect"]);
    expect(payload.env).toEqual({
      V_CLI_HOST_VERSION: VERSION,
      V_CLI_PLUGIN_API: "1",
      V_CLI_INVOKED_BY: "v-cli",
    });
    expect(VERSION).toBe("0.2.8");
  });

  it("显式 env 覆盖注入值（overlay 语义）", async () => {
    const { payload } = await runEcho(["detect"], { V_CLI_HOST_VERSION: "custom" });
    expect(payload.env.V_CLI_HOST_VERSION).toBe("custom");
  });

  it("子进程退出码原样传播（42）", async () => {
    const { result, payload } = await runEcho(["--exit-42"]);
    expect(payload.argv).toEqual(["--exit-42"]);
    expect(result).toEqual({ code: 42, signal: null });
    expect(mapExitCode(result)).toBe(42);
  });

  it("mapExitCode：信号杀死时 POSIX 128+signum，Windows 保守 1", () => {
    const killed: { code: null; signal: NodeJS.Signals } = { code: null, signal: "SIGTERM" };
    if (process.platform === "win32") {
      expect(mapExitCode(killed)).toBe(1);
    } else {
      expect(mapExitCode(killed)).toBe(143);
    }
    expect(mapExitCode({ code: null, signal: null })).toBe(1);
    expect(mapExitCode({ code: 0, signal: null })).toBe(0);
  });
});