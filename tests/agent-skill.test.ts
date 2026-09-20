import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolve } from "node:path";
import {
  collectAgentSkillDirs,
  copySkillDir,
  performAgentSkillAssembly,
  readSkillSource,
  resolveSkillSourceRoot,
  SKILL_NAME,
  SKILL_FILE,
} from "../src/core/agent-skill";
import { AGENT_SKILL_DIRS } from "../src/core/agent-dirs";
import { sha256Hex } from "../src/core/agent-docs";

const REPO_ROOT = resolve(__dirname, "..");
const REAL_SKILL = resolve(REPO_ROOT, "skills", SKILL_NAME, SKILL_FILE);
const REAL_SKILL_CONTENT = fs.readFileSync(REAL_SKILL, "utf-8");

const dirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v-cli-skill-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** 构造一个结构完整的包：dist + AGENTS.md + skills/v-cli/SKILL.md + package.json */
function fakePackage(skillContent = "---\nname: v-cli\n---\n# norms\n"): {
  root: string;
  base: string;
} {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.mkdirSync(path.join(root, "skills", SKILL_NAME), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "docs\n", "utf-8");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "@kevlns/v-cli", version: "0.0.0-test" }),
    "utf-8",
  );
  fs.writeFileSync(path.join(root, "skills", SKILL_NAME, SKILL_FILE), skillContent, "utf-8");
  return { root, base: path.join(root, "dist", "cli.mjs") };
}

describe("skill 源解析（base 注入，无全局路径假设）", () => {
  it("dist 布局：base 指向 <pkg>/dist/cli.mjs → 解析到 <pkg>/skills/v-cli", () => {
    const { root, base } = fakePackage();
    expect(resolveSkillSourceRoot({ base })).toBe(path.join(root, "skills", SKILL_NAME));
  });

  it("readSkillSource：返回 root/file/content/sha256/bytes 且与源一致", () => {
    const content = "---\nname: v-cli\n---\nbody\n";
    const { root, base } = fakePackage(content);
    const src = readSkillSource({ base });
    expect(src.root).toBe(path.join(root, "skills", SKILL_NAME));
    expect(src.file).toBe(path.join(root, "skills", SKILL_NAME, SKILL_FILE));
    expect(src.content).toBe(content);
    expect(src.sha256).toBe(sha256Hex(content));
    expect(src.bytes).toBe(Buffer.byteLength(content, "utf-8"));
  });

  it("源缺失：skills/v-cli 不存在 → resolveSkillSourceRoot undefined，readSkillSource 抛清晰错误", () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "AGENTS.md"), "docs\n", "utf-8");
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "@kevlns/v-cli" }),
      "utf-8",
    );
    const base = path.join(root, "dist", "cli.mjs");
    expect(resolveSkillSourceRoot({ base })).toBeUndefined();
    expect(() => readSkillSource({ base })).toThrow(/skills\/v-cli/);
  });

  it("真实仓库 skill 源存在且可读（随包分发契约）", () => {
    expect(fs.existsSync(REAL_SKILL)).toBe(true);
    const src = readSkillSource();
    expect(src.content).toBe(REAL_SKILL_CONTENT);
    expect(src.sha256).toBe(sha256Hex(REAL_SKILL_CONTENT));
  });
});

describe("collectAgentSkillDirs（只检测顶层，不递归）", () => {
  it("命中存在的匹配目录，跳过不存在的（按 AGENT_SKILL_DIRS 顺序）", () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, ".claude", "skills"), { recursive: true });
    fs.mkdirSync(path.join(root, ".agent", "skill"), { recursive: true });
    fs.mkdirSync(path.join(root, "AgentHome", "skills"), { recursive: true });
    const hits = collectAgentSkillDirs(root);
    expect(hits).toEqual([
      path.join(root, ".claude", "skills"),
      path.join(root, ".agent", "skill"),
      path.join(root, "AgentHome", "skills"),
    ]);
  });

  it("不递归：子目录里的匹配目录不命中", () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, "sub", ".claude", "skills"), { recursive: true });
    expect(collectAgentSkillDirs(root)).toEqual([]);
  });

  it("匹配目录是普通文件 → 不命中", () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, ".claude"), "file-not-dir", "utf-8");
    expect(collectAgentSkillDirs(root)).toEqual([]);
  });

  it("清单本身非空且去重、每项为相对路径", () => {
    expect(AGENT_SKILL_DIRS.length).toBeGreaterThan(0);
    expect(new Set(AGENT_SKILL_DIRS).size).toBe(AGENT_SKILL_DIRS.length);
    for (const rel of AGENT_SKILL_DIRS) {
      expect(path.isAbsolute(rel)).toBe(false);
      expect(rel).toMatch(/^\.?[A-Za-z]/);
    }
  });
});

