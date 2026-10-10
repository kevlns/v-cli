/** 测试用假进程执行器：脚本化响应 + 调用记录（不启动真实进程） */

import type { ProcessExecutor, ProcessInvocation, ProcessOutcome } from "../../src/core/execution/executor";

export interface FakeCall {
  file: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
}

export interface FakeResponse {
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  aborted?: boolean;
  killConfirmed?: boolean;
  error?: { code: string; message: string } | null;
  /** 覆盖耗时（默认 1ms） */
  durationMs?: number;
}

export type FakeHandler = (call: FakeCall, index: number) => FakeResponse | Promise<FakeResponse>;

export class FakeExecutor implements ProcessExecutor {
  readonly calls: FakeCall[] = [];

  constructor(private readonly handler: FakeHandler) {}

  async run(invocation: ProcessInvocation): Promise<ProcessOutcome> {
    const call: FakeCall = {
      file: invocation.file,
      args: [...invocation.args],
      cwd: invocation.cwd,
      timeoutMs: invocation.timeoutMs,
      signal: invocation.signal,
      env: invocation.env,
    };
    const index = this.calls.length;
    this.calls.push(call);
    const response = await this.handler(call, index);
    const startedAt = new Date();
    const durationMs = response.durationMs ?? 1;
    return {
      exitCode: response.exitCode === undefined ? 0 : response.exitCode,
      signal: response.signal ?? null,
      stdout: response.stdout ?? "",
      stderr: response.stderr ?? "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: response.timedOut ?? false,
      aborted: response.aborted ?? false,
      killConfirmed: response.killConfirmed ?? false,
      durationMs,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date(startedAt.getTime() + durationMs).toISOString(),
      error: response.error ?? null,
    };
  }
}

/** 便捷构造：所有调用返回同一响应 */
export function constantExecutor(response: FakeResponse): FakeExecutor {
  return new FakeExecutor(() => response);
}
