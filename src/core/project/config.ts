/**
 * 工程级 v-cli 配置：.vant/config/v-cli.json —— 通用配置外壳。
 *
 * 职责分离（硬边界，测试覆盖）：
 * - 核心只定义外壳：schemaVersion + bindings（按 Provider ID 分组）。
 *   每个绑定段的结构、字段、路径由对应 Provider 的绑定契约自包含声明与校验
 *   （见 core/execution/types.ts 的 ProviderBindingContract）；核心对路径字段做
 *   重解析强核对（不信任 Provider 返回的路径字符串）。
 * - 角色 / workflow / 项目组织属于 Vant 的 .vant/config/project.json，v-cli 既不读也不写；
 *   配置里出现这类字段会被明确拒绝（单一真源，不做双份配置）。
 * - 失败语义：绑定段缺失的 Provider 不阻断其他 Provider（运行期由前置条件失败）；
 *   已声明但无效的绑定（未知 Provider / schema 不符 / 路径越界 / 强核对不一致）
 *   使整个配置 fail-closed。
 * - 无配置文件时不猜测：报错并给出 `v-cli project init` 初始化指引。
 * - project init 绝不覆盖已有配置；也绝不改动任何 Vant 配置文件。
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PathSafetyError, resolveInsideProject, type ProjectRoot } from "./paths";
import type { CapabilityProvider, ProviderBindingResolutionOk } from "../execution/types";
import { validateValue } from "../execution/json-schema";

export const PROJECT_CLI_CONFIG_RELATIVE = ".vant/config/v-cli.json";
/** Vant 组织层配置：v-cli 只做只读提示，永不写入 */
export const VANT_PROJECT_CONFIG_RELATIVE = ".vant/config/project.json";
export const OPERATIONS_RELATIVE = ".vant/state/operations";

/** 属于 Vant 组织层职责、不允许出现在 v-cli.json 的顶层键 */
const VANT_OWNED_KEYS = ["roles", "role", "workflow", "workflows", "pipeline", "stages", "organization", "org", "project", "teams"];
/** 原型污染危险键：外壳层直接拒绝 */
const DANGEROUS_KEYS = ["__proto__", "prototype", "constructor"];

/** 通用配置外壳：绑定段内容由 Provider 契约定义 */
export interface ProjectCliConfig {
  schemaVersion: 1;
  /** Provider ID -> 绑定段（结构由该 Provider 的 binding.schema 定义） */
  bindings: Record<string, unknown>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 外壳校验（不含 Provider 字段语义）：结构、Vant 职责键、危险键 */
export function validateProjectCliConfig(raw: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(raw)) return ["配置必须是 JSON 对象"];
  if (raw.schemaVersion !== 1) {
    errors.push(`schemaVersion 必须为 1（收到 ${JSON.stringify(raw.schemaVersion)}）`);
  }
  for (const key of Object.keys(raw)) {
    if (VANT_OWNED_KEYS.includes(key)) {
      errors.push(
        `字段 "${key}" 属于 Vant 组织层（.vant/config/project.json），v-cli.json 只允许 CLI 能力/适配器绑定`,
      );
    } else if (key === "__proto__" || key === "prototype" || key === "constructor") {
      errors.push(`配置含危险键 "${key}"，拒绝`);
    } else if (!["schemaVersion", "bindings"].includes(key)) {
      errors.push(`未知字段 "${key}"（v-cli.json 只允许 schemaVersion / bindings）`);
    }
  }
  const bindings = raw.bindings;
  if (!isPlainObject(bindings)) {
    errors.push("bindings 必须是对象");
    return errors;
  }
  for (const key of Object.keys(bindings)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      errors.push(`bindings 含危险键 "${key}"，拒绝`);
    } else if (!/^[a-z][a-z0-9-]*$/.test(key)) {
      errors.push(`未知 binding "${key}"（必须是已注册 Provider 的 id）`);
    } else if (!isPlainObject(bindings[key])) {
      errors.push(`bindings."${key}" 必须是对象`);
    }
  }
  return errors;
}

