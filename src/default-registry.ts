/**
 * 默认 capability 注册表：显式装配内置 Provider。
 *
 * 位于 src/ 根（不在 src/core/** 内）：core 不得 import providers（方向约束，
 * 测试覆盖）。SDK/CLI 缺省用它；调用方可通过 providers 提供完整集合。
 */

import { CapabilityRegistry } from "./core/execution/registry";
import type { ProcessExecutor } from "./core/execution/executor";
import { NodeProcessExecutor } from "./core/execution/executor";
import type { CapabilityProvider } from "./core/execution/types";
import { createUnityProvider, type UnityProviderDeps } from "./providers/unity";

export interface DefaultRegistryOptions {
  executor?: ProcessExecutor;
  /** 完整 Provider 集合（提供即完全替代内置装配；顺序即注册顺序） */
  providers?: CapabilityProvider[];
  /** 覆盖 Unity 后端发现（测试/夹具注入；providers 提供时忽略） */
  discoverBackend?: UnityProviderDeps["discoverBackend"];
  /** 覆盖 Unity 后端环境变量（providers 提供时忽略） */
  unityEnv?: Record<string, string | undefined>;
}

/** 构建注册表；注册失败是编码错误，直接抛出 */
export function createDefaultRegistry(options: DefaultRegistryOptions = {}): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  if (options.providers !== undefined) {
    for (const provider of options.providers) registry.registerProvider(provider);
    return registry;
  }
  registry.registerProvider(
    createUnityProvider({
      executor: options.executor ?? new NodeProcessExecutor(),
      discoverBackend: options.discoverBackend,
      env: options.unityEnv,
    }),
  );
  return registry;
}
