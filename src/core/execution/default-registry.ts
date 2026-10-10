/** 默认 capability 注册表：注册内置 provider（当前仅 unity） */

import { CapabilityRegistry } from "./registry";
import type { ProcessExecutor } from "./executor";
import { NodeProcessExecutor } from "./executor";
import { createUnityProvider, type UnityProviderDeps } from "../../providers/unity";

export interface DefaultRegistryOptions {
  executor?: ProcessExecutor;
  /** 覆盖 Unity 后端发现（测试/夹具注入） */
  discoverBackend?: UnityProviderDeps["discoverBackend"];
  /** 覆盖 Unity 后端环境变量 */
  unityEnv?: Record<string, string | undefined>;
}

/** 构建内置注册表；注册失败是编码错误，直接抛出 */
export function createDefaultRegistry(options: DefaultRegistryOptions = {}): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registry.registerProvider(
    createUnityProvider({
      executor: options.executor ?? new NodeProcessExecutor(),
      discoverBackend: options.discoverBackend,
      env: options.unityEnv,
    }),
  );
  return registry;
}
