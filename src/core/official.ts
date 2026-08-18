/**
 * 官方插件发现：严格白名单（OFFICIAL_PLUGINS），只解析白名单内的包，
 * 不做 node_modules 扫描、不做运行时安装。发现过程为纯函数（IO 可注入），
 * 永不抛出——任何失败都归类为 missing/invalid/platform-mismatch。
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { validateManifest, validatePluginIdentity, type PluginManifest } from "./manifest";

export interface OfficialPluginSpec {
  package: string;
  command: string;
  description: string;
}

/** 官方插件白名单：v-cli 唯一会解析/路由的插件集合 */
export const OFFICIAL_PLUGINS: OfficialPluginSpec[] = [
  {
    package: "@kevlns/xlmerge",
    command: "xlmerge",
    description: "Git 中 .xlsx/.xlsm 冲突可视化解决方案（三向 diff、本地 UI、写回与提交）",
  },
  {
    package: "@kevlns/u-cli-mod",
    command: "unity",
    description: "Unity 工程精确版本路由 + 官方 CLI 下载 + com.unity.pipeline 适配包（Windows-first）",
  },
];

/** 官方命令名（本地插件不可占用） */
export const OFFICIAL_COMMAND_NAMES: ReadonlySet<string> = new Set(
  OFFICIAL_PLUGINS.map((p) => p.command),
);

export type OfficialPluginStatus = "available" | "missing" | "invalid" | "platform-mismatch";

/** 官方插件命令的完整清单元数据（与 v-cli.plugin.json agent.commands 对齐） */
export interface OfficialCommandInfo {
  path: string[];
  usage: string;
  description: string;
  arguments: { name: string; required: boolean; description: string }[];
  options: { flags: string; description: string }[];
  output: { format: string; description: string };
  exitCodes: Record<string, string>;
  safety: string[];
}

export interface OfficialPluginInfo {
  source: "official";
  package: string;
  name: string;
  description: string;
  status: OfficialPluginStatus;
  platform: string;
  version?: string;
  /** 可执行入口绝对路径（仅 available 时给出） */
  bin?: string;
  requiredPlatforms?: string[];
  error?: string;
  whenToUse?: string;
  globalOptions?: { flags: string; description: string }[];
  commands?: OfficialCommandInfo[];
  runtime?: Record<string, unknown>;
  environment?: { name: string; description: string }[];
}

/** 可注入 IO（测试用 fixture 根目录 / 自定义 reader） */
export interface DiscoveryIo {
  /** 覆盖实际平台（默认 process.platform） */
  platform?: string;
  /** 解析某包 package.json 的绝对路径；返回 undefined 表示不可解析 */
  resolvePackage?: (pkg: string) => string | undefined;
  existsFile?: (file: string) => boolean;
  readFile?: (file: string) => string;
}

/** defaultResolvePackage 的可注入参数（测试用） */
export interface ResolvePackageOptions {
  /** v-cli 本体模块文件的绝对路径（默认 fileURLToPath(import.meta.url)，即 bundle 位置） */
  base?: string;
  /** 当前工作目录（默认 process.cwd()） */
  cwd?: string;
  /** 显式插件解析根（其 node_modules/{pkg} 提供包）；默认取 V_CLI_PLUGIN_RESOLVE_FROM */
  resolveFrom?: string;
}

/**
 * 默认解析策略（import-aware：base 必须已由 fileURLToPath 转成文件系统路径）：
 * 1) V_CLI_PLUGIN_RESOLVE_FROM 指向的根（其 node_modules/{pkg} 提供 fixture/本地开发包）；
 * 2) v-cli 本体安装位置的 node_modules 树（createRequire 向上查找：全局安装时
 *    官方插件与 v-cli 同级或嵌套在任意父级 node_modules）；
 * 3) 当前工作目录的 node_modules 树（仓库内开发）。
 */
export function defaultResolvePackage(
  pkg: string,
  opts: ResolvePackageOptions = {},
): string | undefined {
  const baseFile = opts.base ?? fileURLToPath(import.meta.url);
  const cwd = opts.cwd ?? process.cwd();
  const resolveFrom = opts.resolveFrom ?? process.env.V_CLI_PLUGIN_RESOLVE_FROM;
  const candidates: string[] = [];

  if (resolveFrom) {
    candidates.push(path.join(path.resolve(cwd, resolveFrom), "node_modules", pkg, "package.json"));
  }
  try {
    candidates.push(createRequire(baseFile).resolve(`${pkg}/package.json`));
  } catch {
    // 未安装在 v-cli 节点树
  }
  try {
    const reqCwd = createRequire(path.join(cwd, "__v_cli_resolve__.cjs"));
    candidates.push(reqCwd.resolve(`${pkg}/package.json`, { paths: [cwd] }));
  } catch {
    // 未安装在当前工作目录节点树
  }
  // 取第一个真实存在的候选
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // 忽略
    }
  }
  return undefined;
}