describe("performAgentSkillAssembly（真实 IO，临时目录）", () => {
  function sourceFixture(): { root: string; base: string; skillRoot: string; content: string } {
    const content = "---\nname: v-cli\n---\n# v-cli norms\n";
    const { root, base } = fakePackage(content);
    return { root, base, skillRoot: path.join(root, "skills", SKILL_NAME), content };
  }

  it("命中目录装配：把 skill 复制为 <命中目录>/v-cli/SKILL.md", () => {
    const { base, skillRoot, content } = sourceFixture();
    const target = tmpDir();
    fs.mkdirSync(path.join(target, ".claude", "skills"), { recursive: true });
    const src = readSkillSource({ base });
    const result = performAgentSkillAssembly({ directory: target, source: src });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.assembled).toHaveLength(1);
    expect(result.assembled[0].dir).toBe(path.join(target, ".claude", "skills"));
    expect(result.assembled[0].target).toBe(path.join(target, ".claude", "skills", SKILL_NAME));
    expect(result.assembled[0].action).toBe("assembled");
    expect(result.assembled[0].overwrite).toBe(false);
    expect(result.skill.name).toBe(SKILL_NAME);
    expect(result.skill.sha256).toBe(sha256Hex(content));
    expect(fs.readFileSync(path.join(target, ".claude", "skills", SKILL_NAME, SKILL_FILE), "utf-8")).toBe(content);
    expect(skillRoot).toBeTruthy();
  });

  it("覆盖：已存在同内容 skill 目录 → overwrite=true（随包没有的文件默认保留）", () => {
    const { base, content } = sourceFixture();
    const target = tmpDir();
    const skillDir = path.join(target, ".agent", "skill");
    fs.mkdirSync(path.join(skillDir, SKILL_NAME), { recursive: true });
    // 内容与随包一致 → 正常覆盖；内容不同时的保留语义见「本地 skill 保护」用例
    fs.writeFileSync(path.join(skillDir, SKILL_NAME, SKILL_FILE), content, "utf-8");
    fs.writeFileSync(path.join(skillDir, SKILL_NAME, "extra.txt"), "x", "utf-8");
    const src = readSkillSource({ base });
    const result = performAgentSkillAssembly({ directory: target, source: src });
    expect(result.assembled).toHaveLength(1);
    expect(result.assembled[0].overwrite).toBe(true);
    expect(fs.readFileSync(path.join(skillDir, SKILL_NAME, SKILL_FILE), "utf-8")).toBe(content);
    // 项目扩展文件默认保留；--force 时才做完全同步（见下一条用例）
    expect(fs.existsSync(path.join(skillDir, SKILL_NAME, "extra.txt"))).toBe(true);
  });

  it("无命中目录 → ok 且 assembled 为空（正常跳过，非错误）", () => {
    const { base } = sourceFixture();
    const target = tmpDir();
    const src = readSkillSource({ base });
    const result = performAgentSkillAssembly({ directory: target, source: src });
    expect(result.ok).toBe(true);
    expect(result.assembled).toEqual([]);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it("dry-run：不写任何文件，action=assemble", () => {
    const { base } = sourceFixture();
    const target = tmpDir();
    fs.mkdirSync(path.join(target, ".claude", "skills"), { recursive: true });
    const src = readSkillSource({ base });
    const result = performAgentSkillAssembly({ directory: target, source: src, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.assembled[0].action).toBe("assemble");
    expect(fs.readdirSync(path.join(target, ".claude", "skills"))).toEqual([]);
  });

  it("目录不存在 / 非目录 → ok=false 且带 reason", () => {
    const { base } = sourceFixture();
    const src = readSkillSource({ base });
    const missing = performAgentSkillAssembly({ directory: path.join(tmpDir(), "nope"), source: src });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toContain("不存在");

    const fileAsDir = path.join(tmpDir(), "plain.txt");
    fs.writeFileSync(fileAsDir, "x", "utf-8");
    const notDir = performAgentSkillAssembly({ directory: fileAsDir, source: src });
    expect(notDir.ok).toBe(false);
    expect(notDir.reason).toContain("不是目录");
  });

  it("copySkillDir：整目录覆盖（先删后复制）", () => {
    const srcRoot = tmpDir();
    fs.mkdirSync(path.join(srcRoot, "sub"), { recursive: true });
    fs.writeFileSync(path.join(srcRoot, "SKILL.md"), "new\n", "utf-8");
    fs.writeFileSync(path.join(srcRoot, "sub", "a.md"), "a\n", "utf-8");

    const dest = path.join(tmpDir(), "v-cli");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "old.txt"), "old\n", "utf-8");

    copySkillDir(srcRoot, dest);
    expect(fs.readFileSync(path.join(dest, "SKILL.md"), "utf-8")).toBe("new\n");
    expect(fs.readFileSync(path.join(dest, "sub", "a.md"), "utf-8")).toBe("a\n");
    expect(fs.existsSync(path.join(dest, "old.txt"))).toBe(false);
  });
});

