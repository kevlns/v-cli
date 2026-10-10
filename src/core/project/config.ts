/**
 * 工程级 v-cli 配置：.vant/config/v-cli.json
 *
 * 职责分离（硬边界，测试覆盖）：
 * - 本文件只写 CLI 能力/适配器绑定（当前：unity 的工程目录、版本钉扎、默认测试模式）。
 * - 角色 / workflow / 项目组织属于 Vant 的 .vant/config/project.json，v-cli 既不读也不写；
 *   配置里出现这类字段会被明确拒绝（单一真源，不做双份配置）。
 * - 无配置文件时不猜测：报错并给出 `v-cli project init` 初始化指引。
 * - project init 绝不覆盖已有配置；也绝不改动任何 Vant 配置文件。
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolveInsideProject, type ProjectRoot } from "./paths";

export const PROJECT_CLI_CONFIG_RELATIVE = ".vant/config/v-cli.json";
/** Vant 组织层配置：v-cli 只做只读提示，永不写入 */
export const VANT_PROJECT_CONFIG_RELATIVE = ".vant/config/project.json";
export const OPERATIONS_RELATIVE = ".vant/state/operations";

/** 属于 Vant 组织层职责、不允许出现在 v-cli.json 的顶层键 */
const VANT_OWNED_KEYS = ["roles", "role", "workflow", "workflows", "pipeline", "stages", "organization", "org", "project", "teams"];

export type UnityTestMode = "EditMode" | "PlayMode";

export interface UnityBinding {
  /** 相对工程根的 Unity 工程目录（"." 表示工程根自身） */
  projectDir: string;
  /** 可选：钉扎 Editor 版本（doctor 返回不一致即前置条件不满足） */
  editorVersion?: string;
  /** 可选：test-start 未显式传 mode 时的默认值 */
  testMode?: UnityTestMode;
}

export interface ProjectCliConfig {
  schemaVersion: 1;
  bindings: {
    unity?: UnityBinding;
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 校验配置对象（严格：未知字段一律拒绝，避免双份真源） */
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
    if (key !== "unity") errors.push(`未知 binding "${key}"（当前仅支持 unity）`);
  }
  if (bindings.unity !== undefined) {
    const unity = bindings.unity;
    if (!isPlainObject(unity)) {
      errors.push("bindings.unity 必须是对象");
    } else {
      if (typeof unity.projectDir !== "string" || unity.projectDir.length === 0) {
        errors.push("bindings.unity.projectDir 必须是非空字符串（相对工程根）");
      }
      if (unity.editorVersion !== undefined && (typeof unity.editorVersion !== "string" || unity.editorVersion.length === 0)) {
        errors.push("bindings.unity.editorVersion 出现时必须是字符串");
      }
      if (unity.testMode !== undefined && unity.testMode !== "EditMode" && unity.testMode !== "PlayMode") {
        errors.push('bindings.unity.testMode 出现时必须是 "EditMode" 或 "PlayMode"');
      }
      for (const key of Object.keys(unity)) {
        if (!["projectDir", "editorVersion", "testMode"].includes(key)) {
          errors.push(`bindings.unity 含未知字段 "${key}"`);
        }
      }
    }
  }
  return errors;
}

export type LoadProjectConfigResult =
  | {
      ok: true;
      file: string;
      config: ProjectCliConfig;
      /** binding 名 -> 已解析并做越界检查的绝对目录 */
      bindingDirs: Record<string, string>;
    }
  | {
      ok: false;
      file: string;
      kind: "missing" | "invalid" | "unsafe-binding";
      errors: string[];
      hint: string;
    };

