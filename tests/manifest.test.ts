import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { validateManifest, validatePluginIdentity } from "../src/core/manifest";
import type { PluginManifest } from "../src/core/manifest";

/** 测试夹具：把未知的 agent 段收窄为可写对象（仅修改 fixture，不弱化断言） */
function agentOf(m: Record<string, unknown>): {
  commands: Array<Record<string, unknown>>;
  globalOptions: Array<Record<string, unknown>>;
} {
  return m.agent as {
    commands: Array<Record<string, unknown>>;
    globalOptions: Array<Record<string, unknown>>;
  };
}

function validManifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    package: "@kevlns/sample",
    command: "sample",
    bin: "sample-bin",
    description: "示例插件",
    platforms: ["darwin", "linux", "win32"],
    runtime: { node: ">=20" },
    environment: [{ name: "SAMPLE_HOME", description: "示例目录" }],
    agent: {
      whenToUse: "示例场景",
      globalOptions: [{ flags: "--repo <path>", description: "仓库路径" }],
      commands: [
        {
          path: ["detect"],
          usage: "sample detect",
          description: "检测",
          arguments: [],
          options: [],
          output: { format: "json", description: "输出" },
          exitCodes: { 0: "success" },
          safety: ["read-only"],
        },
      ],
    },
  };
}

describe("validateManifest", () => {
  it("合法清单通过，且返回规范化的 PluginManifest", () => {
    const result = validateManifest(validManifest());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.schemaVersion).toBe(1);
      expect(result.manifest.agent.commands[0].path).toEqual(["detect"]);
    }
  });

  it("非对象（字符串/数组/null）被拒绝", () => {
    for (const bad of ["{}", 42, null, [], true]) {
      const result = validateManifest(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join()).toContain("对象");
    }
  });

  it("schemaVersion 非整数 / 0 / 1.5 被拒绝", () => {
    for (const v of ["1", 0, 1.5, null]) {
      const m = validManifest();
      m.schemaVersion = v;
      expect(validateManifest(m).ok).toBe(false);
    }
  });

  it("schemaVersion >= 2 给出解释性错误", () => {
    const m = validManifest();
    m.schemaVersion = 2;
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join()).toMatch(/不受支持|升级/);
    }
  });

  it("缺少必需字段被拒绝", () => {
    for (const key of ["package", "command", "bin", "description", "platforms", "runtime", "environment", "agent"]) {
      const m = validManifest();
      delete m[key];
      expect(validateManifest(m).ok).toBe(false);
    }
  });

  it("字段类型错误被拒绝（非字符串标志）", () => {
    const m = validManifest();
    m.description = 123;
    expect(validateManifest(m).ok).toBe(false);

    const m2 = validManifest();
    agentOf(m2).globalOptions = [{ flags: 42, description: "x" }];
    expect(validateManifest(m2).ok).toBe(false);

    const m3 = validManifest();
    agentOf(m3).commands = [
      {
        path: ["ok"],
        usage: "u",
        description: "d",
        arguments: [],
        options: [{ flags: 42, description: "d" }],
        output: { format: "json", description: "d" },
        exitCodes: {},
        safety: [],
      },
    ];
    expect(validateManifest(m3).ok).toBe(false);
  });

  it("非法命令名被拒绝", () => {
    const m = validManifest();
    m.command = "Bad_Name";
    expect(validateManifest(m).ok).toBe(false);
  });

  it("保留命令名（内置）被拒绝", () => {
    for (const name of ["doctor", "plugin", "ts", "agent", "help"]) {
      const m = validManifest();
      m.command = name;
      const result = validateManifest(m);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join()).toContain("保留");
    }
  });

  it("重复的 agent.commands[].path 被拒绝", () => {
    const m = validManifest();
    const agent = m.agent as { commands: Array<Record<string, unknown>> };
    const cmd = agent.commands[0];
    agent.commands = [cmd, { ...cmd, path: ["detect"] }];
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain("重复");
  });

  it("agent.commands[].path 每段须匹配命令名正则", () => {
    const m = validManifest();
    (m.agent as { commands: Array<Record<string, unknown>> }).commands[0].path = ["Bad_Seg"];
    expect(validateManifest(m).ok).toBe(false);
  });

  it("package 必须是 @scope/name 形式", () => {
    const m = validManifest();
    m.package = "not-scoped";
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain("@scope/name");
  });

  it("platforms 必须是已知平台子集", () => {
    const m = validManifest();
    m.platforms = ["windows"];
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain("win32");
  });

  it("output.format 必须属于枚举 [json/stdout/text]（与 schema 对齐）", () => {
    const m1 = validManifest();
    (agentOf(m1).commands[0].output as Record<string, unknown>).format = "plain";
    expect(validateManifest(m1).ok).toBe(false);
    const m2 = validManifest();
    (agentOf(m2).commands[0].output as Record<string, unknown>).format = "stdout";
    expect(validateManifest(m2).ok).toBe(true);
    const m3 = validManifest();
    (agentOf(m3).commands[0].output as Record<string, unknown>).format = "text";
    expect(validateManifest(m3).ok).toBe(true);
    const m4 = validManifest();
    (agentOf(m4).commands[0].output as Record<string, unknown>).format = "";
    expect(validateManifest(m4).ok).toBe(false);
  });

  it("exitCodes 的值必须是字符串", () => {
    const m = validManifest();
    (m.agent as { commands: Array<Record<string, unknown>> }).commands[0].exitCodes = { "0": 1 };
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain("exitCodes");
  });

  it("空 description/usage/flags 被拒绝（schema minLength 1 对齐）", () => {
    const withEmpty = (mutate: (m: Record<string, unknown>) => void) => {
      const m = validManifest();
      mutate(m);
      expect(validateManifest(m).ok).toBe(false);
    };
    withEmpty((m) => {
      agentOf(m).commands[0].usage = "";
    });
    withEmpty((m) => {
      agentOf(m).commands[0].description = "";
    });
    withEmpty((m) => {
      agentOf(m).commands[0].options = [{ flags: "--x", description: "" }];
    });
    withEmpty((m) => {
      agentOf(m).commands[0].arguments = [{ name: "a", required: true, description: "" }];
    });
    withEmpty((m) => {
      agentOf(m).commands[0].output = { format: "json", description: "" };
    });
    withEmpty((m) => {
      (m.environment as Array<Record<string, unknown>>)[0].description = "";
    });
    withEmpty((m) => {
      agentOf(m).globalOptions[0].description = "";
    });
  });
});

