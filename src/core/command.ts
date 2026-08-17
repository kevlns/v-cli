import type { Command } from "commander";
import type { CliContext } from "./context";

/** 命令契约：所有命令（内置或本地插件）需实现该接口 */
export interface CliCommand {
  name: string;
  description: string;
  hidden?: boolean;
  register(program: Command, ctx: CliContext): void;
}

/** 校验对象是否符合 CliCommand 形状（本地插件加载用） */
export function isCliCommand(candidate: unknown): candidate is CliCommand {
  if (typeof candidate !== "object" || candidate === null) return false;
  const cmd = candidate as Partial<CliCommand>;
  return (
    typeof cmd.name === "string" &&
    typeof cmd.description === "string" &&
    typeof cmd.register === "function"
  );
}