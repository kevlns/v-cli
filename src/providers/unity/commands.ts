import {
  commandRegistrations,
  type CommandDefinition,
  type CommandProviderDeps,
} from "../command-provider";
import type { JsonSchema } from "../../core/execution/types";
const text: JsonSchema = { type: "string", minLength: 1 };
const flag: JsonSchema = { type: "boolean" };
const result = (fields: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  required: Object.keys(fields),
  properties: fields,
  additionalProperties: true,
});
const definitions: Omit<CommandDefinition, "args">[] = [
  {
    id: "routes",
    command: ["routes"],
    description: "读取 Unity 精确版本路由",
    fields: { editor: text },
    readonly: true,
    result: {
      type: "object",
      required: ["routes"],
      properties: { routes: { type: "array" } },
      additionalProperties: true,
    },
    verify: (r) => Array.isArray(r.routes),
  },
  {
    id: "cli-install",
    command: ["cli", "install"],
    description: "安装并校验 Unity CLI",
    fields: { editor: text, force: flag },
    machine: true,
    network: true,
    result: result({ cacheDir: text, results: { type: "array" } }),
    verify: (r) =>
      Array.isArray(r.results) &&
      r.results.length > 0 &&
      (r.results as { state?: unknown }[]).every(
        (x) =>
          x !== null &&
          typeof x === "object" &&
          ["valid", "downloaded"].includes(String(x.state)),
      ),
  },
  ...["pipeline-install", "setup"].map(
    (id): Omit<CommandDefinition, "args"> => ({
      id,
      command: id === "setup" ? ["setup"] : ["pipeline", "install"],
      description: "安装并校验 Unity Pipeline",
      engine: true,
      fields: {
        force: flag,
        "allow-running-editor": flag,
        "dry-run": flag,
        ...(id === "setup" ? { "skip-cli": flag } : {}),
      },
      machine: true,
      network: id === "setup",
      result:
        id === "setup"
          ? result({
              install: {
                type: "object",
                required: ["status"],
                properties: { status: text },
                additionalProperties: true,
              },
            })
          : result({
              status: text,
              fileCount: { type: "integer", minimum: 1 },
            }),
      verify: (r) =>
        ["Installed", "AlreadyInstalled", "DryRun"].includes(
          String(
            id === "setup"
              ? (r.install as { status?: string })?.status
              : r.status,
          ),
        ),
    }),
  ),
  {
    id: "cache-clean",
    command: ["cache", "clean"],
    description: "清理 Unity 工具缓存",
    fields: { all: flag },
    machine: true,
    result: result({ cacheRoot: text, removed: { type: "array" } }),
    verify: (r) => Array.isArray(r.removed),
  },
];
export const unityCommandRegistrations = (deps: CommandProviderDeps) =>
  commandRegistrations(
    "unity",
    definitions.map((d) => ({
      ...d,
      args: (input, ctx) => {
        const args = ["pipeline-install", "setup"].includes(d.id)
          ? [ctx.bindingDirs.projectDir]
          : [];
        for (const [key, value] of Object.entries(input)) {
          if (value === false) continue;
          args.push(`--${key}`);
          if (value !== true) args.push(String(value));
        }
        return args;
      },
    })),
    deps,
  );