/** 读取并校验工程级 v-cli 配置；binding 目录做路径越界与符号链接检查 */
export function loadProjectConfig(project: ProjectRoot): LoadProjectConfigResult {
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
    return { ok: false, file, kind: "missing", errors: [], hint: initHint };
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

  const errors = validateProjectCliConfig(parsed);
  if (errors.length > 0) {
    return { ok: false, file, kind: "invalid", errors, hint: "请修正配置文件内容后重试（不要在此文件写 Vant 角色/workflow）" };
  }
  const config = parsed as ProjectCliConfig;

  const bindingDirs: Record<string, string> = {};
  const unity = config.bindings.unity;
  if (unity) {
    const declared = unity.projectDir;
    if (declared === ".") {
      bindingDirs.unity = project.root;
    } else {
      try {
        const resolved = resolveInsideProject(project, declared, "bindings.unity.projectDir");
        bindingDirs.unity = resolved.path;
      } catch (err) {
        return {
          ok: false,
          file,
          kind: "unsafe-binding",
          errors: [err instanceof Error ? err.message : String(err)],
          hint: "bindings.unity.projectDir 必须是工程根内的相对路径（禁止绝对路径、.. 与符号链接越界）",
        };
      }
    }
  }

  return { ok: true, file, config, bindingDirs };
}

export interface RenderedConfig {
  content: string;
  bytes: number;
  sha256: string;
}

/** 生成默认配置内容（确定性；给 init 与测试共用） */
export function renderDefaultConfig(options: { unityProjectDir?: string; editorVersion?: string; testMode?: UnityTestMode } = {}): RenderedConfig {
  const unity: Record<string, unknown> = {
    projectDir: options.unityProjectDir ?? "Client",
  };
  if (options.editorVersion) unity.editorVersion = options.editorVersion;
  if (options.testMode) unity.testMode = options.testMode;
  const config = { schemaVersion: 1, bindings: { unity } };
  const content = `${JSON.stringify(config, null, 2)}\n`;
  return {
    content,
    bytes: Buffer.byteLength(content, "utf-8"),
    sha256: createHash("sha256").update(content, "utf-8").digest("hex"),
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
 * 不触碰 .vant/config/project.json。
 */
export function initProjectConfig(
  project: ProjectRoot,
  options: { unityProjectDir?: string; editorVersion?: string; testMode?: UnityTestMode } = {},
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

  // 目录链安全：.vant / config 已存在时不得是越界符号链接
  const candidate = JSON.parse(renderDefaultConfig(options).content);
  const optionErrors = validateProjectCliConfig(candidate);
  if (optionErrors.length) throw new Error(optionErrors.join("；"));
  if (candidate.bindings.unity.projectDir !== ".") {
    resolveInsideProject(project, candidate.bindings.unity.projectDir, "bindings.unity.projectDir");
  }
  const configDir = path.join(project.root, ".vant", "config");
  resolveInsideProject(project, ".vant/config", ".vant/config");
  fs.mkdirSync(configDir, { recursive: true });

  const rendered = renderDefaultConfig({
    unityProjectDir: options.unityProjectDir,
    editorVersion: options.editorVersion,
    testMode: options.testMode,
  });
  // wx：绝不覆盖（与上面的存在性检查双保险）
  fs.writeFileSync(file, rendered.content, { encoding: "utf-8", flag: "wx" });

  const warnings: string[] = [];
  const unityDir = options.unityProjectDir ?? "Client";
  if (unityDir !== ".") {
    const declared = path.join(project.root, unityDir);
    if (!fs.existsSync(declared)) {
      warnings.push(
        `bindings.unity.projectDir="${unityDir}" 当前不存在：请按工程实际目录修改 ${PROJECT_CLI_CONFIG_RELATIVE}`,
      );
    }
  } else {
    const versionFile = path.join(project.root, "ProjectSettings", "ProjectVersion.txt");
    if (!fs.existsSync(versionFile)) {
      warnings.push("工程根缺少 ProjectSettings/ProjectVersion.txt：请确认这是 Unity 工程目录");
    }
  }

  return {
    ok: true,
    action: "created",
    file,
    relativeFile: PROJECT_CLI_CONFIG_RELATIVE,
    bytes: rendered.bytes,
    sha256: rendered.sha256,
    projectRoot: project.root,
    vantConfig,
    warnings,
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
    bindingDirs: Record<string, string>;
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

/** 只读检查：不执行任何工具，不写任何文件 */
export function inspectProject(project: ProjectRoot): ProjectInspection {
  const loaded = loadProjectConfig(project);
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
      bindings: loaded.ok ? (loaded.config.bindings as Record<string, unknown>) : {},
      bindingDirs: loaded.ok ? loaded.bindingDirs : {},
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
