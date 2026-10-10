/**
 * 工程根锚定与路径安全。
 *
 * 规则（全部 fail-closed，测试覆盖）：
 * - 工程根由显式 --project（或默认 cwd）解析；必须存在且是目录，随后取 realpath 作为锚。
 * - 业务相对路径拒绝：绝对路径（含盘符、UNC、/ 与 \ 开头）、空段、"." 与 ".."、
 *   NUL；解析结果必须落在工程根内。
 * - 符号链接/联接（junction）越界拒绝：对"最深的已存在祖先"取 realpath 再核对包含关系；
 *   目标本身是符号链接时同样拒绝（不跟随、不写入链接目标）。
 */

import fs from "node:fs";
import path from "node:path";

export interface ProjectRoot {
  /** 解析后的绝对路径（保留调用方书写形式） */
  root: string;
  /** 工程根 realpath（包含关系判定的基准） */
  realRoot: string;
}

export class PathSafetyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PathSafetyError";
    this.code = code;
  }
}

function isPlainAbsolute(input: string): boolean {
  return path.isAbsolute(input) || /^[A-Za-z]:/.test(input) || input.startsWith("\\\\") || input.startsWith("//");
}

/** 解析并锚定工程根；不存在/不是目录时抛出 */
export function resolveProjectRoot(input?: string, cwd: string = process.cwd()): ProjectRoot {
  const root = path.resolve(cwd, input ?? ".");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(root);
  } catch {
    throw new PathSafetyError("project-root-missing", `工程根不存在: ${root}`);
  }
  if (!stat.isDirectory()) {
    throw new PathSafetyError("project-root-not-directory", `工程根不是目录: ${root}`);
  }
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch (err) {
    throw new PathSafetyError(
      "project-root-unreadable",
      `工程根无法解析 realpath: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { root, realRoot };
}

/** 拆分相对路径为段；非法即抛 */
export function splitSafeRelative(relative: string, label: string): string[] {
  if (typeof relative !== "string" || relative.length === 0) {
    throw new PathSafetyError("path-invalid", `${label} 必须是非空相对路径`);
  }
  if (relative.includes("\0")) {
    throw new PathSafetyError("path-invalid", `${label} 含非法字符（NUL）`);
  }
  if (isPlainAbsolute(relative)) {
    throw new PathSafetyError("path-absolute", `${label} 必须是相对工程根的路径，禁止绝对路径: ${relative}`);
  }
  const segments = relative.split(/[\\/]+/);
  for (const segment of segments) {
    if (segment === "" ) {
      throw new PathSafetyError("path-invalid", `${label} 含空路径段: ${JSON.stringify(relative)}`);
    }
    if (segment === "." || segment === "..") {
      throw new PathSafetyError("path-traversal", `${label} 禁止 "." 或 ".." 路径段: ${JSON.stringify(relative)}`);
    }
  }
  return segments;
}

function isInside(rootReal: string, candidateReal: string): boolean {
  const rel = path.relative(rootReal, candidateReal);
  if (rel === "") return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** 找最深的已存在祖先（含自身）；不存在祖先时返回 rootReal */
function deepestExisting(target: string, stopAt: string): string {
  let current = target;
  for (;;) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current || current === stopAt) return stopAt;
    current = parent;
  }
}

/**
 * 把相对路径解析到工程根内；任何越界（绝对路径/../符号链接逃逸）都拒绝。
 * 返回绝对路径与（若存在）realpath。绑定路径允许 "." 表示工程根本身。
 */
export function resolveInsideProject(
  project: ProjectRoot,
  relative: string,
  label: string,
): { path: string; realPath: string | null } {
  if (relative === ".") {
    return { path: project.root, realPath: project.realRoot };
  }
  const segments = splitSafeRelative(relative, label);
  const target = path.join(project.root, ...segments);

  const existingAncestor = deepestExisting(target, project.realRoot);
  let ancestorReal: string;
  try {
    ancestorReal = fs.realpathSync(existingAncestor);
  } catch (err) {
    throw new PathSafetyError(
      "path-unresolvable",
      `${label} 无法解析 realpath: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isInside(project.realRoot, ancestorReal)) {
    throw new PathSafetyError(
      "path-escape",
      `${label} 解析后逃逸工程根（${relative} → ${ancestorReal}）`,
    );
  }

  let realPath: string | null = null;
  if (fs.existsSync(target)) {
    const lst = fs.lstatSync(target);
    if (lst.isSymbolicLink()) {
      throw new PathSafetyError("path-symlink", `${label} 是符号链接/联接，拒绝写入或跟随: ${target}`);
    }
    realPath = fs.realpathSync(target);
    if (!isInside(project.realRoot, realPath)) {
      throw new PathSafetyError("path-escape", `${label} 的真实路径逃逸工程根: ${realPath}`);
    }
  }
  return { path: target, realPath };
}

/** 路径词形比较基准：反斜杠→斜杠、去尾斜杠；仅 win32 小写（大小写不敏感文件系统） */
export function comparePathForm(p: string): string {
  const forward = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? forward.toLowerCase() : forward;
}

/** 相对工程根的展示路径（posix 分隔符） */
export function toRelative(project: ProjectRoot, target: string): string {
  return path.relative(project.root, target).split(path.sep).join("/");
}
