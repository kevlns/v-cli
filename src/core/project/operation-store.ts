/**
 * 操作记录：.vant/state/operations/<operationId>/
 *
 * - 本地记录，不是任务中心：不做队列、不做锁、不跨进程协调（见 spec 文档）。
 * - operationId 严格校验（字符集/长度/保留名），越界与符号链接写入一律拒绝；
 *   已存在的 operationId 一律拒绝（mkdir 非递归 + wx 写入，绝不覆盖）。
 * - 保存：input.json（脱敏摘要）、events.jsonl（事件/日志）、result.json（结果证据）、
 *   stdout.log / stderr.log（原始输出，带上限与截断标记）。
 * - 允许"不落盘"模式（测试/SDK）：不创建任何目录/文件，事件丢弃（取舍见 spec）。
 */

import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { OPERATIONS_RELATIVE } from "./config";
import { PathSafetyError, resolveInsideProject, type ProjectRoot } from "./paths";
import type { LogRef, OperationLogger } from "../execution/types";

const OPERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WINDOWS_RESERVED = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

export const MAX_LOG_BYTES = 8 * 1024 * 1024;
const TAIL_CHARS = 2000;

export class OperationExistsError extends Error {
  readonly code = "operation-exists";

  constructor(operationId: string, dir: string) {
    super(`operationId "${operationId}" 已存在（${dir}）：拒绝覆盖已有操作记录，请换一个 operationId`);
    this.name = "OperationExistsError";
  }
}

/** 校验 operationId；返回错误列表（空 = 合法） */
export function validateOperationId(operationId: unknown): string[] {
  if (typeof operationId !== "string" || operationId.length === 0) {
    return ["operationId 必须是非空字符串"];
  }
  if (!OPERATION_ID_RE.test(operationId)) {
    return [
      `operationId "${operationId}" 非法：只允许 [A-Za-z0-9._-]，首字符为字母或数字，长度 <= 128（禁止路径分隔符与 ..）`,
    ];
  }
  if (operationId === "." || operationId === ".." || operationId.startsWith(".")) {
    return [`operationId "${operationId}" 非法：不得以 "." 开头或使用 "."/".."`];
  }
  const base = operationId.split(".")[0].toLowerCase();
  if (WINDOWS_RESERVED.has(base)) {
    return [`operationId "${operationId}" 非法：包含 Windows 保留设备名 "${base}"`];
  }
  return [];
}

export function generateOperationId(capabilityId: string, now: Date = new Date(), entropy?: string): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 15);
  const slug = capabilityId.replace(/\./g, "-").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const suffix = entropy ?? randomBytes(3).toString("hex");
  return `${stamp}-${slug}-${suffix}`;
}

export interface OperationEvent {
  seq: number;
  at: string;
  type: string;
  message: string;
  data?: unknown;
}

export interface WriteLogsInput {
  stdout: string;
  stderr: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export interface OperationSummary {
  operationId: string;
  dir: string | null;
  files: string[];
  events: OperationEvent[];
  failure: string | null;
}

/**
 * 操作记录写入器。reserve() 失败会抛出（越界/已存在/非法 id 都是硬失败）；
 * reserve() 之后的写入失败不抛出，记录到 failure 并由结果如实上报。
 */
export class OperationStore implements OperationLogger {
  readonly operationId: string;
  readonly dir: string | null;
  readonly enabled: boolean;

  private events: OperationEvent[] = [];
  private writtenFiles: string[] = [];
  private seq = 0;
  private failure: string | null = null;

  private constructor(operationId: string, dir: string | null, enabled: boolean) {
    this.operationId = operationId;
    this.dir = dir;
    this.enabled = enabled;
  }

  /** 不落盘模式：无目录、无文件、事件丢弃 */
  static disabled(operationId: string): OperationStore {
    return new OperationStore(operationId, null, false);
  }

