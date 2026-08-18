import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { builtinCommands } from "../src/commands";
import { isCliCommand, validateLocalCommand } from "../src/core/command";
import { VERSION } from "../src/version";

describe("内置命令契约", () => {
  it("每个内置命令符合 CliCommand 形状且 apiVersion 为 1", () => {
    expect(builtinCommands.length).toBeGreaterThanOrEqual(4);
    for (const cmd of builtinCommands) {
      expect(isCliCommand(cmd)).toBe(true);
      expect(cmd.apiVersion).toBe(1);
      expect(cmd.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(cmd.description.length).toBeGreaterThan(0);
    }
  });

  it("命令名不重复", () => {
    const names = builtinCommands.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("内置 agent 携带 docs/init 完整元数据（arguments/options/output/exitCodes/safety）", () => {
    const agentCmd = builtinCommands.find((c) => c.name === "agent");
    expect(agentCmd?.agent).toBeTruthy();
    const paths = agentCmd!.agent!.commands!.map((c) => c.path.join(" "));
    for (const p of ["index", "describe", "docs", "init"]) expect(paths).toContain(p);
    const docs = agentCmd!.agent!.commands!.find((c) => c.path.join(" ") === "docs")!;
    expect(docs.options?.[0]).toEqual({ flags: "--json", description: "输出 { package, version, sha256, content }" });
    expect(docs.safety).toContain("read-only");
    const init = agentCmd!.agent!.commands!.find((c) => c.path.join(" ") === "init")!;
    expect(init.arguments?.[0]?.name).toBe("directory");
    expect(init.arguments?.[0]?.required).toBe(false);
    expect(init.exitCodes?.["1"]).toContain("符号链接");
    expect(init.safety).toEqual(
      expect.arrayContaining(["refuses-existing", "fail-closed-symlink", "dry-run-supported"]),
    );
  });

  it("VERSION 与 package.json 一致", () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf-8"));
    expect(VERSION).toBe(pkg.version);
  });
});

const GOOD = {
  name: "hello",
  description: "示例",
  apiVersion: 1,
  register: () => {},
};

describe("validateLocalCommand（apiVersion 1 本地插件契约）", () => {
  it("合法对象（含 apiVersion: 1）通过", () => {
    const result = validateLocalCommand(GOOD);
    expect(result.ok).toBe(true);
    expect(result.command?.name).toBe("hello");
  });

  it("旧版插件（缺 apiVersion）给出解释性错误", () => {
    const { apiVersion, ...legacy } = GOOD;
    const result = validateLocalCommand(legacy);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join()).toContain("apiVersion 必须为 1");
      expect(result.errors.join()).toContain("旧版插件");
    }
  });

  it("apiVersion 非 1 → 拒绝", () => {
    for (const bad of [2, "1", null]) {
      const result = validateLocalCommand({ ...GOOD, apiVersion: bad });
      expect(result.ok).toBe(false);
    }
  });

  it("非对象 → 拒绝", () => {
    for (const bad of [null, "x", 42]) {
      expect(validateLocalCommand(bad).ok).toBe(false);
    }
  });

  it("命令名非法 → 拒绝", () => {
    for (const name of ["Bad", "has space", "1abc", ""]) {
      expect(validateLocalCommand({ ...GOOD, name }).ok).toBe(false);
    }
  });

  it("保留名被拒绝：内置（doctor/plugin/ts/agent/help）与官方（xlmerge/unity）", () => {
    for (const name of ["doctor", "plugin", "ts", "agent", "help", "xlmerge", "unity"]) {
      const result = validateLocalCommand({ ...GOOD, name });
      expect(result.ok, `name=${name}`).toBe(false);
    }
  });

  it("重复名（existingNames）被拒绝", () => {
    const result = validateLocalCommand(GOOD, { existingNames: ["hello"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain("重复");
  });

  it("register 非函数 → 拒绝", () => {
    expect(validateLocalCommand({ ...GOOD, register: 42 }).ok).toBe(false);
  });

  it("agent 元数据字段类型校验（可选字段出现时类型必须正确）", () => {
    expect(validateLocalCommand({ ...GOOD, agent: { whenToUse: 42 } }).ok).toBe(false);
    expect(
      validateLocalCommand({ ...GOOD, agent: { globalOptions: [{ flags: 1, description: "x" }] } }).ok,
    ).toBe(false);
    expect(
      validateLocalCommand({ ...GOOD, agent: { commands: [{ path: ["Bad"], description: "d" }] } }).ok,
    ).toBe(false);
    expect(
      validateLocalCommand({
        ...GOOD,
        agent: { whenToUse: "w", globalOptions: [{ flags: "-x", description: "d" }], commands: [{ path: ["sub"], description: "d" }] },
      }).ok,
    ).toBe(true);
  });

  it("agent.commands 出现时每项必须带非空合法 path（防止 agent describe 崩溃）", () => {
    // 缺 path（旧版遗留形状）→ 拒绝
    const missing = validateLocalCommand({ ...GOOD, agent: { commands: [{ description: "d" }] } });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors.join()).toContain("path");
    // 空数组 path → 拒绝
    const empty = validateLocalCommand({ ...GOOD, agent: { commands: [{ path: [], description: "d" }] } });
    expect(empty.ok).toBe(false);
    // 非字符串数组 path → 拒绝
    const nonString = validateLocalCommand({ ...GOOD, agent: { commands: [{ path: [1], description: "d" }] } });
    expect(nonString.ok).toBe(false);
  });

  it("agent.commands 扩展字段：arguments/options/output/exitCodes/safety 类型校验（向后兼容）", () => {
    const base = { path: ["sub"], description: "d" };
    // 合法全量元数据 → 通过
    const ok = validateLocalCommand({
      ...GOOD,
      agent: {
        commands: [
          {
            ...base,
            arguments: [{ name: "name", required: true, description: "命令名" }],
            options: [{ flags: "--json", description: "JSON" }],
            output: { format: "json", description: "结果" },
            exitCodes: { "0": "成功" },
            safety: ["read-only"],
          },
        ],
      },
    });
    expect(ok.ok).toBe(true);
    // 各字段类型错误 → 拒绝
    const bad = [
      { arguments: [{ name: 1, required: true, description: "d" }] },
      { arguments: [{ name: "n", required: "yes", description: "d" }] },
      { options: [{ flags: 1, description: "d" }] },
      { output: { format: 1, description: "d" } },
      { exitCodes: { "0": 42 } },
      { safety: "read-only" },
      { safety: [1] },
    ];
    for (const extra of bad) {
      const result = validateLocalCommand({ ...GOOD, agent: { commands: [{ ...base, ...extra }] } });
      expect(result.ok, JSON.stringify(extra)).toBe(false);
    }
  });

  it("旧版最小 commands 形状（仅 path/description）不受扩展影响，仍通过", () => {
    const result = validateLocalCommand({ ...GOOD, agent: { commands: [{ path: ["sub"], description: "d" }] } });
    expect(result.ok).toBe(true);
  });

  it("isCliCommand 是真正的 apiVersion 1 谓词（旧版插件返回 false）", () => {
    expect(isCliCommand({ name: "a", description: "b", register: () => {}, apiVersion: 1 })).toBe(true);
    expect(isCliCommand({ name: "a", description: "b", register: () => {} })).toBe(false);
    expect(isCliCommand({ name: "a", description: "b", register: () => {}, apiVersion: 2 })).toBe(false);
  });
});