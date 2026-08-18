import { describe, expect, it } from "vitest";
import { buildAgentIndex, type AgentIndexRow } from "../src/commands/agent";
import type { CliCommand } from "../src/core/command";
import type { LoadedCommand } from "../src/core/loader";
import type { OfficialPluginInfo } from "../src/core/official";

const builtinWithAgent: CliCommand = {
  name: "hello",
  description: "带 agent 元数据的内置",
  apiVersion: 1,
  agent: {
    whenToUse: "当用户说你好时",
    globalOptions: [{ flags: "--loud", description: "大声" }],
    commands: [{ path: ["sub"], description: "子命令", usage: "hello sub" }],
  },
  register: () => {},
};

const builtinMinimal: CliCommand = {
  name: "plain",
  description: "最小内置",
  apiVersion: 1,
  register: () => {},
};

function local(cmd: CliCommand, file = "x.mjs"): LoadedCommand {
  return { command: cmd, source: "local", file };
}

function official(info: Partial<OfficialPluginInfo>): OfficialPluginInfo {
  return {
    source: "official",
    package: "@kevlns/xlmerge",
    name: "xlmerge",
    description: "官方",
    status: "available",
    platform: "win32",
    ...info,
  };
}

describe("buildAgentIndex（纯函数）", () => {
  it("builtin：有 agent 元数据为 full，无则为 minimal", () => {
    const rows = buildAgentIndex([builtinWithAgent, builtinMinimal], [], []);
    expect(rows).toHaveLength(2);
    const full = rows.find((r) => r.name === "hello")!;
    expect(full.type).toBe("builtin");
    expect(full.metadataStatus).toBe("full");
    expect(full.whenToUse).toBe("当用户说你好时");
    expect(full.commands?.[0].path).toEqual(["sub"]);
    const minimal = rows.find((r) => r.name === "plain")!;
    expect(minimal.metadataStatus).toBe("minimal");
  });

  it("local：agent 元数据透传；加载失败项带 error", () => {
    const rows = buildAgentIndex(
      [],
      [
        local({ ...builtinWithAgent, name: "plug", description: "本地" }, "plug.mjs"),
        { source: "local", file: "bad.mjs", error: "apiVersion 必须为 1" },
      ],
      [],
    );
    const plug = rows.find((r) => r.name === "plug")!;
    expect(plug.type).toBe("local");
    expect(plug.metadataStatus).toBe("full");
    const bad = rows.find((r) => r.error) as AgentIndexRow;
    expect(bad.metadataStatus).toBe("minimal");
    expect(bad.error).toContain("apiVersion");
  });

  it("official：available 为 full（manifest 全量元数据），missing 为 minimal 且带 globalOptions/requiredPlatforms", () => {
    const rows = buildAgentIndex([], [], [
      official({
        status: "available",
        whenToUse: "when",
        globalOptions: [{ flags: "--repo <path>", description: "repo" }],
        commands: [
          {
            path: ["detect"],
            usage: "v-cli xlmerge detect",
            description: "d",
            arguments: [],
            options: [],
            output: { format: "json", description: "o" },
            exitCodes: { "0": "success" },
            safety: ["read-only"],
          },
        ],
        runtime: { node: ">=16" },
        environment: [{ name: "X", description: "d" }],
        requiredPlatforms: ["darwin", "linux", "win32"],
        version: "1.2.1-beta.2",
      }),
      official({
        package: "@kevlns/u-cli-mod",
        name: "unity",
        status: "missing",
        error: "未找到官方插件包 @kevlns/u-cli-mod（未安装或不在可解析路径）",
      }),
    ]);
    const xl = rows.find((r) => r.name === "xlmerge")!;
    expect(xl.metadataStatus).toBe("full");
    expect(xl.version).toBe("1.2.1-beta.2");
    expect(xl.commands?.[0].path).toEqual(["detect"]);
    expect(xl.globalOptions?.[0].flags).toBe("--repo <path>");
    const unity = rows.find((r) => r.name === "unity")!;
    expect(unity.metadataStatus).toBe("minimal");
    expect(unity.status).toBe("missing");
    expect(unity.error).toContain("@kevlns/u-cli-mod");
  });

  it("official：available 时全量命令元数据透传（arguments/options/output/exitCodes/safety）", () => {
    const rows = buildAgentIndex([], [], [
      official({
        status: "available",
        commands: [
          {
            path: ["apply"],
            usage: "v-cli xlmerge apply",
            description: "写回决策",
            arguments: [{ name: "file", required: true, description: "文件" }],
            options: [{ flags: "--manifest <file>", description: "manifest" }],
            output: { format: "json", description: "结果对象" },
            exitCodes: { "0": "success", "1": "error" },
            safety: ["writes-worktree", "commits-by-default"],
          },
        ],
      }),
    ]);
    const cmd = rows[0].commands?.[0]!;
    expect(cmd.path).toEqual(["apply"]);
    expect(cmd.usage).toBe("v-cli xlmerge apply");
    expect(cmd.arguments?.[0]).toEqual({ name: "file", required: true, description: "文件" });
    expect(cmd.options?.[0].flags).toBe("--manifest <file>");
    expect(cmd.output).toEqual({ format: "json", description: "结果对象" });
    expect(cmd.exitCodes).toEqual({ "0": "success", "1": "error" });
    expect(cmd.safety).toEqual(["writes-worktree", "commits-by-default"]);
  });

  it("三类命令都在同一数组中、行字段稳定（name/type/description 恒有）", () => {
    const rows = buildAgentIndex(
      [builtinMinimal],
      [local(builtinWithAgent, "a.mjs")],
      [official({ name: "unity", package: "@kevlns/u-cli-mod", status: "missing" })],
    );
    expect(rows.map((r) => r.name)).toEqual(["plain", "hello", "unity"]);
    for (const r of rows) {
      expect(typeof r.name).toBe("string");
      expect(["builtin", "local", "official"]).toContain(r.type);
      expect(typeof r.description).toBe("string");
      expect(["full", "minimal"]).toContain(r.metadataStatus);
    }
  });
});