describe("随包版本权威：本地修改被刷新，项目扩展文件保留", () => {
  function seedLocal(target: string, dirRel: string, skillContent: string): string {
    const dir = path.join(target, dirRel, SKILL_NAME);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, SKILL_FILE);
    fs.writeFileSync(file, skillContent, "utf-8");
    return file;
  }

  it("本地已修改 → 默认按随包版本刷新并标记 localModified", () => {
    const { base } = fakePackage();
    const src = readSkillSource({ base });
    const target = tmpDir();
    const file = seedLocal(target, ".claude/skills", "---\nname: v-cli\n---\n# 本地旧版\n");

    const result = performAgentSkillAssembly({ directory: target, source: src });
    expect(result.ok).toBe(true);
    expect(result.assembled).toHaveLength(1);
    expect(result.assembled[0].action).toBe("assembled");
    expect(result.assembled[0].overwrite).toBe(true);
    expect(result.assembled[0].localModified).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).toBe(src.content);
  });

  it("内容一致 → 覆盖但 localModified=false", () => {
    const { base } = fakePackage();
    const src = readSkillSource({ base });
    const target = tmpDir();
    seedLocal(target, ".claude/skills", src.content);

    const result = performAgentSkillAssembly({ directory: target, source: src });
    expect(result.assembled[0].overwrite).toBe(true);
    expect(result.assembled[0].localModified).toBe(false);
  });

  it("项目扩展文件默认保留（随包没有的文件不被删除）", () => {
    const { base } = fakePackage();
    const src = readSkillSource({ base });
    const target = tmpDir();
    const dir = path.join(target, ".claude", "skills", SKILL_NAME);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "PROJECT.md"), "# 项目扩展\n", "utf-8");

    performAgentSkillAssembly({ directory: target, source: src });
    expect(fs.readFileSync(path.join(dir, "PROJECT.md"), "utf-8")).toBe("# 项目扩展\n");
    expect(fs.readFileSync(path.join(dir, SKILL_FILE), "utf-8")).toBe(src.content);
  });

  it("--force → 完全同步，扩展文件被清掉", () => {
    const { base } = fakePackage();
    const src = readSkillSource({ base });
    const target = tmpDir();
    const dir = path.join(target, ".agent", "skill", SKILL_NAME);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, SKILL_FILE), "old\n", "utf-8");
    fs.writeFileSync(path.join(dir, "PROJECT.md"), "# 项目扩展\n", "utf-8");

    performAgentSkillAssembly({ directory: target, source: src, force: true });
    expect(fs.existsSync(path.join(dir, "PROJECT.md"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, SKILL_FILE), "utf-8")).toBe(src.content);
  });

  it("dry-run → 不写入，但仍标记 localModified", () => {
    const { base } = fakePackage();
    const src = readSkillSource({ base });
    const target = tmpDir();
    const local = "---\nname: v-cli\n---\n# 本地旧版\n";
    const file = seedLocal(target, ".claude/skills", local);

    const result = performAgentSkillAssembly({ directory: target, source: src, dryRun: true });
    expect(result.assembled[0].action).toBe("assemble");
    expect(result.assembled[0].localModified).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).toBe(local);
  });
});
