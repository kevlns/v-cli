/**
 * 受控进程执行器：显式 argv 数组、shell:false、输出捕获与截断、超时/取消即杀。
 *
 * 设计要点：
 * - 永远不拼接 shell 字符串（no shell: true），不存在注入面。
 * - 取消（AbortSignal）与超时都会 kill 子进程；只有观察到子进程真正退出，
 *   killConfirmed 才为 true —— "取消未确认不得标记 cancelled" 的判定依据。
 * - 执行器可注入（SDK/测试用假执行器驱动真实协议 fixture）。
 */

import { spawn } from "node:child_process";
import path from "node:path";

export interface ProcessInvocation {
  /** 可执行文件（JS 入口请配 process.execPath） */
  file: string;
  args: string[];
  cwd?: string;
  /** 叠加在 process.env 之上（undefined 值表示删除该变量） */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 单流保留上限（字节，默认 8 MiB，超出截断并标记） */
  maxOutputBytes?: number;
}

export interface ProcessOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  /** 我们请求了终止且观察到子进程退出 */
  killConfirmed: boolean;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  /** spawn 本身失败（如文件不存在） */
  error: { code: string; message: string } | null;
}

export interface ProcessExecutor {
  run(invocation: ProcessInvocation): Promise<ProcessOutcome>;
}

const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;

class OutputCollector {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    if (this.truncated) return;
    const remaining = this.limit - this.size;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }
    if (chunk.length > remaining) {
      this.chunks.push(chunk.subarray(0, remaining));
      this.size += remaining;
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  text(): string {
    return Buffer.concat(this.chunks, this.size).toString("utf-8");
  }
}

function buildEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** 真实执行器：spawn(shell:false) + 逐流捕获 + 超时/取消杀进程 */
export class NodeProcessExecutor implements ProcessExecutor {
  run(invocation: ProcessInvocation): Promise<ProcessOutcome> {
    const startedAt = new Date();
    const started = Date.now();
    const maxOutput = invocation.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

    return new Promise<ProcessOutcome>((resolvePromise) => {
      if (invocation.signal?.aborted) {
        resolvePromise({
          exitCode: null,
          signal: null,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
          aborted: true,
          killConfirmed: false,
          durationMs: 0,
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          error: null,
        });
        return;
      }

      let child;
      try {
        child = spawn(invocation.file, invocation.args, {
          cwd: invocation.cwd,
          env: buildEnv(invocation.env),
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        resolvePromise({
          exitCode: null,
          signal: null,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
          aborted: false,
          killConfirmed: false,
          durationMs: Date.now() - started,
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          error: {
            code: (err as NodeJS.ErrnoException).code ?? "spawn-failed",
            message: err instanceof Error ? err.message : String(err),
          },
        });
        return;
      }

      const out = new OutputCollector(maxOutput);
      const errOut = new OutputCollector(maxOutput);
      child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => errOut.push(chunk));

      let timedOut = false;
      let aborted = false;
      let killRequested = false;
      let settled = false;
      let killTree: Promise<boolean> | undefined;

      const requestKill = (): void => {
        if (killRequested) return;
        killRequested = true;
        if (!child.pid) { killTree = Promise.resolve(false); return; }
        if (process.platform === "win32") {
          killTree = new Promise(resolve => {
            const killer = spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", shell: false });
            const timeout = setTimeout(() => { killer.kill(); resolve(false); }, 10000);
            killer.once("error", () => { clearTimeout(timeout); resolve(false); });
            killer.once("close", code => { clearTimeout(timeout); resolve(code === 0); });
          });
        } else {
          try { process.kill(-child.pid, "SIGKILL"); killTree = Promise.resolve(true); }
          catch { killTree = Promise.resolve(false); }
        }
      };

      const timer =
        invocation.timeoutMs !== undefined && invocation.timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              requestKill();
            }, invocation.timeoutMs)
          : undefined;

      const onAbort = (): void => {
        aborted = true;
        requestKill();
      };
      invocation.signal?.addEventListener("abort", onAbort, { once: true });
      if (invocation.signal?.aborted) onAbort();

      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        invocation.signal?.removeEventListener("abort", onAbort);
      };

      const finish = async (exitCode: number | null, signal: NodeJS.Signals | null, spawnError: Error | null): Promise<void> => {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise({
          exitCode,
          signal,
          stdout: out.text(),
          stderr: errOut.text(),
          stdoutTruncated: out.truncated,
          stderrTruncated: errOut.truncated,
          timedOut,
          aborted,
          killConfirmed: killRequested && spawnError === null && await killTree === true,
          durationMs: Date.now() - started,
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          error: spawnError
            ? {
                code: (spawnError as NodeJS.ErrnoException).code ?? "spawn-failed",
                message: spawnError.message,
              }
            : null,
        });
      };

      child.on("error", (err) => finish(null, null, err));
      child.on("close", (code, signal) => finish(code, signal, null));
    });
  }
}