describe("validatePluginIdentity（发现期身份校验，独立于 schema）", () => {
  const manifest = (): PluginManifest => {
    const result = validateManifest(validManifest());
    if (!result.ok) throw new Error("fixture 清单应当合法");
    return result.manifest;
  };

  it("package 与 package.json name 不一致 → 报错", () => {
    const errors = validatePluginIdentity(manifest(), {
      name: "@kevlns/other",
      bin: { "sample-bin": "bin.js" },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("不一致");
  });

  it("bin 不在 package.json bin 键中 → 报错", () => {
    const errors = validatePluginIdentity(manifest(), {
      name: "@kevlns/sample",
      bin: { "other-bin": "bin.js" },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("bin");
  });

  it("package 与 bin 均一致 → 通过", () => {
    const errors = validatePluginIdentity(manifest(), {
      name: "@kevlns/sample",
      bin: { "sample-bin": "bin.js" },
    });
    expect(errors).toEqual([]);
  });
});

/**
 * 条件测试：本地开发仓库存在真实 sibling 清单时，必须通过完整校验
 * （xlmerge / u-cli-mod 是官方插件白名单的最终清单来源）。
 */
describe("真实 sibling 清单（条件：../xlmerge 与 ../u-cli-mod 存在）", () => {
  const siblings = [
    { name: "xlmerge", manifest: "../xlmerge/v-cli.plugin.json", pkg: "../xlmerge/package.json" },
    { name: "u-cli-mod", manifest: "../u-cli-mod/v-cli.plugin.json", pkg: "../u-cli-mod/package.json" },
  ];

  const present = siblings.filter((s) => {
    const m = path.join(__dirname, "..", s.manifest);
    const p = path.join(__dirname, "..", s.pkg);
    return fs.existsSync(m) && fs.existsSync(p);
  });

  it.skipIf(present.length === 0)("sibling 清单全部通过 schema + 身份校验", () => {
    for (const s of siblings) {
      const mPath = path.join(__dirname, "..", s.manifest);
      const pPath = path.join(__dirname, "..", s.pkg);
      const raw = JSON.parse(fs.readFileSync(mPath, "utf-8"));
      const validated = validateManifest(raw);
      expect(validated.ok, `${s.manifest} 校验失败`).toBe(true);
      if (validated.ok) {
        const pkgJson = JSON.parse(fs.readFileSync(pPath, "utf-8"));
        expect(validatePluginIdentity(validated.manifest, pkgJson), `${s.manifest} 身份校验失败`).toEqual([]);
      }
    }
  });
});