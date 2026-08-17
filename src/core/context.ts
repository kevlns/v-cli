import os from "node:os";
import path from "node:path";
import { ConfigStore } from "./config";
import { Logger } from "./logger";

/** 统一上下文：命令通过 ctx 访问 logger/config/homeDir，行为全局一致 */
export interface CliContext {
  log: Logger;
  config: ConfigStore;
  json: boolean;
  homeDir: string;
}

export function createContext(homeDir: string, json: boolean): CliContext {
  return {
    log: new Logger(json),
    config: ConfigStore.fromHome(homeDir),
    json,
    homeDir,
  };
}

/** 默认主目录 ~/.vcli，VCLI_HOME 可覆盖（测试/多配置） */
export function defaultHomeDir(): string {
  return process.env.VCLI_HOME || path.join(os.homedir(), ".vcli");
}