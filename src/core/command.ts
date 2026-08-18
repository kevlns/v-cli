import type { Command } from "commander";
import type { CliContext } from "./context";
import { OFFICIAL_COMMAND_NAMES } from "./official";

/** 命令的自定义 agent 索引元数据（可选；builtin/local 均可携带） */
export interface CliAgentCommandMeta {
  path: string[];
  description: string;
  usage?: string;
  /** 位置参数（<name> 必需 / [name] 可选） */
  arguments?: { name: string; required: boolean; description: string }[];
  /** 选项（flags + 说明） */
  options?: { flags: string; description: string }[];
  /** 输出契约（格式 + 说明） */
  output?: { format: string; description: string };
  /** 退出码契约（code → 含义） */
  exitCodes?: Record<string, string>;
  /** 安全标签（read-only / 写路径 / fail-closed 语义等） */
  safety?: string[];
}

export interface CliAgentMeta {
  whenToUse?: string;
  globalOptions?: { flags: string; description: string }[];
  commands?: CliAgentCommandMeta[];
}

/** 命令契约：所有命令（内置或本地插件）需实现该接口 */
export interface CliCommand {
  name: string;
  description: string;
  hidden?: boolean;
  /** 插件契约版本：v-cli 0.2 起必须为 1 */
  apiVersion: 1;
  /** 供 `v-cli agent index/describe` 索引的自定义元数据 */
  agent?: CliAgentMeta;
  register(program: Command, ctx: CliContext): void;
}

/** 内置命令名 + help 保留名：本地/官方命令均不可占用 */
export const RESERVED_COMMAND_NAMES = ["doctor", "plugin", "ts", "agent", "help"] as const;

/** 校验对象是否符合 CliCommand 形状（本地插件加载用）；apiVersion===1 是契约一部分 */
export function isCliCommand(candidate: unknown): candidate is CliCommand {
  if (typeof candidate !== "object" || candidate === null) return false;
  const cmd = candidate as Partial<CliCommand>;
  return (
    cmd.apiVersion === 1 &&
    typeof cmd.name === "string" &&
    typeof cmd.description === "string" &&
    typeof cmd.register === "function"
  );
}

export interface LocalCommandValidation {
  ok: boolean;
  command?: CliCommand;
  errors: string[];
}