/** 已注册 Provider 集合（绑定校验的输入；Map<providerId, provider>） */
export type ProviderSet = Map<string, CapabilityProvider>;

export function toProviderSet(providers: Iterable<CapabilityProvider>): ProviderSet {
  const set: ProviderSet = new Map();
  for (const provider of providers) {
    if (set.has(provider.id)) {
      throw new Error(`Provider 集合含重复 id "${provider.id}"（拒绝 last-wins 静默覆盖）`);
    }
    set.set(provider.id, provider);
  }
  return set;
}

export interface ResolvedProviderBinding {
  providerId: string;
  /** Provider 语义归一后的绑定段（缺省为原始段） */
  section: Record<string, unknown>;
  dirs: Record<string, string>;
  files: Record<string, string>;
  warnings: string[];
}

/**
 * 解析并强核对全部绑定段（核心安全闸门）：
 * - 未知 Provider 的绑定段 → 错误（fail-closed）；
 * - Provider.resolve 抛错/返回错误/返回畸形 → 错误；
 * - 路径字段强核对：核心从 raw[field] 自行 resolveInsideProject 重解析，
 *   与 resolve 返回的 dirs/files 逐一字符串比对（基准 .path）；resolve 夹带
 *   未声明的 dirs/files 键、或声明字段缺解析结果 → 错误；
 * - 非 required 路径字段缺失为合法（不得出现在 dirs/files）；
 * - 路径违规不抛出中断：记入错误列表并置 pathUnsafe=true（保留其余已发现错误）。
 */
