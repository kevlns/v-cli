/**
 * Unity Pipeline 协议解释层（保守、只认证据）。
 *
 * 协议来源（本地可查，不调用真实 Unity）：
 * - `v-cli agent docs unity` = 包内 AGENTS.md：exec 透传 Unity CLI stdout/stderr；
 *   `--format json` 是 Unity CLI 的全局选项；`run_tests` 全量必须 `--async_tests`
 *   后轮询 `test_status`；`recompile` 之后轮询 `recompile_status`
 *   （值域 idle | triggered | compiling | completed | up_to_date）；
 *   等待预算耗尽时包装器让出控制权、打印输出日志路径。
 * - `v-cli agent describe unity --json` = 清单：exec 输出 format=json、
 *   退出码语义、以及 doctor 的字段（routeSupported / cli.state / pipeline.state / installed）。
 * - exec 的 JSON 外层信封（{ success, data: { success, result } }）与
 *   `editor_status.data.result.status === "ready"` 取自 u-cli-mod 仓库自带的
 *   Windows E2E harness 的读取方式（本地包内可核对）。
 *
 * 任何"字段缺失/取值不在已知值域"的情况一律不通过：返回 unknown 或 failed，
 * 并把实际读到的字段与取值写进证据（不编造字段名）。
 */

export interface ToolOutput {
  /** stdout 解析出的 JSON（null = 无法解析） */
  parsed: unknown;
  /** 解析失败原因（stdout 非 JSON 或为空） */
  parseError: string | null;
  /** 是否带布尔 success 的响应信封 */
  envelope: boolean;
  success: boolean | null;
  /** 规范化载荷：data.result ?? data ?? parsed */
  payload: unknown;
  errorMessage: string | null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 从 stdout 提取 JSON：整段解析失败时尝试首个 '{' 起的最长可解析片段 */
export function parseToolStdout(stdout: string): { parsed: unknown; parseError: string | null } {
  const text = stdout.trim();
  if (text.length === 0) return { parsed: null, parseError: "stdout 为空" };
  try {
    return { parsed: JSON.parse(text), parseError: null };
  } catch (err) {
    const start = text.indexOf("{");
    if (start >= 0) {
      for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
        try {
          return { parsed: JSON.parse(text.slice(start, end + 1)), parseError: null };
        } catch {
          // 继续收缩
        }
      }
    }
    return { parsed: null, parseError: err instanceof Error ? err.message : String(err) };
  }
}

