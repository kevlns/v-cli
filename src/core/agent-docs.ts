/**
 * agent docs / agent init 核心逻辑。
 *
 * - resolveBundledAgentsMd：定位【当前执行包】内置 AGENTS.md，不依赖任何物理全局路径假设：
 *   ① dist 布局（<pkg>/dist/cli.mjs → <pkg>/AGENTS.md，构建产物与 npm 安装布局）；
 *   ② 自模块文件向上单次步行，找“包含本模块的 @kevlns/v-cli 包根”（源布局看 <dir>/package.json，
 *      嵌套/全局安装看 <dir>/node_modules/@kevlns/v-cli/package.json），找到即停。
 * - performAgentInit：把内置文档原子写入 <目录>/AGENTS.md；已存在默认拒绝（无变更）、
 *   --force 才覆盖、--dry-run 只报告；符号链接目标一律 fail-closed。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { VERSION } from "../version";
import { defaultResolvePackage, OFFICIAL_PLUGINS } from "./official";

/** 随包发布的引导文档文件名（package.json files 已包含） */
export const BUNDLED_DOCS_FILE = "AGENTS.md";
/** 本包身份（agent docs --json / agent init 结果中的 package 字段） */
export const BUNDLED_DOCS_PACKAGE = "@kevlns/v-cli";

export interface BundledDocs {
  /** 实际读到的文件绝对路径 */
  file: string;
  /** 逐字节原文 */
  content: string;
  /** SHA-256（hex） */
  sha256: string;
  /** UTF-8 字节数 */
  bytes: number;
}

export interface OfficialAgentDocs extends BundledDocs {
  package: string;
  command: string;
  version: string;
}

export interface ReadOfficialAgentsMdOptions {
  /** 注入 package.json 解析器（测试/fixture）；默认复用 official 插件发现策略。 */
  resolvePackage?: (pkg: string) => string | undefined;
}

export interface ResolveBundledAgentsMdOptions {
  /** 本体模块文件的绝对路径；默认 fileURLToPath(import.meta.url)（dist 下即 dist/cli.mjs） */
  base?: string;
}

