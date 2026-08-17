import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { builtinCommands } from "../src/commands";
import { isCliCommand } from "../src/core/command";
import { VERSION } from "../src/version";

describe("内置命令契约", () => {
  it("每个内置命令符合 CliCommand 形状", () => {
    expect(builtinCommands.length).toBeGreaterThanOrEqual(3);
    for (const cmd of builtinCommands) {
      expect(isCliCommand(cmd)).toBe(true);
      expect(cmd.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(cmd.description.length).toBeGreaterThan(0);
    }
  });

  it("命令名不重复", () => {
    const names = builtinCommands.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("VERSION 与 package.json 一致", () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf-8"));
    expect(VERSION).toBe(pkg.version);
  });
});