export function resolveBindings(
  project: ProjectRoot,
  config: ProjectCliConfig,
  providers: ProviderSet,
): { ok: true; bindings: Record<string, ResolvedProviderBinding> } | { ok: false; errors: string[]; pathUnsafe: boolean } {
  const errors: string[] = [];
  const pathUnsafeErrors: string[] = [];
  const result: Record<string, ResolvedProviderBinding> = {};
  const notePathError = (err: unknown): void => {
    pathUnsafeErrors.push(err instanceof PathSafetyError ? err.message : String(err));
  };

  for (const [providerId, rawSection] of Object.entries(config.bindings)) {
    const at = `bindings.${providerId}`;
    const provider = providers.get(providerId);
    if (!provider) {
      const known = [...providers.keys()].sort().join(", ") || "（无已注册 Provider）";
      errors.push(`未知 Provider 绑定 "${providerId}"（已注册: ${known}）`);
      continue;
    }
    const schemaErrors = validateValue(rawSection, provider.binding.schema, at);
    errors.push(...schemaErrors);
    if (schemaErrors.length > 0) continue;

    let resolution: ProviderBindingResolutionOk;
    try {
      const outcome = provider.binding.resolve({ project, raw: rawSection, resolveInsideProject });
      if (!isPlainObject(outcome) || outcome.ok !== true) {
        const detail =
          isPlainObject(outcome) && Array.isArray(outcome.errors)
            ? `（${(outcome.errors as unknown[]).map(String).join("；")}）`
            : "";
        errors.push(`${at} 绑定校验失败${detail}`);
        continue;
      }
      resolution = outcome;
    } catch (err) {
      // 路径违规（绝对路径/穿越/链接越界）记入 pathUnsafe（归类 unsafe-binding），不中断其余校验
      if (err instanceof PathSafetyError) {
        notePathError(err);
        continue;
      }
      errors.push(`${at} 绑定校验抛出异常: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // 强核对：dirs/files 只含声明过的路径字段，且与核心重解析结果一致
    const declared = new Map(provider.binding.pathFields.map((f) => [f.field, f]));
    let malformedMaps = false;
    for (const mapName of ["dirs", "files"] as const) {
      const reported = resolution[mapName];
      if (!isPlainObject(reported)) {
        errors.push(`${at}.${mapName} 必须是对象`);
        malformedMaps = true;
        continue;
      }
      for (const key of Object.keys(reported)) {
        const field = declared.get(key);
        if (!field) {
          errors.push(`${at}.${mapName} 含未声明的路径字段 "${key}"`);
        } else if (field.kind !== (mapName === "dirs" ? "dir" : "file")) {
          errors.push(`${at}.${mapName} 的字段 "${key}" 与声明的 kind (${field.kind}) 不符`);
        } else if (typeof reported[key] !== "string") {
          errors.push(`${at}.${mapName}."${key}" 必须是字符串路径`);
        }
      }
    }
    if (!malformedMaps) {
      for (const field of provider.binding.pathFields) {
        const rawValue = (rawSection as Record<string, unknown>)[field.field];
        const expected = resolution[field.kind === "dir" ? "dirs" : "files"][field.field];
        if (rawValue === undefined) {
          if (field.required) {
            errors.push(`${at}.${field.field} 是必填路径字段但缺失`);
          } else if (expected !== undefined) {
            errors.push(`${at}.${field.field} 未提供却出现在解析结果中`);
          }
          continue;
        }
        if (typeof rawValue !== "string") {
          errors.push(`${at}.${field.field} 必须是字符串路径`);
          continue;
        }
        if (expected === undefined) {
          errors.push(`${at}.${field.field} 已提供但缺少解析结果`);
          continue;
        }
        // 强核对的路径违规记入 pathUnsafe（归类 unsafe-binding），不中断其余校验
        try {
          const coreResolved = resolveInsideProject(project, rawValue, `${at}.${field.field}`);
          if (coreResolved.path !== expected) {
            errors.push(
              `${at}.${field.field} 解析不一致：核心解析为 ${coreResolved.path}，Provider 返回 ${expected}`,
            );
          }
        } catch (err) {
          if (err instanceof PathSafetyError) {
            notePathError(err);
          } else {
            throw err;
          }
        }
      }
    }
    if (errors.length > 0 || pathUnsafeErrors.length > 0) continue;

    result[providerId] = {
      providerId,
      section: isPlainObject(resolution.section) ? resolution.section : (rawSection as Record<string, unknown>),
      dirs: resolution.dirs,
      files: resolution.files,
      warnings: Array.isArray(resolution.warnings) ? resolution.warnings.map(String) : [],
    };
  }

  if (errors.length > 0 || pathUnsafeErrors.length > 0) {
    return { ok: false, errors: [...pathUnsafeErrors, ...errors], pathUnsafe: pathUnsafeErrors.length > 0 };
  }
  return { ok: true, bindings: result };
}

export type LoadProjectConfigResult =
  | {
      ok: true;
      file: string;
      config: ProjectCliConfig;
      /** Provider ID -> 已解析绑定（含安全路径与语义段） */
      resolved: Record<string, ResolvedProviderBinding>;
      /** 已注册但配置未声明绑定的 Provider id */
      unbound: string[];
    }
  | {
      ok: false;
      file: string;
      kind: "missing" | "invalid" | "unsafe-binding";
      errors: string[];
      hint: string;
    };

/** 读取并校验工程级 v-cli 配置（外壳 + 各 Provider 绑定契约 + 路径强核对） */
export function loadProjectConfig(project: ProjectRoot, providers: ProviderSet): LoadProjectConfigResult {
  const file = path.join(project.root, ...PROJECT_CLI_CONFIG_RELATIVE.split("/"));
  const initHint = `请先在工程根运行 \`v-cli project init --project <工程根>\` 生成 ${PROJECT_CLI_CONFIG_RELATIVE}`;

  let text: string;
  try {
    resolveInsideProject(project, PROJECT_CLI_CONFIG_RELATIVE, PROJECT_CLI_CONFIG_RELATIVE);
    text = fs.readFileSync(file, "utf-8");
  } catch (err) {
    if (err instanceof Error && "code" in err && String(err.code).startsWith("path-")) {
      return { ok: false, file, kind: "unsafe-binding", errors: [err.message], hint: "配置文件必须位于工程根内，禁止符号链接" };
    }
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, file, kind: "missing", errors: [], hint: initHint };
    }
    return {
      ok: false,
      file,
      kind: "invalid",
      errors: [`无法读取配置文件 ${file}: ${err instanceof Error ? err.message : String(err)}`],
      hint: "请检查配置文件权限后重试",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      file,
      kind: "invalid",
      errors: [`不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`],
      hint: "请修正配置文件内容后重试",
    };
  }

  const shellErrors = validateProjectCliConfig(parsed);
  if (shellErrors.length > 0) {
    return {
      ok: false,
      file,
      kind: "invalid",
      errors: shellErrors,
      hint: "请修正配置文件内容后重试（不要在此文件写 Vant 角色/workflow）",
    };
  }
  const config = parsed as ProjectCliConfig;

  const resolvedBindings = resolveBindings(project, config, providers);
  if (!resolvedBindings.ok) {
    return {
      ok: false,
      file,
      kind: resolvedBindings.pathUnsafe ? "unsafe-binding" : "invalid",
      errors: resolvedBindings.errors,
      hint: resolvedBindings.pathUnsafe
        ? "绑定路径越界或指向链接，已被拒绝"
        : "请按各 Provider 的绑定契约修正 bindings（已声明的无效绑定整体拒绝）",
    };
  }
  const unbound = [...providers.keys()].filter((id) => !(id in config.bindings));
  return { ok: true, file, config, resolved: resolvedBindings.bindings, unbound };
}

export interface RenderedConfig {
  content: string;
  bytes: number;
  sha256: string;
}

/** 生成配置内容（确定性）：外壳 + 各 Provider 默认段（overrides 为完整段替换） */
export function renderProjectConfig(
  project: ProjectRoot,
  providers: Iterable<CapabilityProvider>,
  overrides: Record<string, Record<string, unknown>> = {},
): RenderedConfig & { warnings: string[]; bindings: Record<string, unknown> } {
  const bindings: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const provider of providers) {
    const override = overrides[provider.id];
    if (override !== undefined) {
      bindings[provider.id] = override;
      continue;
    }
    if (!provider.defaultBinding) continue;
    const rendered = provider.defaultBinding(project);
    bindings[provider.id] = rendered.section;
    warnings.push(...rendered.warnings);
  }
  const config: ProjectCliConfig = { schemaVersion: 1, bindings };
  const content = `${JSON.stringify(config, null, 2)}\n`;
  return {
    content,
    bytes: Buffer.byteLength(content, "utf-8"),
    sha256: createHash("sha256").update(content, "utf-8").digest("hex"),
    warnings,
    bindings,
  };
}