function readErrorMessage(value: Record<string, unknown>): string | null {
  const err = value.error;
  if (typeof err === "string" && err.length > 0) return err;
  if (isPlainObject(err)) {
    const message = err.message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  const message = value.message;
  if (typeof message === "string" && message.length > 0) return message;
  const detail = value.detail;
  if (typeof detail === "string" && detail.length > 0) return detail;
  return null;
}

/** 解释 Unity CLI / u-cli-mod 的 JSON 输出 */
export function interpretToolOutput(stdout: string): ToolOutput {
  const { parsed, parseError } = parseToolStdout(stdout);
  if (parsed === null) {
    return { parsed: null, parseError, envelope: false, success: null, payload: null, errorMessage: null };
  }
  if (!isPlainObject(parsed)) {
    return { parsed, parseError: null, envelope: false, success: null, payload: parsed, errorMessage: null };
  }

  const outerSuccess = typeof parsed.success === "boolean" ? parsed.success : null;
  const data = isPlainObject(parsed.data) ? parsed.data : null;
  const innerSuccess = data && typeof data.success === "boolean" ? data.success : null;
  const success = outerSuccess === false || innerSuccess === false ? false : innerSuccess ?? outerSuccess;

  let payload: unknown = parsed;
  if (data) {
    payload = data.result !== undefined ? data.result : data;
  }
  // Pipeline 状态命令返回序列化的 result；仅展开这个已知协议字段。
  if (data && typeof data.result === "string") {
    try { payload = JSON.parse(data.result); } catch { /* 非 JSON 的文本保持原样 */ }
  }

  const errorMessage = success === false ? readErrorMessage(data ?? {}) ?? readErrorMessage(parsed) : null;

  return {
    parsed,
    parseError: null,
    envelope: outerSuccess !== null || innerSuccess !== null,
    success,
    payload,
    errorMessage,
  };
}

/** 从规范化载荷里读取候选状态字段（只认文档/证据出现过的字段名） */
export function extractStatus(payload: unknown): { status: string | null; source: string | null } {
  if (!isPlainObject(payload)) return { status: null, source: null };
  for (const key of ["status"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return { status: value, source: `result.${key}` };
  }
  if (payload.result === "running") return { status: "running", source: "result.result" };
  return { status: null, source: null };
}

const FAIL_COUNT_PATHS: string[][] = [
  ["summary", "failed"],
];

/** 失败数：只认上述候选路径中的数字（报告命中路径，未命中即 null） */
export function extractFailCount(payload: unknown): { count: number | null; source: string | null } {
  if (!isPlainObject(payload)) return { count: null, source: null };
  for (const path of FAIL_COUNT_PATHS) {
    let current: unknown = payload;
    for (const segment of path) {
      if (!isPlainObject(current)) {
        current = undefined;
        break;
      }
      current = current[segment];
    }
    if (typeof current === "number" && Number.isSafeInteger(current) && current >= 0) {
      return { count: current, source: path.join(".") };
    }
  }
  return { count: null, source: null };
}

/** 总用例数（用于判定"存在有效报告"） */
export function extractTotal(payload: unknown): { total: number | null; source: string | null } {
  if (!isPlainObject(payload)) return { total: null, source: null };
  for (const path of [["summary", "total"]]) {
    let current: unknown = payload;
    for (const segment of path) {
      if (!isPlainObject(current)) {
        current = undefined;
        break;
      }
      current = current[segment];
    }
    if (typeof current === "number" && Number.isSafeInteger(current) && current >= 0) {
      return { total: current, source: path.join(".") };
    }
  }
  return { total: null, source: null };
}

/**
 * 是否存在有效报告：total 数字、summary/resultSummary 对象、results 数组/对象、
 * reportPath/report 字符串（至少一项）。
 */
export function detectTestReport(payload: unknown): { present: boolean; sources: string[] } {
  const sources: string[] = [];
  if (!isPlainObject(payload)) return { present: false, sources };
  if (isPlainObject(payload.summary)) sources.push("summary");
  return { present: sources.length > 0, sources };
}

/** 取消确认字段（只认显式布尔/状态） */
export function detectCancellationConfirmation(payload: unknown): { confirmed: boolean; source: string | null } {
  if (!isPlainObject(payload)) return { confirmed: false, source: null };
  for (const key of ["cancelled", "canceled", "cancelConfirmed"] as const) {
    if (payload[key] === true) return { confirmed: true, source: `result.${key}` };
  }
  const { status, source } = extractStatus(payload);
  if (status !== null && /^cancel(l)?ed$/i.test(status)) {
    return { confirmed: true, source: `${source}="${status}"` };
  }
  return { confirmed: false, source: null };
}

export type TestStatusClass = "completed" | "running" | "idle" | "cancelled" | "unknown";

/** 测试状态分类：只认明确取值；其他一律 unknown（不通过） */
export function classifyTestStatus(status: string | null): TestStatusClass {
  if (status === null) return "unknown";
  const normalized = status.trim().toLowerCase().replace(/[\s-]/g, "_");
  if (normalized === "completed") return "completed";
  if (
    ["running"].includes(normalized)
  ) {
    return "running";
  }
  if (normalized === "idle" || normalized === "no_tests") return "idle";
  if (normalized === "cancelled" || normalized === "canceled") return "cancelled";
  return "unknown";
}

export type RecompileStatusClass = "completed" | "running" | "idle" | "failed" | "unknown";

/** recompile_status 值域来自包内 AGENTS.md：idle | triggered | compiling | completed | up_to_date */
export function classifyRecompileStatus(status: string | null): RecompileStatusClass {
  if (status === null) return "unknown";
  const normalized = status.trim().toLowerCase().replace(/[\s-]/g, "_");
  if (normalized === "completed" || normalized === "up_to_date") return "completed";
  if (normalized === "triggered" || normalized === "compiling") return "running";
  if (normalized === "idle") return "idle";
  if (normalized === "failed" || normalized === "error") return "failed";
  return "unknown";
}

export interface NormalizedDoctor {
  editorVersion: string | null;
  editorRevision: string | null;
  routeSupported: boolean | null;
  routeRevision: string | null;
  cliState: string | null;
  pipelineState: string | null;
  pipelineInstalled: boolean | null;
  pipelinePresent: boolean | null;
  unityProcessCount: number | null;
  supportedVersions: string[] | null;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readBoolean(source: Record<string, unknown>, key: string): boolean | null {
  const value = source[key];
  return typeof value === "boolean" ? value : null;
}

/** 规范化 u-cli-mod doctor 输出（字段名来自包内清单/AGENTS.md） */
export function normalizeDoctor(parsed: unknown): NormalizedDoctor {
  const root = isPlainObject(parsed) ? parsed : {};
  const cli = isPlainObject(root.cli) ? root.cli : {};
  const pipeline = isPlainObject(root.pipeline) ? root.pipeline : {};
  const processes = root.unityProcesses;
  const supported = root.supportedVersions;
  return {
    editorVersion: readString(root, "editorVersion"),
    editorRevision: readString(root, "editorRevision"),
    routeSupported: readBoolean(root, "routeSupported"),
    routeRevision: readString(root, "routeRevision"),
    cliState: readString(cli, "state"),
    pipelineState: readString(pipeline, "state"),
    pipelineInstalled: readBoolean(pipeline, "installed"),
    pipelinePresent: readBoolean(pipeline, "present"),
    unityProcessCount: Array.isArray(processes) ? processes.length : null,
    supportedVersions: Array.isArray(supported) ? supported.filter((v): v is string => typeof v === "string") : null,
  };
}

/** 判断 doctor 诊断是否达到"可 exec"就绪判据（与包内 AGENTS.md 的就绪判据一致） */
export function doctorReadiness(doctor: NormalizedDoctor): { ready: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (doctor.routeSupported !== true) {
    reasons.push(
      doctor.routeSupported === null
        ? "doctor 输出缺少 routeSupported"
        : "工程 Editor 版本不在钉扎路由表内（routeSupported=false）",
    );
  }
  if (doctor.cliState !== "valid") {
    reasons.push(`cli.state=${doctor.cliState ?? "(缺失)"}，期望 valid`);
  }
  if (doctor.pipelineInstalled !== true) {
    reasons.push(`pipeline.installed=${String(doctor.pipelineInstalled)}，期望 true`);
  }
  if (doctor.pipelineState !== "current") {
    reasons.push(`pipeline.state=${doctor.pipelineState ?? "(缺失)"}，期望 current`);
  }
  return { ready: reasons.length === 0, reasons };
}

/**
 * 包装器等待预算耗尽（让出控制权）的判定：退出码 0 + stdout 无 JSON + stderr 有输出。
 * 依据包内 AGENTS.md："到点后任务在 Editor 内继续，立即返回……打印输出日志路径"。
 */
export function detectWaitBudgetHandoff(stdout: string, stderr: string, exitCode: number | null): boolean {
  return exitCode === 0 && stdout.trim().length === 0 && stderr.trim().length > 0;
}
