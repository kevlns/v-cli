/**
 * v-cli skill 装配：把随包发布的 skills/v-cli 装配到 init 目标目录下匹配的 agent 技能目录。
 *
 * 定位 skill 源复用 agent-docs 的包根发现（通过内置 AGENTS.md 路径反推包根，再取
 * <pkg>/skills/v-cli），不依赖任何物理全局路径假设。装配规则：
 *   - 只检测 init 目标目录顶层是否存在 AGENT_SKILL_DIRS 中任一目录（stat 跟随符号链接，
 *     目录存在才纳入）；
 *   - 命中目录后把整个 skill 目录复制为 <命中目录>/v-cli（整目录覆盖：先删后复制，保证
 *     目标与源一致；rm 不跟随符号链接，删的是链接本身而非链接目标）；
 *   - 目标已有同内容 SKILL.md → 正常覆盖保持一致；已有但内容不同（项目侧按实时命令面回补过）
 *     且未传 force → 保留本地版本（action=kept），避免随包版本降级项目正本；
 *   - 无命中目录 → 正常跳过（不视为错误）。
 */
import fs from "node:fs";
import path from "node:path";
import { BUNDLED_DOCS_PACKAGE, resolveBundledAgentsMd, sha256Hex } from "./agent-docs";
import { AGENT_SKILL_DIRS } from "./agent-dirs";

/** 随包发布的 skill 目录名与入口文件名（package.json files 已包含 skills/） */
export const SKILL_NAME = "v-cli";
export const SKILL_FILE = "SKILL.md";

export interface SkillSource {
  /** skills/v-cli 目录绝对路径 */
  root: string;
  /** SKILL.md 绝对路径 */
  file: string;
  /** SKILL.md 逐字节原文 */
  content: string;
  /** SHA-256（hex） */
  sha256: string;
  /** UTF-8 字节数 */
  bytes: number;
}

export interface SkillAssemblyTarget {
  /** 命中的 agent 技能目录绝对路径（如 <dir>/.claude/skills） */
  dir: string;
  /** 将写入的 skill 目录绝对路径（<dir>/v-cli） */
  target: string;
  /** assembled=已写入；assemble=dry-run 将写入 */
  /** assembled=已写入；assemble=dry-run 将写入；kept=本地已修改，保留未覆盖 */
  action: "assembled" | "assemble" | "kept";
  /** 是否覆盖了已存在的 skill 目录 */
  overwrite: boolean;
}

export interface SkillAssemblyResult {
  ok: boolean;
  dryRun: boolean;
  directory: string;
  /** 命中并装配的目标列表（无命中时为空数组，正常跳过） */
  assembled: SkillAssemblyTarget[];
  skill: { name: string; sha256: string; bytes: number };
  reason?: string;
}

export interface ResolveSkillSourceOptions {
  /** 本体模块文件的绝对路径（测试注入）；默认 fileURLToPath(import.meta.url) */
  base?: string;
}

/** 定位包内 skills/v-cli 目录；缺失返回 undefined（不抛错） */
export function resolveSkillSourceRoot(opts: ResolveSkillSourceOptions = {}): string | undefined {
  const agentsMd = resolveBundledAgentsMd(opts);
  if (!agentsMd) return undefined;
  const root = path.join(path.dirname(agentsMd), "skills", SKILL_NAME);
  try {
    if (fs.statSync(root).isDirectory()) return root;
  } catch {
    // 不存在/不可访问 → 下一个候选
  }
  return undefined;
}

/** 读取包内 skill 源（SKILL.md）；缺失/不可读时抛出带候选信息的清晰错误 */
export function readSkillSource(opts: ResolveSkillSourceOptions = {}): SkillSource {
  const root = resolveSkillSourceRoot(opts);
  if (!root) {
    throw new Error(
      `无法定位 ${BUNDLED_DOCS_PACKAGE} 内置 skill（skills/${SKILL_NAME}）：请确认安装的包内包含 skills/ 目录（重新安装 @kevlns/v-cli 后重试）。`,
    );
  }
  const file = path.join(root, SKILL_FILE);
  let content: string;
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error("入口不是普通文件");
    content = fs.readFileSync(file, "utf-8");
  } catch (err) {
    throw new Error(
      `无法读取 ${BUNDLED_DOCS_PACKAGE} 内置 skill（${file}）: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return {
    root,
    file,
    content,
    sha256: sha256Hex(content),
    bytes: Buffer.byteLength(content, "utf-8"),
  };
}

/** 收集 init 目标目录顶层下命中的 agent 技能目录（绝对路径，按 AGENT_SKILL_DIRS 顺序） */
export function collectAgentSkillDirs(directory: string): string[] {
  const hits: string[] = [];
  for (const rel of AGENT_SKILL_DIRS) {
    const abs = path.join(directory, rel);
    try {
      if (fs.statSync(abs).isDirectory()) hits.push(abs);
    } catch {
      // 不存在 → 跳过
    }
  }
  return hits;
}

/** 整目录覆盖复制：先删后复制，保证目标与源逐文件一致（rm 不跟随符号链接） */
export function copySkillDir(srcRoot: string, destDir: string): void {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.cpSync(srcRoot, destDir, { recursive: true });
}

/** 读取目标 skill 的入口文件内容；不存在或不可读返回 undefined */
export function readSkillFileAt(targetDir: string): string | undefined {
  try {
    const file = path.join(targetDir, SKILL_FILE);
    if (!fs.lstatSync(file).isFile()) return undefined;
    return fs.readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
}

export interface AgentSkillAssemblyOptions {
  /** init 目标目录（绝对路径） */
  directory: string;
  /** skill 源（readSkillSource 的结果） */
  source: SkillSource;
  dryRun?: boolean;
  /** true 时无条件覆盖已存在的本地 skill（与 AGENTS.md 的 --force 同源） */
  force?: boolean;
}

/** 执行 skill 装配规划与写入（真实 IO）；无命中目录 → 正常返回空 assembled */
export function performAgentSkillAssembly(opts: AgentSkillAssemblyOptions): SkillAssemblyResult {
  const { directory, source, dryRun = false, force = false } = opts;
  const base: SkillAssemblyResult = {
    ok: true,
    dryRun,
    directory,
    assembled: [],
    skill: { name: SKILL_NAME, sha256: source.sha256, bytes: source.bytes },
  };

  let dirStat: fs.Stats;
  try {
    dirStat = fs.statSync(directory);
  } catch {
    return { ...base, ok: false, reason: `目标目录不存在或不可访问: ${directory}` };
  }
  if (!dirStat.isDirectory()) {
    return { ...base, ok: false, reason: `目标不是目录: ${directory}` };
  }

  const hits = collectAgentSkillDirs(directory);
  for (const dir of hits) {
    const target = path.join(dir, SKILL_NAME);
    const existing = readSkillFileAt(target);
    const exists = existing !== undefined;

    // 本地已修改（项目侧按实时命令面回补过）：默认保留，避免随包版本降级项目正本
    if (exists && existing !== source.content && !force) {
      base.assembled.push({ dir, target, action: "kept", overwrite: false });
      continue;
    }

    const action: SkillAssemblyTarget["action"] = dryRun ? "assemble" : "assembled";
    if (!dryRun) {
      copySkillDir(source.root, target);
    }
    base.assembled.push({ dir, target, action, overwrite: exists });
  }
  return base;
}
