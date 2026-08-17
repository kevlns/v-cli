import type { Command } from "commander";
import type { CliCommand } from "../core/command";
import type { CliContext } from "../core/context";

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().replace("T", " ").replace("Z", "");
}

function parseInput(input: string): { seconds: number; milliseconds: number; raw: string } {
  if (/^\d+$/.test(input)) {
    const n = Number(input);
    if (n > 1e12) {
      return { seconds: Math.floor(n / 1000), milliseconds: n, raw: input };
    }
    return { seconds: n, milliseconds: n * 1000, raw: input };
  }
  const parsed = Date.parse(input);
  if (Number.isNaN(parsed)) {
    throw new Error(`无法解析时间: ${input}`);
  }
  return { seconds: Math.floor(parsed / 1000), milliseconds: parsed, raw: input };
}

/** 时间戳工具：无参=当前时间，数字=时间戳转时间，日期串=转时间戳 */
export const ts: CliCommand = {
  name: "ts",
  description: "时间戳工具：时间戳 <-> 可读时间互转",

  register(program: Command, ctx: CliContext) {
    program
      .argument("[value]", "数字时间戳（秒或毫秒，自动识别）或日期字符串")
      .action((value?: string) => {
        if (!value || value === "now") {
          const now = Date.now();
          const report = {
            seconds: Math.floor(now / 1000),
            milliseconds: now,
            iso: new Date(now).toISOString(),
            local: new Date(now).toString(),
          };
          ctx.log.result(ctx.json ? report : report.iso);
          return;
        }
        const result = parseInput(value);
        const report = {
          input: result.raw,
          seconds: result.seconds,
          milliseconds: result.milliseconds,
          iso: new Date(result.milliseconds).toISOString(),
          local: formatTime(result.milliseconds),
        };
        ctx.log.result(ctx.json ? report : report.local);
      });
  },
};