/** 生成候选路径（顺序即优先级，去重） */
export function bundledCandidatePaths(moduleFile: string): string[] {
  const candidates: string[] = [];
  const push = (p: string) => {
    if (!candidates.includes(p)) candidates.push(p);
  };

  // ① dist 布局：<pkg>/dist/cli.mjs → <pkg>/AGENTS.md（最近优先）
  if (path.basename(path.dirname(moduleFile)) === "dist") {
    push(path.join(path.dirname(path.dirname(moduleFile)), BUNDLED_DOCS_FILE));
  }

  // ② 单次向上步行：找到“包含本模块的 @kevlns/v-cli 包根”，找到即停
  //    - 源布局/包内：<dir>/package.json 的 name 匹配；
  //    - 嵌套/全局安装：<dir>/node_modules/@kevlns/v-cli/package.json 的 name 匹配。
  let dir = path.dirname(moduleFile);
  for (;;) {
    if (pkgName(path.join(dir, "package.json")) === BUNDLED_DOCS_PACKAGE) {
      push(path.join(dir, BUNDLED_DOCS_FILE));
      break;
    }
    const nestedPkg = path.join(dir, "node_modules", "@kevlns", "v-cli", "package.json");
    if (pkgName(nestedPkg) === BUNDLED_DOCS_PACKAGE) {
      push(path.join(dir, "node_modules", "@kevlns", "v-cli", BUNDLED_DOCS_FILE));
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return candidates;
}

/** 读取 package.json 的 name；非 JSON/不存在 → undefined */
function pkgName(pkgJsonPath: string): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as { name?: unknown };
    return typeof pkg.name === "string" ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

/** 定位内置 AGENTS.md；找不到返回 undefined（不抛错，调用方决定处理方式） */
export function resolveBundledAgentsMd(opts: ResolveBundledAgentsMdOptions = {}): string | undefined {
  const moduleFile = opts.base ?? fileURLToPath(import.meta.url);
  for (const candidate of bundledCandidatePaths(moduleFile)) {
    try {
      if (fs.lstatSync(candidate).isFile()) return candidate;
    } catch {
      // 不存在/不可访问 → 下一个候选
    }
  }
  return undefined;
}

/** 读取内置 AGENTS.md；缺失/不可读时抛出带候选信息的清晰错误 */
export function readBundledAgentsMd(opts: ResolveBundledAgentsMdOptions = {}): BundledDocs {
  const file = resolveBundledAgentsMd(opts);
  if (!file) {
    const tried = bundledCandidatePaths(opts.base ?? fileURLToPath(import.meta.url));
    const lastTried = tried.length > 0 ? tried[tried.length - 1] : "（无候选位置）";
    throw new Error(
      `无法定位 ${BUNDLED_DOCS_PACKAGE} 内置 ${BUNDLED_DOCS_FILE}：已检查 ${tried.length} 个候选位置均不存在或不可读（最后检查: ${lastTried}）。请确认安装的包内包含 AGENTS.md（重新安装 @kevlns/v-cli 后重试）。`,
    );
  }
  let content: string;
  try {
    content = fs.readFileSync(file, "utf-8");
  } catch (err) {
    throw new Error(
      `无法读取 ${BUNDLED_DOCS_PACKAGE} 内置 ${BUNDLED_DOCS_FILE}（${file}）: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return {
    file,
    content,
    sha256: sha256Hex(content),
    bytes: Buffer.byteLength(content, "utf-8"),
  };
}

/**
 * 读取已安装官方插件包根的 AGENTS.md。
 * 文档发现不受插件平台限制：例如 Linux 上仍可阅读仅 win32 可执行的 unity 规范。
 */
export function readOfficialAgentsMd(
  command: string,
  opts: ReadOfficialAgentsMdOptions = {},
): OfficialAgentDocs {
  const spec = OFFICIAL_PLUGINS.find((item) => item.command === command);
  if (!spec) {
    throw new Error(
      `未找到官方插件命令: ${command}。请先运行 v-cli agent index --json 查看可用官方插件。`,
    );
  }
  const resolvePackage = opts.resolvePackage ?? defaultResolvePackage;
  const pkgJsonPath = resolvePackage(spec.package);
  if (!pkgJsonPath) {
    throw new Error(
      `未安装官方插件包 ${spec.package}（命令 ${command}），或它不在可解析路径。请先安装后重试。`,
    );
  }

  let pkgJson: { name?: unknown; version?: unknown };
  try {
    pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as {
      name?: unknown;
      version?: unknown;
    };
  } catch (err) {
    throw new Error(
      `无法读取官方插件 ${spec.package} 的 package.json（${pkgJsonPath}）: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (pkgJson.name !== spec.package || typeof pkgJson.version !== "string") {
    throw new Error(`官方插件 package.json 身份无效: 期望 ${spec.package} 且 version 为字符串。`);
  }

  const file = path.join(path.dirname(pkgJsonPath), BUNDLED_DOCS_FILE);
  let content: string;
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error("目标不是普通文件");
    content = fs.readFileSync(file, "utf-8");
  } catch (err) {
    throw new Error(
      `官方插件 ${spec.package}@${pkgJson.version} 未提供可读的 ${BUNDLED_DOCS_FILE}（${file}）: ${
        err instanceof Error ? err.message : String(err)
      }。请升级或重新安装该插件。`,
    );
  }

  return {
    package: spec.package,
    command,
    version: pkgJson.version,
    file,
    content,
    sha256: sha256Hex(content),
    bytes: Buffer.byteLength(content, "utf-8"),
  };
}

/** SHA-256（hex，小写） */
export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

export interface AgentInitOptions {
  /** 目标目录（应为绝对路径） */
  directory: string;
  /** 内置文档（与 agent docs 同一来源，保证 init 写入即 docs 原文） */
  docs: BundledDocs;
  force?: boolean;
  dryRun?: boolean;
  /** 目录是否为用户显式传入（默认省略=当前工作目录）：显式传入的符号链接/联接目录 fail-closed */
  explicitDirectory?: boolean;
}

export interface AgentInitResult {
  ok: boolean;
  dryRun: boolean;
  /** written/overwritten=已写入；write/overwrite=干跑将执行；refused=拒绝（看 reason） */
  action: "written" | "overwritten" | "write" | "overwrite" | "refused";
  directory: string;
  target: string;
  package: string;
  version: string;
  sha256: string;
  bytes: number;
  reason?: string;
}

/**
 * 执行 init 规划与写入（真实 IO）：
 * - 目录必须已存在且是目录；
 * - 目标存在且为符号链接 → 一律拒绝（fail-closed，不跟随、不覆盖链接目标）；
 * - 已存在（普通文件）且未 --force → 拒绝且绝不改动；
 * - --dry-run 只报告目标与动作，不写任何文件；
 * - 写入采用同目录临时文件 + rename（原子；--force 覆盖同样原子）。
 */
export function performAgentInit(opts: AgentInitOptions): AgentInitResult {
  const { directory, docs, force = false, dryRun = false, explicitDirectory = false } = opts;
  const target = path.join(directory, BUNDLED_DOCS_FILE);
  const base = {
    ok: false,
    dryRun,
    action: "refused" as AgentInitResult["action"],
    directory,
    target,
    package: BUNDLED_DOCS_PACKAGE,
    version: VERSION,
    sha256: docs.sha256,
    bytes: docs.bytes,
  };
  const refuse = (reason: string): AgentInitResult => ({ ...base, ok: false, action: "refused", reason });

  // 目标目录必须已存在且是目录
  let dirStat: fs.Stats;
  try {
    dirStat = fs.statSync(directory);
  } catch {
    return refuse(`目标目录不存在或不可访问: ${directory}`);
  }
  if (!dirStat.isDirectory()) {
    return refuse(`目标不是目录: ${directory}`);
  }

  // 显式传入的目录若本身是符号链接/联接（junction）→ fail-closed（不跟随）。
  // 省略目录参数（默认当前工作目录）不受此限制：cwd 为联接目录属常见场景（如临时目录）。
  if (explicitDirectory) {
    let dirLstat: fs.Stats | undefined;
    try {
      dirLstat = fs.lstatSync(directory);
    } catch {
      // lstat 失败（如竞态删除）→ 按不可检测处理，后续写入失败会自然给出错误
    }
    if (dirLstat && dirLstat.isSymbolicLink()) {
      return refuse(
        `拒绝写入：目标目录 ${directory} 是符号链接/联接目录（fail-closed，不跟随）。请传入真实目录路径，或省略参数让 v-cli 使用当前工作目录`,
      );
    }
  }

  // 目标文件检查（lstat：不跟随符号链接）
  let targetStat: fs.Stats | undefined;
  try {
    targetStat = fs.lstatSync(target);
  } catch {
    targetStat = undefined; // 不存在 → 全新写入
  }
  if (targetStat) {
    if (targetStat.isSymbolicLink()) {
      return refuse(
        `拒绝写入 ${target}：目标是符号链接（fail-closed，不跟随、不覆盖链接目标）。请先移除链接或选择其他目录`,
      );
    }
    if (targetStat.isDirectory()) {
      return refuse(`拒绝写入 ${target}：目标是一个目录（无法以文件覆盖）`);
    }
    if (!force) {
      return refuse(
        `${target} 已存在，默认拒绝覆盖（不做任何改动）。如需覆盖请使用 --force；如需预览请使用 --dry-run；如需先查看内容请运行 v-cli agent docs`,
      );
    }
  }

  const existed = targetStat !== undefined;
  const action: AgentInitResult["action"] = existed
    ? dryRun
      ? "overwrite"
      : "overwritten"
    : dryRun
      ? "write"
      : "written";
  if (dryRun) {
    return { ...base, ok: true, action };
  }

  try {
    atomicWrite(target, docs.content);
  } catch (err) {
    return refuse(`写入失败 ${target}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { ...base, ok: true, action };
}

/** errno code 是否为 EEXIST（用于识别临时文件名 wx 碰撞） */
function isEexist(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "EEXIST"
  );
}

/** 临时文件名随机碰撞重试上限（有界，避免无限循环） */
const MAX_TMP_RETRIES = 5;

/**
 * 原子写入：同目录临时文件 + rename。
 * 唯一豁免：临时文件名 wx 碰撞（EEXIST，极低概率）→ 换名有界重试；
 * 无论成功失败，绝不删除不是本次调用创建的文件（碰撞时 wx 未创建任何文件，直接换名）。
 */
export function atomicWrite(target: string, content: string): void {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_TMP_RETRIES; attempt++) {
    const tmp = path.join(
      path.dirname(target),
      `.${BUNDLED_DOCS_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    let created = false;
    try {
      fs.writeFileSync(tmp, content, { encoding: "utf-8", flag: "wx", mode: 0o644 });
      created = true;
      fs.renameSync(tmp, target);
      return;
    } catch (err) {
      lastError = err;
      // 只清理本次调用创建的文件；未创建（wx 碰撞）绝不删除既有文件，直接换名重试
      if (created) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          // 清理失败不掩盖主错误
        }
      }
      if (isEexist(err)) continue;
      throw err;
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "未知错误");
  throw new Error(`原子写入失败（临时文件命名碰撞重试 ${MAX_TMP_RETRIES} 次未果）: ${detail}`);
}