export type InitProjectConfigResult =
  | {
      ok: true;
      action: "created";
      file: string;
      relativeFile: string;
      bytes: number;
      sha256: string;
      projectRoot: string;
      /** 生成的绑定段（provider id -> section） */
      bindings: Record<string, unknown>;
      /** 只读提示：检测到的 Vant 配置文件（v-cli 不修改） */
      vantConfig: { file: string; exists: boolean };
      warnings: string[];
    }
  | {
      ok: false;
      action: "refused";
      file: string;
      relativeFile: string;
      projectRoot: string;
      reason: string;
      vantConfig: { file: string; exists: boolean };
    };

/**
 * 初始化 .vant/config/v-cli.json：已存在一律拒绝（不提供 --force），
 * 不触碰 .vant/config/project.json。绑定段 = 有 defaultBinding 的 Provider 的
 * 默认段，可被 overrides 完整替换（provider id -> 绑定段）；写入前做全量校验。
 */
export function initProjectConfig(
  project: ProjectRoot,
  providers: ProviderSet,
  overrides: Record<string, Record<string, unknown>> = {},
): InitProjectConfigResult {
  const file = path.join(project.root, ...PROJECT_CLI_CONFIG_RELATIVE.split("/"));
  const vantFile = path.join(project.root, ...VANT_PROJECT_CONFIG_RELATIVE.split("/"));
  const vantConfig = { file: vantFile, exists: fs.existsSync(vantFile) };

  if (fs.existsSync(file)) {
    return {
      ok: false,
      action: "refused",
      file,
      relativeFile: PROJECT_CLI_CONFIG_RELATIVE,
      projectRoot: project.root,
      reason: `已存在 ${PROJECT_CLI_CONFIG_RELATIVE}：project init 不覆盖已有配置（如需修改请手工编辑）`,
      vantConfig,
    };
  }

  const unknownOverrides = Object.keys(overrides).filter((id) => !providers.has(id));
  if (unknownOverrides.length > 0) {
    const known = [...providers.keys()].sort().join(", ") || "（无已注册 Provider）";
    return {
      ok: false,
      action: "refused",
      file,
      relativeFile: PROJECT_CLI_CONFIG_RELATIVE,
      projectRoot: project.root,
      reason: `未知 Provider 绑定覆盖: ${unknownOverrides.join(", ")}（已注册: ${known}）`,
      vantConfig,
    };
  }

  const rendered = renderProjectConfig(project, providers.values(), overrides);
  const candidate = JSON.parse(rendered.content) as ProjectCliConfig;
  const shellErrors = validateProjectCliConfig(candidate);
  const bindingResult = resolveBindings(project, candidate, providers);
  const bindingErrors = bindingResult.ok ? [] : bindingResult.errors;
  const allErrors = [...shellErrors, ...bindingErrors];
  if (allErrors.length > 0) {
    return {
      ok: false,
      action: "refused",
      file,
      relativeFile: PROJECT_CLI_CONFIG_RELATIVE,
      projectRoot: project.root,
      reason: `生成的配置未通过校验: ${allErrors.join("；")}`,
      vantConfig,
    };
  }

  // 目录链安全：.vant / config 已存在时不得是越界符号链接
  const configDir = path.join(project.root, ".vant", "config");
  resolveInsideProject(project, ".vant/config", ".vant/config");
  fs.mkdirSync(configDir, { recursive: true });

  // wx：绝不覆盖（与上面的存在性检查双保险）
  fs.writeFileSync(file, rendered.content, { encoding: "utf-8", flag: "wx" });

  return {
    ok: true,
    action: "created",
    file,
    relativeFile: PROJECT_CLI_CONFIG_RELATIVE,
    bytes: rendered.bytes,
    sha256: rendered.sha256,
    projectRoot: project.root,
    bindings: candidate.bindings,
    vantConfig,
    warnings: rendered.warnings,
  };
}

