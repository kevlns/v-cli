/**
 * v-cli 插件清单（v-cli.plugin.json）校验器。
 *
 * 运行时权威校验器：规则与 schemas/v-cli-plugin.schema.json 对齐
 * （schema 供编辑器与文档使用；本文件是 v-cli 实际执行的等价规则）。
 * 返回结构化错误列表。身份校验（package/bin 与 package.json 一致）独立于
 * 清单本身，由调用方（官方插件发现）使用 validatePluginIdentity 完成。
 */

export interface AgentCommandMeta {
  path: string[];
  usage: string;
  description: string;
  arguments: { name: string; required: boolean; description: string }[];
  options: { flags: string; description: string }[];
  output: { format: string; description: string };
  exitCodes: Record<string, string>;
  safety: string[];
}

export interface AgentMeta {
  whenToUse: string;
  globalOptions: { flags: string; description: string }[];
  commands: AgentCommandMeta[];
}

export interface PluginManifest {
  schemaVersion: 1;
  package: string;
  command: string;
  bin: string;
  description: string;
  platforms: string[];
  runtime: Record<string, unknown>;
  environment: { name: string; description: string }[];
  agent: AgentMeta;
}

export type ManifestValidation =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; errors: string[] };

/** 内置命令名 + help：任何插件（官方或本地）都不允许占用 */
export const RESERVED_MANIFEST_COMMAND_NAMES = ["doctor", "plugin", "ts", "agent", "help"] as const;

export const KNOWN_PLATFORMS = ["darwin", "linux", "win32"] as const;

/** 与 schema 对齐：output.format 允许的枚举 */
export const OUTPUT_FORMATS = ["json", "stdout", "text"] as const;

