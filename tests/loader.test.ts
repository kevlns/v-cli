import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/core/config";
import { Logger } from "../src/core/logger";
import { loadAllCommands, loadLocalPlugins } from "../src/core/loader";
import { isCliCommand } from "../src/core/command";
import type { CliContext } from "../src/core/context";

const dirs: string[] = [];
function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "vcli-loader-"));
  dirs.push(dir);
  return dir;
}

function fakeCtx(homeDir: string): CliContext {
  return { log: new Logger(false), config: ConfigStore.fromHome(homeDir), json: false, homeDir };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// 说明：本地插件的动态 import 在 vitest 的 vite-node 运行时中会被拦截，
// 真实加载路径由 cli.integration.test.ts 在子进程中验证。
describe("loader", () => {
  it("commands 目录不存在时返回空数组", async () => {
    const loaded = await loadLocalPlugins(fakeCtx(tmpHome()));
    expect(loaded).toEqual([]);
  });

  it("loadAllCommands 在无本地插件时返回全部内置命令", async () => {
    const all = await loadAllCommands(fakeCtx(tmpHome()));
    expect(all.every((l) => l.source === "builtin")).toBe(true);
    expect(all.length).toBeGreaterThanOrEqual(3);
  });

  it("isCliCommand 形状校验", () => {
    expect(isCliCommand({ name: "a", description: "b", register: () => {} })).toBe(true);
    expect(isCliCommand({ name: 1, description: "b", register: () => {} })).toBe(false);
    expect(isCliCommand(null)).toBe(false);
  });
});