export interface ProjectInspection {
  projectRoot: string;
  realRoot: string;
  config: {
    file: string;
    relativeFile: string;
    exists: boolean;
    valid: boolean;
    kind: "ok" | "missing" | "invalid" | "unsafe-binding";
    errors: string[];
    hint: string | null;
    schemaVersion: number | null;
    bindings: Record<string, unknown>;
    /** 按注册集合逐 Provider 的绑定状态（与运行期同一入口） */
    providerBindings: Array<{
      providerId: string;
      state: "bound" | "missing-binding" | "invalid";
      dirs: Record<string, string>;
      files: Record<string, string>;
      warnings: string[];
      errors: string[];
    }>;
  };
  vant: {
    dir: string;
    exists: boolean;
    configFiles: string[];
    projectConfigFile: string;
    projectConfigExists: boolean;
  };
  state: {
    dir: string;
    exists: boolean;
    operationCount: number;
  };
  initHint: string;
}

/** 只读检查：不执行任何工具，不写任何文件；检查面与当前注册 Provider 集合一致 */
export function inspectProject(project: ProjectRoot, providers: ProviderSet): ProjectInspection {
  const loaded = loadProjectConfig(project, providers);
  const providerBindings: ProjectInspection["config"]["providerBindings"] = [];

  if (loaded.ok) {
    for (const [providerId, resolved] of Object.entries(loaded.resolved)) {
      providerBindings.push({
        providerId,
        state: "bound",
        dirs: resolved.dirs,
        files: resolved.files,
        warnings: resolved.warnings,
        errors: [],
      });
    }
    for (const providerId of loaded.unbound) {
      providerBindings.push({
        providerId,
        state: "missing-binding",
        dirs: {},
        files: {},
        warnings: [],
        errors: [`bindings."${providerId}" 缺失：该 Provider 的能力将在运行期因前置条件失败`],
      });
    }
  } else if (loaded.kind === "invalid" || loaded.kind === "unsafe-binding") {
    // 配置不可整体解析时，逐 Provider 尽力归因（按完整段精确匹配；无法归因的归全局错误）
    let rawBindings: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(loaded.file, "utf-8")) as unknown;
      if (isPlainObject(parsed) && isPlainObject(parsed.bindings)) rawBindings = parsed.bindings;
    } catch {
      // 整体不可解析：全部按 invalid 归因到全局错误
    }
    for (const providerId of providers.keys()) {
      const raw = rawBindings[providerId];
      // 精确段匹配：bindings.<id> 或 bindings.<id>.…（按 id 完整边界，避免前缀碰撞）
      const pattern = new RegExp(`^bindings\\.${providerId}(?:\\.|$)`);
      const attributed = loaded.errors.filter((e) => pattern.test(e));
      const globalErrors = loaded.errors.filter((e) => !/^bindings\.[a-z][a-z0-9-]*(?:\.|$)/.test(e));
      if (raw === undefined) {
        providerBindings.push({
          providerId,
          state: "missing-binding",
          dirs: {},
          files: {},
          warnings: [],
          errors: [
            `bindings."${providerId}" 缺失：该 Provider 的能力将在运行期因前置条件失败`,
            ...globalErrors,
          ],
        });
      } else {
        providerBindings.push({
          providerId,
          state: "invalid",
          dirs: {},
          files: {},
          warnings: [],
          errors: attributed.length > 0 ? attributed : ["配置整体无效（无法归因到本 Provider 的段）", ...globalErrors],
        });
      }
    }
    for (const id of Object.keys(rawBindings)) {
      if (providers.has(id)) continue;
      providerBindings.push({
        providerId: id,
        state: "invalid",
        dirs: {},
        files: {},
        warnings: [],
        errors: [`未知 Provider 绑定 "${id}"（不在当前注册集合内）`],
      });
    }
  } else {
    // 配置缺失：按注册集合全部报告 missing-binding（保持"检查面与注册集合一致"）
    for (const providerId of providers.keys()) {
      providerBindings.push({
        providerId,
        state: "missing-binding",
        dirs: {},
        files: {},
        warnings: [],
        errors: [`配置文件 ${PROJECT_CLI_CONFIG_RELATIVE} 缺失：请先 project init`],
      });
    }
  }

  const vantDir = path.join(project.root, ".vant");
  let configFiles: string[] = [];
  const configDir = path.join(vantDir, "config");
  if (fs.existsSync(configDir)) {
    try {
      configFiles = fs.readdirSync(configDir).sort();
    } catch {
      configFiles = [];
    }
  }
  const stateDir = path.join(project.root, ...OPERATIONS_RELATIVE.split("/"));
  let operationCount = 0;
  if (fs.existsSync(stateDir)) {
    try {
      operationCount = fs.readdirSync(stateDir).filter((name) => fs.statSync(path.join(stateDir, name)).isDirectory()).length;
    } catch {
      operationCount = 0;
    }
  }
  const vantFile = path.join(project.root, ...VANT_PROJECT_CONFIG_RELATIVE.split("/"));

  let bindingsValue: Record<string, unknown> = {};
  if (loaded.ok) bindingsValue = loaded.config.bindings;

  return {
    projectRoot: project.root,
    realRoot: project.realRoot,
    config: {
      file: loaded.file,
      relativeFile: PROJECT_CLI_CONFIG_RELATIVE,
      exists: loaded.ok || loaded.kind !== "missing",
      valid: loaded.ok,
      kind: loaded.ok ? "ok" : loaded.kind,
      errors: loaded.ok ? [] : loaded.errors,
      hint: loaded.ok ? null : loaded.hint,
      schemaVersion: loaded.ok ? loaded.config.schemaVersion : null,
      bindings: bindingsValue,
      providerBindings,
    },
    vant: {
      dir: vantDir,
      exists: fs.existsSync(vantDir),
      configFiles,
      projectConfigFile: vantFile,
      projectConfigExists: fs.existsSync(vantFile),
    },
    state: {
      dir: stateDir,
      exists: fs.existsSync(stateDir),
      operationCount,
    },
    initHint: `v-cli project init --project ${project.root}`,
  };
}
