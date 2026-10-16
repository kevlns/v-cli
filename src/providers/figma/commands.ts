import {
  commandRegistrations,
  type CommandDefinition,
  type CommandProviderDeps,
} from "../command-provider";
import { resolveInsideProject } from "../../core/project/paths";
import type { JsonSchema } from "../../core/execution/types";
const text: JsonSchema = { type: "string", minLength: 1 };
const flag: JsonSchema = { type: "boolean" };
const result = (fields: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  required: Object.keys(fields),
  properties: fields,
  additionalProperties: true,
});
const commands: Omit<CommandDefinition, "args">[] = [
  {
    id: "agent-docs",
    command: ["agent", "docs"],
    description: "读取 Figma Agent 文档",
    fields: {},
    readonly: true,
    result: result({ bytes: { type: "integer", minimum: 1 }, content: text }),
    verify: (r) => typeof r.bytes === "number" && r.bytes > 0,
  },
  ...["setup", "config-init", "config-migrate"].map(
    (id): Omit<CommandDefinition, "args"> => ({
      id,
      command: id === "setup" ? ["setup"] : ["config", id.slice(7)],
      description: "配置 Figma 工程",
      fields: { force: flag },
      machine: true,
      result: result({ configPath: text, projectKey: text }),
      verify: (r) =>
        typeof r.configPath === "string" && typeof r.projectKey === "string",
    }),
  ),
  {
    id: "config-validate",
    command: ["config", "validate"],
    description: "校验 Figma 工程配置",
    fields: {},
    readonly: true,
    result: result({ valid: flag }),
    verify: (r) => r.valid === true,
  },
  {
    id: "export",
    command: ["export"],
    description: "导出 Figma 源清单与图片",
    fields: {
      fileKey: { type: "string", pattern: "^[A-Za-z0-9_-]+$" },
      "discovery-only": flag,
      "discovery-document": text,
      "node-documents": text,
      "image-scale": { type: "number", minimum: 0.01, maximum: 4 },
    },
    required: ["fileKey"],
    network: true,
    result: result({
      rootCount: { type: "integer", minimum: 0 },
      writtenFiles: { type: "array" },
    }),
    verify: (r) => typeof r.rootCount === "number" && r.rootCount > 0,
  },
  ...["install", "status", "uninstall"].map(
    (action): Omit<CommandDefinition, "args"> => ({
      id: `unity-${action}`,
      command: ["unity", action],
      description: `Figma Unity 转换器${action === "install" ? "安装" : action === "uninstall" ? "卸载" : "检查"}`,
      fields: action === "status" ? {} : { "dry-run": flag, force: flag },
      readonly: action === "status",
      result: result(
        action === "status"
          ? { installed: flag, modified: flag }
          : { status: text },
      ),
      verify: (r) =>
        action === "status"
          ? r.modified === false
          : typeof r.status === "string" && !/Rejected|Failed/.test(r.status),
    }),
  ),
  {
    id: "build",
    command: ["build"],
    description: "通过 Unity 转换器构建暂存预制体",
    engine: true,
    fields: { index: text, "allow-running-editor": flag },
    result: result({
      report: {
        type: "object",
        required: ["entries", "issues"],
        properties: {
          entries: { type: "array", minItems: 1 },
          issues: { type: "array" },
        },
        additionalProperties: true,
      },
      reportPath: text,
    }),
    verify: (r) => {
      const report = r.report as {
        entries?: { errorCode?: string }[];
        issues?: { severity?: string }[];
      };
      return (
        Array.isArray(report?.entries) &&
        report.entries.length > 0 &&
        report.entries.every((e) => !e.errorCode) &&
        Array.isArray(report.issues) &&
        report.issues.every((e) => e.severity !== "error")
      );
    },
  },
];
export function figmaCommandRegistrations(deps: CommandProviderDeps) {
  return commandRegistrations(
    "figma",
    commands.map((d) => ({
      ...d,
      args: (input, ctx) => {
        if (d.id === "agent-docs") return ["--json"];
        const args =
          d.id === "setup"
            ? [ctx.bindingDirs.projectDir]
            : ["--project", ctx.bindingDirs.projectDir];
        if (d.id === "export") args.unshift(String(input.fileKey));
        args.push("--json");
        for (const [key, value] of Object.entries(input)) {
          if (key === "fileKey" || value === false) continue;
          args.push(`--${key}`);
          if (value !== true)
            args.push(
              ["index", "discovery-document", "node-documents"].includes(key)
                ? resolveInsideProject(
                    ctx.projectAnchor,
                    String(value),
                    `figma.${key}`,
                  ).path
                : String(value),
            );
        }
        return args;
      },
    })),
    deps,
  );
}
