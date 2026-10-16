import { verifyExecutionHandle } from "../../core/execution/handle";
import fs from "node:fs";
import path from "node:path";
import {
  projectCommandProvider,
  type CommandDefinition,
  type CommandProviderDeps,
} from "../command-provider";
import {
  resolveInsideProject,
  comparePathForm,
} from "../../core/project/paths";
import type { JsonSchema } from "../../core/execution/types";
const text: JsonSchema = { type: "string", minLength: 1 };
const ok: JsonSchema = {
  type: "object",
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
  additionalProperties: true,
};
const commands: Omit<CommandDefinition, "args">[] = [
  {
    id: "detect",
    command: ["detect"],
    description: "检测 Git 表格冲突",
    fields: {},
    readonly: true,
    result: {
      type: "object",
      required: ["ok", "count", "conflicts"],
      properties: {
        ok: { type: "boolean" },
        count: { type: "integer", minimum: 0 },
        conflicts: { type: "array" },
      },
      additionalProperties: true,
    },
    verify: (r) => r.ok === true,
  },
  {
    id: "filter-add",
    command: ["filter", "add"],
    description: "登记采用远端版本的表格路径",
    fields: { path: text },
    required: ["path"],
    result: ok,
    verify: (r) => r.ok === true,
  },
  {
    id: "prepare",
    command: ["prepare"],
    description: "准备三方表格审阅清单",
    fields: { path: text },
    result: {
      type: "object",
      required: ["ok", "manifest"],
      properties: { ok: { type: "boolean" }, manifest: text },
      additionalProperties: true,
    },
    verify: (r) =>
      r.ok === true &&
      typeof r.manifest === "string" &&
      fs.existsSync(r.manifest),
  },
  ...["launch", "resolve"].map((action): Omit<CommandDefinition, "args"> => ({
    id: action,
    command: ["launch"],
    description: "启动表格冲突审阅服务",
    fields: { path: text, "no-browser": { type: "boolean" } },
    result: ok,
    verify: (r) =>
      r.ok === true &&
      (r.url === null ||
        (typeof r.pid === "number" && typeof r.url === "string")),
    pending: (r) =>
      typeof r.pid === "number" && typeof r.url === "string" ? r.pid : null,
  })),
  ...["status", "cancel"].map((action): Omit<CommandDefinition, "args"> => ({
    id: action,
    command: [action],
    description:
      action === "cancel" ? "停止原表格审阅服务" : "查询原表格审阅服务",
    fields: { handle: { type: "object", additionalProperties: true } },
    required: ["handle"],
    control: true,
    readonly: action === "status",
    result: {
      type: "object",
      required: ["ok", "state", "stopConfirmed"],
      properties: {
        ok: { type: "boolean" },
        state: text,
        stopConfirmed: { type: "boolean" },
      },
      additionalProperties: true,
    },
    verify: (r) => r.ok === true,
    settlement: (r) => ({
      lifecycle:
        r.stopConfirmed === true
          ? r.state === "completed"
            ? "completed"
            : r.state === "cancelled"
              ? "cancelled"
              : "failed"
          : r.state === "unknown"
            ? "unknown"
            : "running",
      acceptance:
        r.state === "completed" &&
        r.stopConfirmed === true &&
        (r.result as { success?: unknown } | undefined)?.success === true
          ? "passed"
          : ["failed", "unknown"].includes(String(r.state))
            ? "failed"
            : "not-run",
      pending: r.stopConfirmed !== true && r.state !== "unknown",
    }),
  })),
  {
    id: "apply",
    command: ["apply"],
    description: "按明确决策写回冲突表格",
    fields: {
      manifest: text,
      decisions: text,
      "no-commit": { type: "boolean" },
      push: { type: "boolean" },
      message: text,
    },
    required: ["manifest", "decisions"],
    network: true,
    result: {
      type: "object",
      required: ["success"],
      properties: { success: { type: "boolean" } },
      additionalProperties: true,
    },
    verify: (r) => r.success === true,
  },
];
export const createXlmergeProvider = (deps: CommandProviderDeps) =>
  projectCommandProvider(
    "xlmerge",
    commands.map((d) => ({
      ...d,
      args: (input, ctx) => {
        const args = [
          "--repo",
          ctx.bindingDirs.projectDir,
          "--runtime-dir",
          path.join(ctx.projectRoot, ".vant/state/xlmerge", ctx.operationId),
        ];
        // 全局参数必须位于子命令之前；工厂在后端入口后拼接这些参数。
        if (d.control) {
          const checked = verifyExecutionHandle({
            project: ctx.projectAnchor,
            handle: input.handle,
            expectProviderId: "xlmerge",
          });
          if (!checked.ok) throw Error(checked.errors.join("；"));
          const origin = JSON.parse(
            fs.readFileSync(
              resolveInsideProject(
                ctx.projectAnchor,
                checked.record.recordDir + "/result.json",
                "xlmerge.origin",
              ).path,
              "utf8",
            ),
          );
          if (
            !["xlmerge.launch", "xlmerge.resolve"].includes(
              origin.capability?.id,
            ) ||
            origin.project?.bindingDirs?.xlmerge?.projectDir !==
              ctx.bindingDirs.projectDir
          )
            throw Error("原审阅不属于当前仓库绑定");
          const manifest = origin.output?.result?.manifest;
          if (typeof manifest !== "string") throw Error("原审阅缺少清单身份");
          const relative = path.relative(ctx.projectRoot, manifest);
          resolveInsideProject(ctx.projectAnchor, relative, "xlmerge.session");
          return [
            "--repo",
            ctx.bindingDirs.projectDir,
            ...d.command,
            "--manifest",
            manifest,
          ];
        }
        const values: string[] = [];
        for (const [key, value] of Object.entries(input)) {
          if (value === false) continue;
          if (key === "path") {
            resolveInsideProject(
              ctx.projectAnchor,
              String(value),
              "xlmerge.path",
            );
            if (d.id === "filter-add") values.push(String(value));
            else values.push("--path", String(value));
            continue;
          }
          let actual = String(value);
          if (["manifest", "decisions"].includes(key)) {
            actual = resolveInsideProject(
              ctx.projectAnchor,
              actual,
              `xlmerge.${key}`,
            ).path;
            if (key === "manifest") {
              const manifest = JSON.parse(fs.readFileSync(actual, "utf8"));
              if (
                typeof manifest.repoRoot !== "string" ||
                comparePathForm(fs.realpathSync(manifest.repoRoot)) !==
                  comparePathForm(fs.realpathSync(ctx.bindingDirs.projectDir))
              )
                throw Error("合并清单不属于当前仓库");
            }
          }
          values.push(`--${key}`);
          if (value !== true) values.push(actual);
        }
        return [...args, ...d.command, ...values];
      },
      sourceCommands: [d.id === "filter-add" ? ["filter", "add"] : [d.id]],
      command: [],
    })),
    deps,
  );
