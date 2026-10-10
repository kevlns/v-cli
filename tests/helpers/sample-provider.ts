/**
 * 第三方样本 Provider：验证"仅实现 Provider 模块即可接入，不修改核心源文件"。
 *
 * - 绑定契约：workspaceDir（必填 dir）+ configFile（可选 file）——覆盖 dir/file、
 *   必填/可选两类路径字段。
 * - 能力：sample.echo（回显）、sample.trigger（异步触发+句柄）、sample.query / sample.cancel（句柄校验+落盘证据回读）。
 * - 可注入畸形行为（谎报路径/夹带未声明键/抛错），供核心强核对的负例测试使用。
 */

import type {
  CapabilityExecutionContext,
  CapabilityProvider,
  ImplementationOutcome,
  JsonSchema,
  ProviderBindingContract,
  ProviderBindingResolution,
  StructuredError,
} from "../../src/core/execution/types";
import { verifyExecutionHandle } from "../../src/core/execution/handle";

export type SampleBindingBehavior =
  | "honest"
  | { liePath: string }
  | { smuggleKey: Record<string, string> }
  | "throw"
  | "return-errors"
  | "return-garbage";

export interface SampleBinding {
  workspaceDir: string;
  configFile?: string;
}

export function sampleBindingContract(behavior: SampleBindingBehavior = "honest"): ProviderBindingContract {
  return {
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["workspaceDir"],
      properties: {
        workspaceDir: { type: "string", minLength: 1, description: "相对工程根的工作目录" },
        configFile: { type: "string", minLength: 1, description: "可选：配置文件相对路径" },
      },
    },
    pathFields: [
      { field: "workspaceDir", kind: "dir", required: true },
      { field: "configFile", kind: "file", required: false },
    ],
    resolve: ({ project, raw, resolveInsideProject }): ProviderBindingResolution => {
      if (behavior === "throw") throw new Error("sample resolve 故障");
      if (behavior === "return-garbage") return "not-a-resolution" as unknown as ProviderBindingResolution;
      if (behavior === "return-errors") return { ok: false, errors: ["样本绑定校验失败（预期负例）"] };
      const section = raw as SampleBinding;
      const dir = resolveInsideProject(project, section.workspaceDir, "bindings.sample.workspaceDir");
      const files: Record<string, string> = {};
      if (section.configFile !== undefined) {
        files.configFile = resolveInsideProject(project, section.configFile, "bindings.sample.configFile").path;
      }
      const dirs: Record<string, string> =
        behavior instanceof Object && "liePath" in behavior
          ? { workspaceDir: behavior.liePath }
          : { workspaceDir: dir.path };
      if (behavior instanceof Object && "smuggleKey" in behavior) {
        Object.assign(dirs, behavior.smuggleKey);
      }
      return { ok: true, dirs, files, section: { ...section }, warnings: [] };
    },
  };
}

