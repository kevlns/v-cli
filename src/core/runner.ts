/**
 * 官方插件子进程运行器：永远不把插件代码 import 进 v-cli 进程，
 * 不解析/不包装插件 stdout——stdio 直接继承（inherit）。
 */
import { spawn } from "node:child_process";
import { VERSION } from "../version";

export interface RunPluginOptions {
  /** 可执行入口绝对路径（插件的 bin 目标文件） */
  bin: string;
  /** 原样转发的参数（含 --、--json、--help 等，一律 verbatim） */
  argv: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface RunResult {
  /** 子进程退出码；被信号杀死时为 null */
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** 注入到插件环境的 v-cli 归属信息（覆盖式叠加，不干扰其他继承变量） */
export const PLUGIN_ENV_KEYS = {
  V_CLI_HOST_VERSION: VERSION,
  V_CLI_PLUGIN_API: "1",
  V_CLI_INVOKED_BY: "v-cli",
} as const;

/** 常见信号 -> 编号（POSIX 128+N 映射用） */
const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGSTKFLT: 16,
  SIGCHLD: 17,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGTSTP: 20,
  SIGTTIN: 21,
  SIGTTOU: 22,
  SIGURG: 23,
  SIGXCPU: 24,
  SIGXFSZ: 25,
  SIGVTALRM: 26,
  SIGPROF: 27,
  SIGWINCH: 28,
  SIGIO: 29,
  SIGPWR: 30,
  SIGSYS: 31,
};

/** 运行插件入口；返回退出码与信号（不抛异常，除非 spawn 本身失败） */
export function runPluginBin({ bin, argv, env = {}, cwd }: RunPluginOptions): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...argv], {
      cwd,
      env: { ...process.env, ...PLUGIN_ENV_KEYS, ...env },
      stdio: "inherit",
      shell: false,
    });

    // v-cli 收到中断/终止信号时尽力转发给子进程；子进程退出后移除处理器
    const forward = (signal: NodeJS.Signals) => {
      try {
        child.kill(signal);
      } catch {
        // best effort：信号可能已消亡
      }
    };
    const onSigint = (): void => forward("SIGINT");
    const onSigterm = (): void => forward("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    const cleanup = (): void => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    };

    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("close", (code, signal) => {
      cleanup();
      resolve({ code, signal });
    });
  });
}

/**
 * 退出码映射：子进程退出码原样传播；被信号杀死时 POSIX 映射为 128+signum，
 * Windows 无该约定，保守返回 1。
 */
export function mapExitCode(result: RunResult): number {
  if (result.code !== null) return result.code;
  if (result.signal !== null) {
    if (process.platform !== "win32") {
      const signum = SIGNAL_NUMBERS[result.signal];
      if (signum !== undefined) return 128 + signum;
    }
    return 1;
  }
  return 1;
}