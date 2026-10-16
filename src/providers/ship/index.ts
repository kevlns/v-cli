import fs from "node:fs";
import {
  projectCommandProvider,
  type CommandDefinition,
  type CommandProviderDeps,
} from "../command-provider";
import { resolveInsideProject } from "../../core/project/paths";
import type { JsonSchema } from "../../core/execution/types";
const text: JsonSchema = { type: "string", minLength: 1 };
const bool: JsonSchema = { type: "boolean" };
const result = (
  fields: Record<string, JsonSchema>,
  required = Object.keys(fields),
): JsonSchema => ({
  type: "object",
  properties: fields,
  required,
  additionalProperties: true,
});
const ok = { ok: { type: "boolean" as const } };
const commands: Omit<CommandDefinition, "args">[] = [
  ...["steam", "wx"].map((platform): Omit<CommandDefinition, "args"> => ({
    id: platform + "-open",
    command: [platform, "open"],
    description: "打开平台管理页面",
    fields: {},
    dispatch: true,
    result: result({ dispatched: bool }),
    verify: (r) => r.dispatched === true,
  })),
  {
    id: "doctor",
    command: ["doctor"],
    description: "诊断游戏分发环境",
    fields: {},
    readonly: true,
    result: result({ checks: { type: "array" } }),
    verify: (r) =>
      Array.isArray(r.checks) &&
      (r.checks as { status?: unknown }[]).every(
        (x) =>
          x !== null &&
          typeof x === "object" &&
          ["ok", "warn", "skip"].includes(String(x.status)),
      ),
  },
  {
    id: "config-init",
    command: ["config", "init"],
    description: "创建游戏分发配置",
    fields: { force: bool },
    result: result({ written: text, force: bool }),
    verify: (r) => typeof r.written === "string" && fs.existsSync(r.written),
  },
  {
    id: "config-validate",
    command: ["config", "validate"],
    description: "校验游戏分发配置",
    fields: {},
    readonly: true,
    result: result(ok),
    verify: (r) => r.ok === true,
  },
  {
    id: "config-show",
    command: ["config", "show"],
    description: "读取游戏分发配置",
    fields: {},
    readonly: true,
    result: result({ projectRoot: text }),
    verify: (r) => typeof r.projectRoot === "string",
  },
  {
    id: "steam-vdf",
    command: ["steam", "vdf"],
    description: "生成 Steam 构建清单",
    fields: { desc: text, "set-live": text, preview: bool },
    result: result({
      appBuild: text,
      depots: { type: "array" },
      preview: bool,
    }),
    verify: (r) => typeof r.appBuild === "string" && fs.existsSync(r.appBuild),
  },
  ...["preview", "push"].map((action): Omit<CommandDefinition, "args"> => ({
    id: `steam-${action}`,
    command: ["steam", action],
    description: action === "push" ? "上传 Steam 测试构建" : "预演 Steam 构建",
    fields: {
      desc: text,
      ...(action === "push"
        ? {
            "set-live": {
              type: "string",
              minLength: 1,
              pattern: "^(?!default$).+",
            } as JsonSchema,
          }
        : {}),
    },
    network: action === "push",
    machine: true,
    result: result({
      ...ok,
      mode: text,
      appId: { type: "integer" },
      buildId: { type: "string", nullable: true },
      logPath: text,
    }),
    verify: (r) =>
      r.ok === true &&
      r.mode === (action === "push" ? "build" : "preview (no upload)"),
  })),
  {
    id: "steam-test",
    command: ["steam", "test"],
    description: "校验 Steam 运行产物",
    fields: { "write-appid": bool },
    result: result(ok),
    verify: (r) => r.ok === true,
  },
  {
    id: "wx-validate",
    command: ["wx", "validate"],
    description: "校验微信小游戏包",
    fields: {},
    readonly: true,
    result: result(ok),
    verify: (r) => r.ok === true,
  },
  ...["preview", "push"].map((action): Omit<CommandDefinition, "args"> => ({
    id: `wx-${action}`,
    command: ["wx", action],
    description:
      action === "push" ? "上传微信小游戏开发版" : "生成微信小游戏预览二维码",
    fields: {
      desc: text,
      robot: { type: "integer", minimum: 1, maximum: 30 },
      ...(action === "push" ? { version: text } : { "qr-out": text }),
    },
    required: action === "push" ? ["version"] : [],
    network: true,
    machine: true,
    result: result({
      ...ok,
      mode: text,
      appid: text,
      robot: { type: "integer" },
      qrOut: { type: "string", nullable: true },
    }),
    verify: (r) =>
      r.ok === true &&
      r.mode === (action === "push" ? "upload" : "preview") &&
      (action !== "preview" ||
        (typeof r.qrOut === "string" && fs.existsSync(r.qrOut))),
  })),
];
const definitions: CommandDefinition[] = commands.map((d) => ({
  ...d,
  args: (input, ctx) => {
    if (d.dispatch) return [d.command[0] === "steam" ? "builds" : "mp"];
    const args = ["--project", ctx.bindingDirs.projectDir, "--json"];
    for (const [key, value] of Object.entries(input)) {
      if (value === false) continue;
      args.push(`--${key}`);
      if (value !== true)
        args.push(
          key === "qr-out"
            ? resolveInsideProject(
                ctx.projectAnchor,
                String(value),
                "ship.qr-out",
              ).path
            : String(value),
        );
    }
    return args;
  },
}));
export const createShipProvider = (deps: CommandProviderDeps) =>
  projectCommandProvider("ship", definitions, deps);