export function createSampleProvider(options: {
  id?: string;
  bindingBehavior?: SampleBindingBehavior;
  execute?: (input: Record<string, unknown>) => ImplementationOutcome | Promise<ImplementationOutcome>;
} = {}): CapabilityProvider {
  const id = options.id ?? "sample";
  return {
    id,
    version: "0.1.0",
    description: "第三方样本 Provider（测试夹具；仅实现 Provider 模块即可接入）",
    status: () => ({ state: "available", detail: "样本始终可用" }),
    binding: sampleBindingContract(options.bindingBehavior ?? "honest"),
    defaultBinding: () => ({ section: { workspaceDir: "Sample" }, warnings: [] }),
    capabilities: () => [
      {
        descriptor: {
          id: `${id}.echo`,
          version: "0.1.0",
          description: "回显输入并报告绑定目录",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: { message: { type: "string", minLength: 1 } },
            required: ["message"],
          },
          outputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["message", "workspaceDir"],
            properties: {
              message: { type: "string" },
              workspaceDir: { type: "string" },
            },
          },
          preconditions: [{ id: `${id}.binding`, description: "工程配置已声明本 Provider 的绑定段（workspaceDir）" }],
          sideEffects: [],
          resources: [],
          retry: { safe: true, maxAttempts: 1, strategy: "none", description: "只读样本" },
          tags: ["sample"],
        },
        implementation: {
          preconditions: {
            [`${id}.binding`]: (_input, ctx) =>
              ctx.bindingDirs.workspaceDir
                ? { id: `${id}.binding`, status: "satisfied", detail: `已绑定 ${ctx.bindingDirs.workspaceDir}` }
                : {
                    id: `${id}.binding`,
                    status: "violated",
                    detail: '工程配置缺少 bindings.sample（workspaceDir）：先 project init 或手工补绑定段',
                  },
          },
          execute: async (input, ctx) => {
            if (options.execute) return await options.execute(input);
            return {
              execution: { status: "succeeded" as const, lifecycle: "completed" as const },
              acceptance: {
                status: "passed" as const,
                reason: "样本回显成功",
                evidence: [{ kind: "declared" as const, description: "样本固定通过" }],
              },
              output: {
                message: String(input.message),
                workspaceDir: ctx.bindingDirs.workspaceDir ?? "(无绑定)",
              },
            };
          },
        },
      },
      ...([
        {
          id: `${id}.trigger`,
          description: "模拟异步触发：产出执行句柄（样本后端分配 backendTaskId），终态用 sample.query 轮询",
          input: {
            type: "object",
            additionalProperties: false,
            properties: { label: { type: "string", minLength: 1 } },
          } as JsonSchema,
          output: {
            type: "object",
            additionalProperties: false,
            required: ["job"],
            properties: { job: { type: "string" }, label: { type: "string", nullable: true } },
          } as JsonSchema,
        },
        {
          id: `${id}.query`,
          description: "按句柄查询原始执行（内核句柄校验 + 落盘证据回读；校验失败前置条件拒绝，不执行任何后端操作）",
          input: {
            type: "object",
            additionalProperties: false,
            required: ["handle"],
            properties: { handle: { type: "object" } },
          } as JsonSchema,
          output: {
            type: "object",
            additionalProperties: false,
            required: ["originOperationId", "backendTaskId", "originExecution", "correlation"],
            properties: {
              originOperationId: { type: "string" },
              backendTaskId: { type: "string", nullable: true },
              originExecution: { type: "object" },
              originAcceptance: { type: "object", nullable: true },
              correlation: { type: "string" },
            },
          } as JsonSchema,
        },
        {
          id: `${id}.cancel`,
          description: "按句柄取消（先校验身份再执行；样本后端确认取消 → 任务级 lifecycle=cancelled）",
          input: {
            type: "object",
            additionalProperties: false,
            required: ["handle"],
            properties: { handle: { type: "object" } },
          } as JsonSchema,
          output: {
            type: "object",
            additionalProperties: false,
            required: ["cancelled", "backendTaskId", "originOperationId"],
            properties: {
              cancelled: { type: "boolean" },
              backendTaskId: { type: "string", nullable: true },
              originOperationId: { type: "string" },
            },
          } as JsonSchema,
        },
      ].map((spec) => ({
        descriptor: {
          id: spec.id,
          version: "0.1.0",
          description: spec.description,
          inputSchema: spec.input,
          outputSchema: spec.output,
          preconditions: [
            { id: `${id}.binding`, description: "工程配置已声明本 Provider 的绑定段（workspaceDir）" },
            ...(spec.id === `${id}.query` || spec.id === `${id}.cancel`
              ? [{ id: `${id}.handle-valid`, description: "句柄通过内核校验（身份一致 + 落盘证据可回读）" }]
              : []),
          ],
          sideEffects: [],
          resources: [],
          retry:
            spec.id === `${id}.trigger`
              ? { safe: false, maxAttempts: 1, strategy: "poll-status" as const, description: "触发类不自动重试；用 query 轮询" }
              : { safe: true, maxAttempts: 1, strategy: "none" as const, description: "查询/取消类单次尝试" },
          tags: ["sample"],
        },
        implementation: {
          preconditions: {
            [`${id}.binding`]: (_input: Record<string, unknown>, ctx: { bindingDirs: Record<string, string> }) =>
              ctx.bindingDirs.workspaceDir
                ? { id: `${id}.binding`, status: "satisfied" as const, detail: `已绑定 ${ctx.bindingDirs.workspaceDir}` }
                : { id: `${id}.binding`, status: "violated" as const, detail: "缺少绑定段" },
            ...((spec.id === `${id}.query` || spec.id === `${id}.cancel`
              ? {
                  [`${id}.handle-valid`]: (input: Record<string, unknown>, ctx: CapabilityExecutionContext) => {
                    const verification = verifyExecutionHandle({
                      project: ctx.projectAnchor,
                      handle: input.handle,
                      expectProviderId: id,
                      expectCapabilityId: `${id}.trigger`,
                    });
                    return verification.ok
                      ? { id: `${id}.handle-valid`, status: "satisfied" as const, detail: `句柄校验通过（${verification.checks.join("、")}）` }
                      : {
                          id: `${id}.handle-valid`,
                          status: "violated" as const,
                          detail: `句柄校验失败 [${verification.code}]: ${verification.errors.join("；")}`,
                        };
                  },
                }
              : {}) as Record<string, never>),
          },
          execute: async (input: Record<string, unknown>, ctx: CapabilityExecutionContext): Promise<ImplementationOutcome> => {
            if (spec.id === `${id}.trigger`) {
              const backendTaskId = `sample-job-${ctx.operationId.slice(-10)}`;
              return {
                execution: { status: "succeeded", lifecycle: "accepted", exitCode: 0 },
                acceptance: {
                  status: "not-run",
                  reason: "样本异步触发：尚无终态，轮询 sample.query（pending）",
                  pending: true,
                  evidence: [{ kind: "declared", description: "样本后端已接受启动" }],
                },
                output: { job: backendTaskId, label: typeof input.label === "string" ? input.label : null },
                followUp: [{ capabilityId: `${id}.query`, hint: "用结果中的 handle 调用 sample.query 查询" }],
                handle: { backendTaskId },
              };
            }
            // query / cancel：前置条件已校验，这里重跑校验拿记录（幂等只读）
            const verification = verifyExecutionHandle({
              project: ctx.projectAnchor,
              handle: input.handle,
              expectProviderId: id,
              expectCapabilityId: `${id}.trigger`,
            });
            if (!verification.ok) {
              return {
                execution: { status: "failed", lifecycle: "unknown", error: structuredErrorFromCode(verification.code, verification.errors) },
                acceptance: { status: "not-run", reason: "句柄校验失败", pending: false, evidence: [] },
              };
            }
            const record = verification.record;
            const identityEvidence = [
              { kind: "file" as const, description: `落盘证据 ${record.recordDir}/result.json`, data: { operationId: record.operationId } },
              { kind: "protocol-field" as const, description: "身份核对项", data: { checks: verification.checks } },
            ];
            if (spec.id === `${id}.query`) {
              return {
                // 任务级观察映射：origin 记录 lifecycle=accepted ⇒ 查询时刻任务仍在途（running）；
              // 终态（completed/failed/cancelled）原样传播。依据是落盘记录（evidence 已含 origin lifecycle），非凭空合成。
              execution: {
                status: "succeeded",
                lifecycle: (record.execution?.lifecycle === "accepted"
                  ? "running"
                  : (record.execution?.lifecycle as ImplementationOutcome["execution"]["lifecycle"]) ?? "unknown"),
                exitCode: 0,
              },
                acceptance: {
                  status: "passed",
                  reason: `句柄校验通过，关联原始执行 ${record.operationId}（backendTaskId=${record.backendTaskId}）`,
                  evidence: identityEvidence,
                },
                output: {
                  originOperationId: record.operationId,
                  backendTaskId: record.backendTaskId,
                  originExecution: record.execution,
                  originAcceptance: record.acceptance,
                  correlation: "verified",
                },
              };
            }
            return {
              execution: { status: "succeeded", lifecycle: "cancelled", exitCode: 0 },
              acceptance: {
                status: "passed",
                reason: `样本后端确认取消 backendTaskId=${record.backendTaskId}（原始执行 ${record.operationId}）`,
                evidence: identityEvidence,
              },
              output: {
                cancelled: true,
                backendTaskId: record.backendTaskId,
                originOperationId: record.operationId,
              },
            };
          },
        },
      }))),
    ],
  };
}
function structuredErrorFromCode(code: string, errors: string[]): StructuredError {
  return { code: `sample-handle-${code}`, category: "request" as const, message: errors.join("；"), retryable: false };
}