const COMMAND_NAME_RE = /^[a-z][a-z0-9-]*$/;
const PACKAGE_NAME_RE = /^@[a-zA-Z0-9][a-zA-Z0-9._~-]*\/[a-zA-Z0-9][a-zA-Z0-9._~-]*$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** 校验清单对象；input 应为已经 JSON.parse 的结果 */
export function validateManifest(input: unknown): ManifestValidation {
  if (!isPlainObject(input)) {
    return { ok: false, errors: ["清单必须是 JSON 对象"] };
  }
  const errors: string[] = [];
  const m = input as Record<string, unknown>;

  // schemaVersion：必须是整数 1；未知 major（>=2）给解释性错误
  if (typeof m.schemaVersion !== "number" || !Number.isInteger(m.schemaVersion)) {
    errors.push("schemaVersion 必须是整数");
  } else if (m.schemaVersion === 1) {
    // OK
  } else if (m.schemaVersion >= 2) {
    errors.push(
      `schemaVersion ${m.schemaVersion} 不受支持：v-cli 0.2 仅支持契约版本 1 的清单，请升级插件或 v-cli`,
    );
  } else {
    errors.push("schemaVersion 必须为 1");
  }

  const requireString = (key: string): string | undefined => {
    const v = m[key];
    if (typeof v !== "string" || v.length === 0) {
      errors.push(`${key} 必须是非空字符串`);
      return undefined;
    }
    return v;
  };

  const packageName = requireString("package");
  if (typeof packageName === "string" && !PACKAGE_NAME_RE.test(packageName)) {
    errors.push("package 必须是 @scope/name 形式的 npm 包名");
  }

  const command = requireString("command");
  if (typeof command === "string") {
    if (!COMMAND_NAME_RE.test(command)) {
      errors.push(`command "${command}" 不合法：只能是小写字母开头的 [a-z0-9-] 字符串`);
    }
    if ((RESERVED_MANIFEST_COMMAND_NAMES as readonly string[]).includes(command)) {
      errors.push(
        `command "${command}" 是 v-cli 保留命令名（${RESERVED_MANIFEST_COMMAND_NAMES.join("/")}），插件不能占用`,
      );
    }
  }

  requireString("bin");
  requireString("description");

  // platforms
  if (!Array.isArray(m.platforms)) {
    errors.push("platforms 必须是字符串数组");
  } else if (m.platforms.length === 0) {
    errors.push("platforms 至少要声明一个平台");
  } else if (!isStringArray(m.platforms)) {
    errors.push("platforms 的元素必须是字符串");
  } else {
    const unknown = m.platforms.filter((p) => !(KNOWN_PLATFORMS as readonly string[]).includes(p));
    if (unknown.length > 0) {
      errors.push(`platforms 含未知平台: ${unknown.join(", ")}（仅支持 ${KNOWN_PLATFORMS.join("/")}）`);
    }
  }

  // runtime
  if (!isPlainObject(m.runtime)) {
    errors.push("runtime 必须是对象");
  }

  // environment
  if (!Array.isArray(m.environment)) {
    errors.push("environment 必须是数组");
  } else {
    m.environment.forEach((entry, i) => {
      if (!isPlainObject(entry)) {
        errors.push(`environment[${i}] 必须是对象`);
      } else {
        if (typeof entry.name !== "string" || entry.name.length === 0) {
          errors.push(`environment[${i}].name 必须是非空字符串`);
        }
        if (typeof entry.description !== "string" || entry.description.length === 0) {
          errors.push(`environment[${i}].description 必须是非空字符串`);
        }
      }
    });
  }

  // agent
  const agent = m.agent;
  if (!isPlainObject(agent)) {
    errors.push("agent 必须是对象");
  } else {
    if (typeof agent.whenToUse !== "string") {
      errors.push("agent.whenToUse 必须是字符串");
    }
    if (!Array.isArray(agent.globalOptions)) {
      errors.push("agent.globalOptions 必须是数组");
    } else {
      agent.globalOptions.forEach((o, i) => {
        if (!isPlainObject(o)) {
          errors.push(`agent.globalOptions[${i}] 必须是对象`);
        } else {
          if (typeof o.flags !== "string" || o.flags.length === 0) {
            errors.push(`agent.globalOptions[${i}].flags 必须是非空字符串`);
          }
          if (typeof o.description !== "string" || o.description.length === 0) {
            errors.push(`agent.globalOptions[${i}].description 必须是非空字符串`);
          }
        }
      });
    }
    if (!Array.isArray(agent.commands)) {
      errors.push("agent.commands 必须是数组");
    } else {
      const seenPaths = new Set<string>();
      agent.commands.forEach((c, i) => {
        const at = `agent.commands[${i}]`;
        if (!isPlainObject(c)) {
          errors.push(`${at} 必须是对象`);
          return;
        }
        if (!Array.isArray(c.path) || !isStringArray(c.path) || c.path.length === 0) {
          errors.push(`${at}.path 必须是非空字符串数组`);
        } else {
          const badSegment = c.path.find((seg) => !COMMAND_NAME_RE.test(seg));
          if (badSegment !== undefined) {
            errors.push(`${at}.path 含非法段 "${badSegment}"（每段须匹配 ^[a-z][a-z0-9-]*$）`);
          }
          const key = c.path.join(" ");
          if (seenPaths.has(key)) {
            errors.push(`${at}.path ${key} 与前面的命令重复`);
          }
          seenPaths.add(key);
        }
        if (typeof c.usage !== "string" || c.usage.length === 0) {
          errors.push(`${at}.usage 必须是非空字符串`);
        }
        if (typeof c.description !== "string" || c.description.length === 0) {
          errors.push(`${at}.description 必须是非空字符串`);
        }
        if (!Array.isArray(c.arguments)) {
          errors.push(`${at}.arguments 必须是数组`);
        } else {
          c.arguments.forEach((a, j) => {
            if (!isPlainObject(a)) {
              errors.push(`${at}.arguments[${j}] 必须是对象`);
            } else {
              if (typeof a.name !== "string" || a.name.length === 0) {
                errors.push(`${at}.arguments[${j}].name 必须是非空字符串`);
              }
              if (typeof a.required !== "boolean") {
                errors.push(`${at}.arguments[${j}].required 必须是布尔值`);
              }
              if (typeof a.description !== "string" || a.description.length === 0) {
                errors.push(`${at}.arguments[${j}].description 必须是非空字符串`);
              }
            }
          });
        }
        if (!Array.isArray(c.options)) {
          errors.push(`${at}.options 必须是数组`);
        } else {
          c.options.forEach((o, j) => {
            if (!isPlainObject(o)) {
              errors.push(`${at}.options[${j}] 必须是对象`);
            } else {
              if (typeof o.flags !== "string" || o.flags.length === 0) {
                errors.push(`${at}.options[${j}].flags 必须是非空字符串`);
              }
              if (typeof o.description !== "string" || o.description.length === 0) {
                errors.push(`${at}.options[${j}].description 必须是非空字符串`);
              }
            }
          });
        }
        if (!isPlainObject(c.output)) {
          errors.push(`${at}.output 必须是对象`);
        } else {
          if (
            typeof c.output.format !== "string" ||
            c.output.format.length === 0 ||
            !(OUTPUT_FORMATS as readonly string[]).includes(c.output.format)
          ) {
            errors.push(
              `${at}.output.format 必须是非空字符串且属于 [${OUTPUT_FORMATS.join(", ")}]`,
            );
          }
          if (typeof c.output.description !== "string" || c.output.description.length === 0) {
            errors.push(`${at}.output.description 必须是非空字符串`);
          }
        }
        if (!isPlainObject(c.exitCodes)) {
          errors.push(`${at}.exitCodes 必须是对象`);
        } else {
          const badExit = Object.values(c.exitCodes).find((v) => typeof v !== "string");
          if (badExit !== undefined) {
            errors.push(`${at}.exitCodes 的值必须是字符串`);
          }
        }
        if (!Array.isArray(c.safety) || !isStringArray(c.safety)) {
          errors.push(`${at}.safety 必须是字符串数组`);
        }
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, manifest: input as unknown as PluginManifest };
}

/**
 * 身份校验（区别于清单本身的 schema 校验）：清单与所在包的 package.json 是否一致。
 * errors 为空即通过。
 */
export function validatePluginIdentity(
  manifest: PluginManifest,
  pkgJson: { name?: unknown; bin?: unknown },
): string[] {
  const errors: string[] = [];
  if (manifest.package !== pkgJson.name) {
    errors.push(
      `清单 package "${manifest.package}" 与 package.json name "${String(pkgJson.name)}" 不一致`,
    );
  }
  const binKeys = isPlainObject(pkgJson.bin) ? Object.keys(pkgJson.bin) : [];
  if (!binKeys.includes(manifest.bin)) {
    errors.push(`清单 bin "${manifest.bin}" 不在 package.json bin (${binKeys.join(", ") || "空"}) 中`);
  }
  return errors;
}