const NAME_RE = /^[a-z][a-z0-9-]*$/;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 校验 agent 元数据字段（可选字段，出现则必须类型正确） */
function validateAgentMeta(agent: unknown, errors: string[]): void {
  if (agent === undefined || agent === null) return;
  if (!isPlainObject(agent)) {
    errors.push("agent 必须是对象");
    return;
  }
  if (agent.whenToUse !== undefined && typeof agent.whenToUse !== "string") {
    errors.push("agent.whenToUse 必须是字符串");
  }
  if (agent.globalOptions !== undefined) {
    if (!Array.isArray(agent.globalOptions)) {
      errors.push("agent.globalOptions 必须是数组");
    } else {
      agent.globalOptions.forEach((o, i) => {
        if (!isPlainObject(o) || typeof o.flags !== "string" || typeof o.description !== "string") {
          errors.push(`agent.globalOptions[${i}] 必须是 {flags: string, description: string}`);
        }
      });
    }
  }
  if (agent.commands !== undefined) {
    if (!Array.isArray(agent.commands)) {
      errors.push("agent.commands 必须是数组");
    } else {
      agent.commands.forEach((c, i) => {
        const at = `agent.commands[${i}]`;
        if (!isPlainObject(c) || typeof c.description !== "string") {
          errors.push(`${at} 必须是含字符串 description 的对象`);
          return;
        }
        // path 必备：非空、且每段匹配命令名正则（agent describe/索引依赖它）
        if (!Array.isArray(c.path) || !isStringArray(c.path) || c.path.length === 0) {
          errors.push(`${at}.path 必须是非空字符串数组（每段匹配 ^[a-z][a-z0-9-]*$）`);
        } else if (c.path.some((seg) => !NAME_RE.test(seg))) {
          errors.push(`${at}.path 含非法段（每段须匹配 ^[a-z][a-z0-9-]*$）`);
        }
        if (c.usage !== undefined && typeof c.usage !== "string") {
          errors.push(`${at}.usage 必须是字符串`);
        }
        if (c.arguments !== undefined) {
          const bad =
            !Array.isArray(c.arguments) ||
            c.arguments.some(
              (a) =>
                !isPlainObject(a) ||
                typeof a.name !== "string" ||
                typeof a.required !== "boolean" ||
                typeof a.description !== "string",
            );
          if (bad) errors.push(`${at}.arguments 必须是 { name: string; required: boolean; description: string }[]`);
        }
        if (c.options !== undefined) {
          const bad =
            !Array.isArray(c.options) ||
            c.options.some((o) => !isPlainObject(o) || typeof o.flags !== "string" || typeof o.description !== "string");
          if (bad) errors.push(`${at}.options 必须是 { flags: string; description: string }[]`);
        }
        if (c.output !== undefined) {
          const bad =
            !isPlainObject(c.output) ||
            typeof c.output.format !== "string" ||
            typeof c.output.description !== "string";
          if (bad) errors.push(`${at}.output 必须是 { format: string; description: string }`);
        }
        if (c.exitCodes !== undefined) {
          const bad =
            !isPlainObject(c.exitCodes) ||
            Object.entries(c.exitCodes).some(([code, desc]) => typeof code !== "string" || typeof desc !== "string");
          if (bad) errors.push(`${at}.exitCodes 必须是 { [退出码: string]: string }`);
        }
        if (c.safety !== undefined && !isStringArray(c.safety)) {
          errors.push(`${at}.safety 必须是字符串数组`);
        }
      });
    }
  }
}

/**
 * 本地插件严格校验：apiVersion 必须为 1（旧插件给出解释性错误）、
 * 命令名合法且不被保留（内置/官方/已接受的本地产物）。
 */
export function validateLocalCommand(
  candidate: unknown,
  options: { existingNames?: readonly string[] } = {},
): LocalCommandValidation {
  const errors: string[] = [];
  if (!isPlainObject(candidate)) {
    return { ok: false, errors: ["插件导出必须是对象"] };
  }
  const cmd = candidate as Record<string, unknown>;

  if (cmd.apiVersion !== 1) {
    const got = cmd.apiVersion === undefined ? "缺失" : JSON.stringify(cmd.apiVersion);
    errors.push(
      `apiVersion 必须为 1（当前: ${got}）。v-cli 0.2 起采用 apiVersion 1 插件契约，旧版插件请补上 apiVersion: 1 后重新加载`,
    );
  }

  if (typeof cmd.name !== "string" || cmd.name.length === 0) {
    errors.push("name 必须是非空字符串");
  } else {
    if (!NAME_RE.test(cmd.name)) {
      errors.push(`命令名 "${cmd.name}" 不合法：只能是小写字母开头的 [a-z0-9-] 字符串`);
    }
    const reserved = [...RESERVED_COMMAND_NAMES, ...OFFICIAL_COMMAND_NAMES];
    if (reserved.includes(cmd.name)) {
      const kind = (RESERVED_COMMAND_NAMES as readonly string[]).includes(cmd.name)
        ? "v-cli 内置保留命令"
        : "官方插件命令";
      errors.push(`命令名 "${cmd.name}" 是${kind}，本地插件不能占用`);
    }
    if ((options.existingNames ?? []).includes(cmd.name)) {
      errors.push(`重复的命令名 "${cmd.name}"（已由其他本地插件定义）`);
    }
  }

  if (typeof cmd.description !== "string" || cmd.description.length === 0) {
    errors.push("description 必须是非空字符串");
  }
  if (typeof cmd.register !== "function") {
    errors.push("register 必须是函数");
  }
  validateAgentMeta(cmd.agent, errors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, command: candidate as unknown as CliCommand, errors: [] };
}