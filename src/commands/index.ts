import type { CliCommand } from "../core/command";
import { agent } from "./agent";
import { capability } from "./capability";
import { doctor } from "./doctor";
import { plugin } from "./plugin";
import { project } from "./project";
import { ts } from "./ts";

/** 内置命令注册表：新增内置命令时在此登记 */
export const builtinCommands: CliCommand[] = [doctor, plugin, ts, agent, project, capability];
