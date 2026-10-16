import {
  OFFICIAL_PLUGINS,
  discoverOfficialPlugin,
  type OfficialPluginInfo,
} from "../core/official";
import { executionFromProcess } from "../core/execution/runtime";
import { structuredError } from "../core/execution/errors";
import { validateValue } from "../core/execution/json-schema";
import type { ProcessExecutor } from "../core/execution/executor";
import type {
  CapabilityProvider,
  CapabilityRegistration,
  JsonSchema,
  CapabilityExecutionContext,
  ExecutionLifecycle,
  AcceptanceStatus,
} from "../core/execution/types";

export interface CommandDefinition {
  id: string;
  description: string;
  command: string[];
  sourceCommands?: string[][];
  fields: Record<string, JsonSchema>;
  required?: string[];
  readonly?: boolean;
  network?: boolean;
  machine?: boolean;
  engine?: boolean;
  control?: boolean;
  dispatch?: boolean;
  result: JsonSchema;
  args(
    input: Record<string, unknown>,
    ctx: CapabilityExecutionContext,
  ): string[];
  verify(result: Record<string, unknown>): boolean;
  pending?(result: Record<string, unknown>): number | null;
  settlement?(result: Record<string, unknown>): {
    lifecycle: ExecutionLifecycle;
    acceptance: AcceptanceStatus;
    pending: boolean;
  };
}
export interface CommandProviderDeps {
  executor: ProcessExecutor;
  discoverBackend?: () => OfficialPluginInfo;
  env?: Record<string, string | undefined>;
}

