import path from "node:path";
import {readFileSync} from "node:fs";
import {
  OFFICIAL_PLUGINS,
  discoverOfficialPlugin,
  type OfficialPluginInfo,
} from "../../core/official";
import { executionFromProcess } from "../../core/execution/runtime";
import { structuredError } from "../../core/execution/errors";
import { resolveInsideProject } from "../../core/project/paths";
import { verifyExecutionHandle } from "../../core/execution/handle";
import type { ProcessExecutor } from "../../core/execution/executor";
import type {
  CapabilityProvider,
  CapabilityRegistration,
  JsonSchema,
  ProviderBindingContract,
  ExecutionLifecycle,
} from "../../core/execution/types";
export interface ArtProviderDeps {
  executor: ProcessExecutor;
  discoverBackend?: () => OfficialPluginInfo;
  env?: Record<string, string | undefined>;
}
const identifier: JsonSchema = {
  type: "string",
  pattern: "^[a-z0-9][a-z0-9-]{0,63}$",
};
const revision: JsonSchema = { type: "integer", minimum: 1 };
const file: JsonSchema = {
  type: "string",
  minLength: 1,
  description: "相对工程根的受控文件路径",
};
export const artBindingContract: ProviderBindingContract = {
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["workspace", "output", "cache", "projectId"],
    properties: {
      workspace: file,
      output: file,
      cache: file,
      projectId: identifier,
    },
  },
  pathFields: ["workspace", "output", "cache"].map((field) => ({
    field,
    kind: "dir" as const,
    required: true,
  })),
  resolve: ({ project, raw, resolveInsideProject: inside }) => {
    const b = raw as Record<string, unknown>;
    if (
      !b ||
      typeof b !== "object" ||
      !["workspace", "output", "cache", "projectId"].every(
        (k) => typeof b[k] === "string",
      )
    )
      return {
        ok: false,
        errors: ["art 绑定必须包含 workspace/output/cache/projectId"],
      };
    const dirs = Object.fromEntries(
      ["workspace", "output", "cache"].map((k) => [
        k,
        inside(project, b[k] as string, "bindings.art." + k).path,
      ]),
    );
    return { ok: true, dirs, files: {}, section: { ...b }, warnings: [] };
  },
};
type Definition = {
  id: string;
  command: string[];
  fields: Record<string, JsonSchema>;
  required?: string[];
  readonly?: boolean;
  start?: boolean;
  control?: boolean;
  network?: boolean;
};
const objectFields = { id: identifier, revision, input: file };
const definitions: Definition[] = [
  {id:"job-template",command:["job","template"],fields:{kind:{type:"string",enum:["generate","edit"]},core:identifier},required:["kind"],readonly:true},
  {id:"job-from-candidate",command:["job","from-candidate"],fields:{id:identifier,run:identifier,candidate:{type:"string",pattern:"^[a-f0-9]{64}$"}},required:["id","run","candidate"]},
  {id:'deployment-plan',command:['deployment','plan'],fields:{directory:{type:'string',minLength:1},endpoint:{type:'string',minLength:1}},required:['directory'],readonly:true},
  {id:'deployment-start',command:['deployment','start'],fields:{plan:file,operation:{type:'string',pattern:'^[a-z0-9-]{1,128}$'}},required:['plan','operation'],network:true},
  ...['status','cancel','recover'].map((action):Definition=>({id:'deployment-'+action,command:['deployment',action],fields:action==='recover'?{operation:{type:'string',pattern:'^[a-z0-9-]{1,128}$'}}:{id:identifier},required:[action==='recover'?'operation':'id'],readonly:action!=='cancel'})),
 {id:"run-recover",command:["task","recover"],fields:{operation:{type:"string",pattern:"^[a-z0-9-]{1,128}$"}},required:["operation"],start:true},
  ...["style", "job"].flatMap((kind) =>
    ["create", "list", "read", "update", "derive", "discard"].map(
      (action): Definition => ({
        id: kind + "-" + action,
        command: [kind, action],
        fields:
          action === "list"
            ? {}
            : action === "create"
              ? { input: file }
              : action === "read"
                ? { id: identifier }
                : action === "update"
                  ? objectFields
                  : { id: identifier, revision },
        required:
          action === "list"
            ? []
            : action === "create"
              ? ["input"]
              : action === "read"
                ? ["id"]
                : action === "update"
                  ? ["id", "revision", "input"]
                  : ["id", "revision"],
        readonly: ["list", "read"].includes(action),
      }),
    ),
  ),
  { id: "run-list", command: ["task", "list"], fields: {}, readonly: true },
  {
    id: "project-init",
    command: ["project", "init"],
    fields: { input: file },
    required: ["input"],
  },
  {
    id: "style-analyze",
    command: ["style", "analyze"],
    fields: { id: identifier, revision, dry: { type: "boolean" } },
    required: ["id", "revision"],
    start: true,
  },
  {
    id: "job-analyze",
    command: ["job", "analyze"],
    fields: { id: identifier, revision, dry: { type: "boolean" } },
    required: ["id", "revision"],
    start: true,
  },
  {id:"style-resolve",command:["style","resolve"],fields:objectFields,required:["id","revision","input"]},
  {
    id: "style-adopt",
    command: ["style", "adopt"],
    fields: { id: identifier, revision, note: { type: "string" } },
    required: ["id", "revision"],
  },
  {
    id: "style-recover",
    command: ["style", "recover"],
    fields: { id: identifier },
    required: ["id"],
  },
  ...["generate", "edit"].map((kind): Definition => ({
    id: kind + "-plan",
    command: [kind, "plan"],
    fields: { job: identifier, backend: identifier, out: file },
    required: ["job"],
  })),
  ...["generate", "edit"].map((kind): Definition => ({
    id: kind + "-start",
    command: [kind, "run"],
    fields: {
      plan: file,
      item: identifier,
      variant: identifier,
      "all-variants": { type: "boolean" },
      "retry-run": {...identifier,description:"原批次停止已确认后，仅重试原计划中明确失败的项；成功项不会重做"},
      dry: { type: "boolean" },
    },
    required: ["plan"],
    start: true,
  })),
  ...["status", "cancel", "resume"].map((action): Definition => ({
    id: "run-" + action,
    command: ["task", action],
    fields: {
      handle: { type: "object", additionalProperties: true } as JsonSchema,
    },
    required: ["handle"],
    control: true,
    readonly: action === "status",
  })),
  {
    id: "reference-list",
    command: ["reference", "list"],
    fields: {
      kind: { type: "string", enum: ["style", "task"] },
      id: identifier,
    },
    required: ["kind", "id"],
    readonly: true,
  },
  {
    id: "reference-import",
    command: ["reference", "import"],
    fields: {
      kind: { type: "string", enum: ["style", "task"] },
      id: identifier,
      revision,
      source: file,
      category: {
        type: "string",
        enum: ["style", "palette", "rendering"],
      },
      purposes: { type: "string" },
      note: { type: "string" },
    },
    required: ["kind", "id", "revision", "source"],
  },
  {
    id: "reference-remove",
    command: ["reference", "remove"],
    fields: {
      kind: { type: "string", enum: ["style", "task"] },
      id: identifier,
      revision,
      item: identifier,
    },
    required: ["kind", "id", "revision", "item"],
  },
  {
    id: "reference-update",
    command: ["reference", "update"],
    fields: {kind:{type:"string",enum:["style","task"]},id:identifier,revision,item:identifier,input:file},
    required:["kind","id","revision","item","input"],
  },
  ...["list", "finalizations", "finalize", "delete"].map(
    (action): Definition => ({
      id: "candidate-" + action,
      command: ["candidate", action],
      fields: {
        job: identifier,
        run: identifier,
        candidate: { type: "string" } as JsonSchema,
        revision,
        actor: { type: "string" } as JsonSchema,
        replace: { type: "boolean" } as JsonSchema,
        confirm: { type: "boolean" } as JsonSchema,
      },
      required: [
        "job",
        ...(action === "finalizations" ? [] : ["run"]),
        ...(["finalize", "delete"].includes(action)
          ? ["candidate", "revision", "actor"]
          : []),
      ],
      readonly: ["list", "finalizations"].includes(action),
    }),
  ),
];
export function createArtProvider(deps: ArtProviderDeps): CapabilityProvider {
  const discover =
    deps.discoverBackend ??
    (() =>
      discoverOfficialPlugin(
        OFFICIAL_PLUGINS.find((s) => s.command === "art")!,
      ));
  const registrations: CapabilityRegistration[] = definitions.map((d) => ({
    descriptor: {
      id: "art." + d.id,
      version: "0.1.0",
      description:
        "美术工坊 " + d.command.join(" ") + "；对象版本与停止证据由工具核验",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: d.fields,
        required: d.required ?? [],
      },
      outputSchema: {
        type: "object",
        additionalProperties: true,
        required: ["result"],
        properties: { result: { type: "object", additionalProperties: true } },
      },
      preconditions: [],
      sideEffects: [
        {
          id: "read-art",
          kind: "fs-read",
          description: "读取受管对象与执行证据",
          reversible: true,
        },
        {
          id: "invoke-art",
          kind: "process-exec",
          description: "受控参数调用官方 art 工具",
          reversible: false,
        },
        ...(d.start || d.control || d.network
          ? [
              {
                id: "art-network",
                kind: "network" as const,
                description: "调用模型或查询、取消后端执行",
                reversible: false,
              },
            ]
          : []),
        ...(!d.readonly
          ? [
              {
                id: "art-mutation",
                kind: "fs-write" as const,
                description: "对象配置、执行证据或定版变更；启动可调用模型",
                reversible: false,
              },
            ]
          : []),
      ],
      resources: [
        {
          kind: "project-workspace",
          mode: d.readonly ? "shared" : "exclusive",
          scope: "project",
          description: "组织层管理对象资源占用，停止未知继续占用",
        },
      ],
      retry: {
        safe: !!d.readonly,
        maxAttempts: 1,
        strategy: "none",
        description: "启动不自动重试；恢复查询原句柄",
      },
      timeoutMs: 90000,
      tags: ["art", "lifecycle"],
    },
    implementation: {
      execute: async (input, ctx) => {
        const backend = discover();
        const fail = (code: string, message: string) => ({
          execution: {
            status: "failed" as const,
            lifecycle: "failed" as const,
            error: structuredError(code, "precondition", message),
          },
          acceptance: { status: "not-run" as const, reason: message },
        });
        if (backend.status !== "available" || !backend.bin)
          return fail(
            "art-backend-unavailable",
            backend.error ?? "art 后端不可用",
          );
        if (!ctx.binding || !ctx.bindingDirs.workspace)
          return fail("art-binding-missing", "缺少 art 工程绑定");
        if(d.start&&input.plan){
          const file=resolveInsideProject(ctx.projectAnchor,String(input.plan),"art.plan").path;
          const plan=JSON.parse(readFileSync(file,"utf8"));
          if(plan.project!==ctx.binding.projectId||plan.module!==d.command[0])return fail("art-plan-scope-mismatch","计划不属于当前 art 工程或执行类型");
        }
        const argv = [
          ...d.command,
          "--workspace",
          ctx.bindingDirs.workspace,
          "--output-dir",
          ctx.bindingDirs.output,
          "--cache-dir",
          ctx.bindingDirs.cache,
          "--config",
          path.join(ctx.bindingDirs.workspace, "settings.json"),
        ];
        if (!d.control && !(d.command[1] === "run" && input.plan))
          argv.push("--project", String(ctx.binding.projectId));
        if (d.control) {
          const verification = verifyExecutionHandle({
            project: ctx.projectAnchor,
            handle: input.handle,
            expectProviderId: "art",
          });
          if (!verification.ok)
            return fail(verification.code, verification.errors.join("; "));
          if (!verification.record.backendTaskId)
            return fail("art-handle-missing", "句柄缺少后端运行身份");
          const origin=JSON.parse(readFileSync(resolveInsideProject(ctx.projectAnchor,verification.record.recordDir+"/result.json","art.origin").path,"utf8"));
          if(origin.output?.result?.project!==ctx.binding.projectId||["workspace","output","cache"].some(key=>origin.project?.bindingDirs?.art?.[key]!==ctx.bindingDirs?.[key]))return fail("art-handle-binding-changed","运行身份与当前工程绑定不同；请恢复原绑定后操作");
          argv.splice(2, 0, verification.record.backendTaskId);
        }
        for (const [key, value] of Object.entries(input)) {
          if (key === "handle" || value === false) continue;
          const actual = ["input", "source", "plan", "out"].includes(key)
            ? resolveInsideProject(
                ctx.projectAnchor,
                String(value),
                "art." + key,
              ).path
            : value;
          argv.push("--" + key);
          if (value !== true) argv.push(String(actual));
        }
        if(d.start&&d.id!=="run-recover"&&!input.dry)argv.push("--operation",ctx.operationId);
        if (d.start && d.command[1] === "run" && !input.dry)
          argv.push("--background");
        const outcome = await deps.executor.run({
          file: process.execPath,
          args: [backend.bin, ...argv],
          cwd: ctx.projectAnchor.root,
          env: deps.env,
          timeoutMs: 90000,
          signal: ctx.signal,
        });
        let output: Record<string, unknown>;
        try {
          const parsed = JSON.parse(outcome.stdout);
          output = Array.isArray(parsed) ? { items: parsed } : parsed;
          if (!output || typeof output !== "object") throw new Error();
        } catch {
          const processState=executionFromProcess(outcome);
          const uncertain=d.start||d.control||d.id==="deployment-start"||processState.lifecycle==="unknown";
          return {
            execution: {
              ...processState,
              status: "failed",
              lifecycle: uncertain?"unknown":processState.lifecycle,
              error: structuredError(
                "art-output-invalid",
                "protocol",
                uncertain?"art 未返回完整 JSON，不能据此释放资源":"art 未返回完整 JSON；同步进程已结束，操作结果需查询核验",
              ),
            },
            acceptance: { status: "not-run", reason: "协议结果未知，不能声称业务成功" },
            rawOutput: outcome,
          };
        }
        let lifecycle: ExecutionLifecycle =
          executionFromProcess(outcome).lifecycle;
        if (typeof output.taskId === "string")
          lifecycle =
            (output.lifecycle as ExecutionLifecycle) ??
            (d.start && !input.dry
              ? "accepted"
              : output.stopConfirmed === true
                ? "completed"
                : "unknown");
        return {
          execution: { ...executionFromProcess(outcome), lifecycle,
            ...(output.ok===false?{status:"failed" as const,error:structuredError("art-operation-failed","process",String(output.error??JSON.stringify(output.issues??output.diagnostic??"美术操作失败")))}:{}),
          },
          acceptance: {
            status: "not-run",
            reason: d.start
              ? "已登记执行；完成与定版需查询真实证据"
              : "工具状态已读取，业务结论见 result",
          },
          output: { result: {...output,...(d.start?{project:ctx.binding.projectId}:{})} },
          rawOutput: { stdout: outcome.stdout, stderr: outcome.stderr },
          ...(d.start && !input.dry && typeof output.taskId === "string"
            ? { handle: { backendTaskId: output.taskId } }
            : {}),
        };
      },
    },
  }));
  return {
    id: "art",
    version: "0.1.0",
    description: "美术工坊注册执行适配；无额外队列或业务状态",
    binding: artBindingContract,
    defaultBinding: () => ({
      section: {
        workspace: ".vant/art",
        output: ".vant/art/output",
        cache: ".vant/art/cache",
        projectId: "project",
      },
      warnings: [],
    }),
    status: async () => {
      const info = discover();
      return {
        state: info.status === "available" ? "available" : info.status,
        detail: info.error ?? "官方 art 后端",
      };
    },
    capabilities: () => registrations,
  };
}