  /** 预留 operation 目录；越界/符号链接/非法 id/已存在 → 抛错（绝不覆盖） */
  static reserve(project: ProjectRoot, operationId: string, now: Date = new Date()): OperationStore {
    const idErrors = validateOperationId(operationId);
    if (idErrors.length > 0) {
      throw new PathSafetyError("operation-id-invalid", idErrors.join("；"));
    }
    const operationsRoot = resolveInsideProject(project, OPERATIONS_RELATIVE, OPERATIONS_RELATIVE);
    try {
      fs.mkdirSync(operationsRoot.path, { recursive: true });
    } catch (err) {
      throw new PathSafetyError(
        "operations-dir-failed",
        `无法创建操作记录目录 ${operationsRoot.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // 目录建成后再核对一次：新建路径同样不得落在链接目标上
    const verifiedRoot = resolveInsideProject(project, OPERATIONS_RELATIVE, OPERATIONS_RELATIVE);
    const dir = path.join(verifiedRoot.path, operationId);
    try {
      // 非递归：已存在即 EEXIST → 拒绝覆盖
      fs.mkdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new OperationExistsError(operationId, dir);
      }
      throw new PathSafetyError(
        "operation-dir-failed",
        `无法创建操作目录 ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const store = new OperationStore(operationId, dir, true);
    store.event("operation-reserved", `已预留操作目录 ${dir}`, { recordedAt: now.toISOString() });
    return store;
  }

  get persistedFiles(): string[] {
    return [...this.writtenFiles];
  }

  get failureMessage(): string | null {
    return this.failure;
  }

  get recordedEvents(): OperationEvent[] {
    return [...this.events];
  }

  private write(fileName: string, content: string, flags: "w" | "wx" = "w"): boolean {
    if (!this.enabled || !this.dir) return false;
    try {
      fs.writeFileSync(path.join(this.dir, fileName), content, { encoding: "utf-8", flag: flags });
      if (!this.writtenFiles.includes(fileName)) this.writtenFiles.push(fileName);
      return true;
    } catch (err) {
      this.failure ??= `${fileName} 写入失败: ${err instanceof Error ? err.message : String(err)}`;
      return false;
    }
  }

  event(type: string, message: string, data?: unknown): void {
    const record: OperationEvent = {
      seq: this.seq++,
      at: new Date().toISOString(),
      type,
      message,
      ...(data === undefined ? {} : { data }),
    };
    this.events.push(record);
    if (!this.enabled || !this.dir) return;
    try {
      fs.appendFileSync(path.join(this.dir, "events.jsonl"), `${JSON.stringify(record)}\n`, "utf-8");
      if (!this.writtenFiles.includes("events.jsonl")) this.writtenFiles.push("events.jsonl");
    } catch (err) {
      this.failure ??= `events.jsonl 追加失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  warn(message: string): void {
    this.event("warning", message);
  }

  writeInput(payload: unknown): void {
    this.event("input-recorded", "输入摘要已记录", { redacted: true });
    this.write("input.json", `${JSON.stringify(payload, null, 2)}\n`, "wx");
  }

  writeLogs(input: WriteLogsInput): { stdout: LogRef; stderr: LogRef } {
    return {
      stdout: this.writeLog("stdout.log", input.stdout, input.stdoutTruncated ?? false),
      stderr: this.writeLog("stderr.log", input.stderr, input.stderrTruncated ?? false),
    };
  }

  private writeLog(fileName: string, text: string, truncated: boolean): LogRef {
    const bytes = Buffer.byteLength(text, "utf-8");
    const sha256 = createHash("sha256").update(text, "utf-8").digest("hex");
    const capped =
      bytes > MAX_LOG_BYTES ? Buffer.from(text, "utf-8").subarray(0, MAX_LOG_BYTES).toString("utf-8") : text;
    const truncatedFinal = truncated || bytes > MAX_LOG_BYTES;
    const saved = this.write(fileName, capped);
    return {
      bytes,
      truncated: truncatedFinal,
      sha256,
      file: saved ? fileName : null,
      tail: text.length > TAIL_CHARS ? text.slice(-TAIL_CHARS) : text,
    };
  }

  writeResult(result: unknown): void {
    this.event("operation-finished", "结果已记录");
    this.write("result.json", `${JSON.stringify(result, null, 2)}\n`);
  }

  summary(): OperationSummary {
    return {
      operationId: this.operationId,
      dir: this.dir,
      files: [...this.writtenFiles],
      events: [...this.events],
      failure: this.failure,
    };
  }
}