/** 通用受控进程适配。命令、真实 schema 和业务验收由各工具适配器明确声明。 */
export function commandRegistrations(
  id: string,
  definitions: CommandDefinition[],
  deps: CommandProviderDeps,
): CapabilityRegistration[] {
  const discover =
    deps.discoverBackend ??
    (() =>
      discoverOfficialPlugin(OFFICIAL_PLUGINS.find((p) => p.command === id)!));
  return definitions.map((d) => ({
    descriptor: {
      id: `${id}.${d.id}`,
      version: "0.1.0",
      description: d.description,
      commands: d.sourceCommands ?? [d.command],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: d.fields,
        required: d.required ?? [],
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["result", "error"],
        properties: {
          result: { ...d.result, nullable: true },
          error: {
            type: "object",
            nullable: true,
            required: ["code", "message"],
            properties: {
              code: { type: "string" },
              message: { type: "string" },
            },
            additionalProperties: false,
          },
        },
      },
      preconditions: [
        { id: `${id}.binding`, description: "工具已安装且工程绑定有效" },
      ],
      sideEffects: [
        "process-exec",
        "fs-read",
        ...(!d.readonly ? ["fs-write"] : []),
        ...(d.network ? ["network"] : []),
      ].map((kind) => ({
        id: kind,
        kind: kind as "process-exec" | "fs-read" | "fs-write" | "network",
        description: d.description,
        reversible: kind === "fs-read",
      })),
      resources: d.control
        ? []
        : [
            {
              kind: "project-workspace",
              mode: d.readonly ? "shared" : "exclusive",
              scope: "project",
              description: "工程读写互斥",
            },
            ...(d.engine
              ? [
                  {
                    kind: "engine-editor" as const,
                    mode: "exclusive" as const,
                    scope: "project" as const,
                    description: "引擎操作互斥",
                  },
                ]
              : []),
            ...(d.machine
              ? [
                  {
                    kind: "user-cache" as const,
                    key: id,
                    mode: "exclusive" as const,
                    scope: "machine" as const,
                    description: "工具账号及用户缓存互斥",
                  },
                ]
              : []),
          ],
      retry: {
        safe: !!d.readonly,
        maxAttempts: 1,
        strategy: "none",
        description: "单次执行；写入或上传结果未知时先核实，不自动重放",
      },
    },
    implementation: {
      preconditions: {
        [`${id}.binding`]: (input, ctx) => {
          try {
            if (!ctx.binding || discover().status !== "available")
              throw Error("需要可用后端与工程绑定");
            if (d.pending && !ctx.persist)
              throw Error("后台服务必须保存操作记录，以便查询和停止");
            d.args(input, ctx);
            return {
              id: `${id}.binding`,
              status: "satisfied",
              detail: "后端、绑定和路径预检通过",
            };
          } catch (error) {
            return {
              id: `${id}.binding`,
              status: "violated",
              detail: error instanceof Error ? error.message : String(error),
            };
          }
        },
      },
      execute: async (input, ctx) => {
        const backend = discover();
        const args = [backend.bin!, ...d.command, ...d.args(input, ctx)];
        const outcome = await deps.executor.run({
          file: process.execPath,
          args,
          cwd: ctx.bindingDirs.projectDir ?? ctx.projectRoot,
          env: deps.env,
          signal: ctx.signal,
          timeoutMs: 30 * 60 * 1000,
        });
        const execution = executionFromProcess(outcome);
        const effects = [
          {
            kind: "process-exec" as const,
            description: "已执行受控工具进程",
            reversible: false,
          },
          {
            kind: "fs-read" as const,
            description: "读取工程配置与产物",
            reversible: true,
          },
          ...(!d.readonly
            ? [
                {
                  kind: "fs-write" as const,
                  description: "工具可能已写入文件或本地状态，详见回执",
                  reversible: false,
                },
              ]
            : []),
          ...(d.network
            ? [
                {
                  kind: "network" as const,
                  description: "工具可能已访问外部服务，详见回执",
                  reversible: false,
                },
              ]
            : []),
        ];

        let result: Record<string, unknown>;
        try {
          result = d.dispatch
            ? { dispatched: outcome.exitCode === 0 }
            : JSON.parse(outcome.stdout);
          if (
            !result ||
            typeof result !== "object" ||
            Array.isArray(result) ||
            outcome.stdoutTruncated
          )
            throw Error();
        } catch {
          return {
            execution: {
              ...execution,
              status: "failed",
              lifecycle:
                d.readonly && execution.lifecycle !== "unknown"
                  ? "failed"
                  : "unknown",
              error: structuredError(
                `${id}-output-invalid`,
                "protocol",
                "工具未返回完整 JSON，不能推断操作完成",
              ),
            },
            acceptance: {
              status: "not-run",
              reason: "结果不可验证；先核对原操作，禁止盲目重试",
            },
            sideEffects: effects,
            rawOutput: outcome,
            command: { file: process.execPath, args },
          };
        }
        let valid = validateValue(result, d.result, "$result").length === 0;
        let verified = false;
        if (valid) {
          try {
            verified = d.verify(result);
          } catch {
            valid = false;
          }
        }
        const passed = valid && execution.status === "succeeded" && verified;
        const owner = passed ? d.pending?.(result) : null;
        const settled = valid ? d.settlement?.(result) : undefined;
        return {
          execution: {
            ...execution,
            ...(!valid
              ? {
                  status: "unknown" as const,
                  lifecycle: "unknown" as const,
                  error: structuredError(
                    `${id}-output-invalid`,
                    "protocol",
                    "工具回执未通过 schema 校验",
                  ),
                }
              : {}),
            ...(owner ? { lifecycle: "accepted" as const } : {}),
            ...(settled
              ? {
                  lifecycle: settled.lifecycle,
                  ...(settled.lifecycle === "cancelled"
                    ? { status: "cancelled" as const }
                    : {}),
                }
              : {}),
          },
          acceptance: {
            status:
              settled?.acceptance ??
              (owner ? "not-run" : passed ? "passed" : "failed"),
            reason:
              owner || settled?.pending
                ? "后台服务仍在运行，尚未完成业务操作"
                : passed
                  ? "工具完成回执通过校验"
                  : "工具完成回执未通过验收",
            pending: settled?.pending ?? !!owner,
            evidence: [
              {
                kind: "protocol-field",
                description: "工具原始 JSON 回执",
                data: result,
              },
            ],
          },
          ...(owner
            ? {
                resourceOwnerPid: owner,
                handle: { backendTaskId: String(owner) },
              }
            : {}),
          ...(owner || settled?.pending
            ? {
                followUp: [
                  {
                    capabilityId: `${id}.status`,
                    hint: "使用原启动 handle 查询完成回执；不重新启动",
                  },
                ],
              }
            : {}),
          output: valid
            ? { result, error: null }
            : {
                result: null,
                error: {
                  code: `${id}-output-invalid`,
                  message: "工具回执未通过 schema 校验，详情见原始日志",
                },
              },
          rawOutput: outcome,
          command: { file: process.execPath, args },
          sideEffects: effects,
          tool: { name: id, version: backend.version, path: backend.bin },
        };
      },
    },
  }));
}

export function projectCommandProvider(
  id: string,
  definitions: CommandDefinition[],
  deps: CommandProviderDeps,
): CapabilityProvider {
  const discover =
    deps.discoverBackend ??
    (() =>
      discoverOfficialPlugin(OFFICIAL_PLUGINS.find((p) => p.command === id)!));
  return {
    id,
    version: "0.1.0",
    description: `${id} 结构化执行`,
    binding: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["projectDir"],
        properties: { projectDir: { type: "string", minLength: 1 } },
      },
      pathFields: [{ field: "projectDir", kind: "dir", required: true }],
      resolve: ({ project, raw, resolveInsideProject }) => ({
        ok: true,
        dirs: {
          projectDir: resolveInsideProject(
            project,
            (raw as { projectDir: string }).projectDir,
            `bindings.${id}.projectDir`,
          ).path,
        },
        files: {},
        section: raw as Record<string, unknown>,
        warnings: [],
      }),
    },
    defaultBinding: () => ({ section: { projectDir: "." }, warnings: [] }),
    status: () => {
      const b = discover();
      return {
        state: b.status,
        detail: b.error ?? `${b.package}@${b.version}`,
        tool: { name: id, version: b.version, path: b.bin },
      };
    },
    capabilities: () => commandRegistrations(id, definitions, deps),
  };
}