function defaultExists(file: string): boolean {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

function defaultRead(file: string): string {
  return fs.readFileSync(file, "utf-8");
}

function formatErrors(errors: string[]): string {
  return errors.join("；");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 发现并校验单个官方插件；任何畸形输入都转为状态码，绝不抛出 */
export function discoverOfficialPlugin(
  spec: OfficialPluginSpec,
  io: DiscoveryIo = {},
): OfficialPluginInfo {
  const platform = io.platform ?? process.platform;
  const exists = io.existsFile ?? defaultExists;
  const read = io.readFile ?? defaultRead;
  const resolvePackage = io.resolvePackage ?? defaultResolvePackage;

  const base: OfficialPluginInfo = {
    source: "official",
    package: spec.package,
    name: spec.command,
    description: spec.description,
    status: "missing",
    platform,
  };

  let pkgJsonPath: string | undefined;
  try {
    pkgJsonPath = resolvePackage(spec.package);
  } catch {
    pkgJsonPath = undefined;
  }
  if (!pkgJsonPath || !exists(pkgJsonPath)) {
    return {
      ...base,
      error: `未找到官方插件包 ${spec.package}（未安装或不在可解析路径；请安装后重试）`,
    };
  }

  let pkgJson: Record<string, unknown>;
  try {
    pkgJson = JSON.parse(read(pkgJsonPath)) as Record<string, unknown>;
  } catch (err) {
    return {
      ...base,
      status: "invalid",
      error: `package.json 不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const vCliMeta = pkgJson.vCli && isPlainObject(pkgJson.vCli) ? pkgJson.vCli : {};
  const manifestRel =
    typeof vCliMeta.manifest === "string" ? vCliMeta.manifest : "v-cli.plugin.json";
  const pkgRoot = path.dirname(pkgJsonPath);
  const manifestPath = path.join(pkgRoot, manifestRel);
  if (!exists(manifestPath)) {
    return {
      ...base,
      error: `包内缺少插件清单 ${manifestRel}（package.json 的 vCli.manifest 指向它）`,
    };
  }

  let manifestRaw: string;
  try {
    manifestRaw = read(manifestPath);
  } catch (err) {
    return {
      ...base,
      error: `读取清单失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestRaw);
  } catch (err) {
    return {
      ...base,
      status: "invalid",
      error: `清单 ${manifestRel} 不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const validated = validateManifest(parsed);
  if (!validated.ok) {
    return { ...base, status: "invalid", error: `清单校验失败: ${formatErrors(validated.errors)}` };
  }
  const manifest: PluginManifest = validated.manifest;

  const identityErrors = validatePluginIdentity(manifest, pkgJson);
  if (identityErrors.length > 0) {
    return {
      ...base,
      status: "invalid",
      error: `身份校验失败: ${formatErrors(identityErrors)}`,
    };
  }

  if (manifest.command !== spec.command) {
    return {
      ...base,
      status: "invalid",
      error: `清单 command "${manifest.command}" 与官方白名单命令 "${spec.command}" 不一致`,
    };
  }

  // bin 目标必须是字符串，且解析结果不得逃逸包目录
  const binMap = pkgJson.bin;
  const binRel = isPlainObject(binMap) ? binMap[manifest.bin] : undefined;
  if (typeof binRel !== "string" || binRel.length === 0) {
    return {
      ...base,
      status: "invalid",
      error: `bin "${manifest.bin}" 的启动目标不是字符串路径`,
    };
  }
  const binPath = path.resolve(pkgRoot, binRel);
  const rootPrefix = pkgRoot.endsWith(path.sep) ? pkgRoot : pkgRoot + path.sep;
  if (!binPath.startsWith(rootPrefix)) {
    return {
      ...base,
      status: "invalid",
      error: `bin "${manifest.bin}" 的目标 ${binRel} 逃逸了包目录`,
    };
  }

  const requiredPlatforms = manifest.platforms;
  if (!requiredPlatforms.includes(platform)) {
    return {
      ...base,
      status: "platform-mismatch",
      version: typeof pkgJson.version === "string" ? pkgJson.version : undefined,
      requiredPlatforms,
      error: `该插件仅支持平台 [${requiredPlatforms.join(", ")}]，当前平台为 ${platform}`,
    };
  }

  if (!exists(binPath)) {
    return {
      ...base,
      version: typeof pkgJson.version === "string" ? pkgJson.version : undefined,
      requiredPlatforms,
      error: `bin 文件不存在: ${binRel}（manifest.bin=${manifest.bin}）`,
    };
  }

  return {
    ...base,
    status: "available",
    version: typeof pkgJson.version === "string" ? pkgJson.version : undefined,
    requiredPlatforms,
    bin: binPath,
    whenToUse: manifest.agent.whenToUse,
    globalOptions: manifest.agent.globalOptions,
    commands: manifest.agent.commands.map((c) => ({
      path: c.path,
      usage: c.usage,
      description: c.description,
      arguments: c.arguments,
      options: c.options,
      output: c.output,
      exitCodes: c.exitCodes,
      safety: c.safety,
    })),
    runtime: manifest.runtime,
    environment: manifest.environment,
  };
}

/** 发现全部官方插件（按白名单顺序，恒定） */
export function discoverAllOfficialPlugins(io: DiscoveryIo = {}): OfficialPluginInfo[] {
  return OFFICIAL_PLUGINS.map((spec) => discoverOfficialPlugin(spec, io));
}

/** 判断首个命令词是否为官方插件命令 */
export function isOfficialCommand(token: string): boolean {
  return OFFICIAL_COMMAND_NAMES.has(token);
}