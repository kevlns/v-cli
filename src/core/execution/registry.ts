/**
 * Capability / Provider 注册表：注册即校验，list/describe 只读描述（绝不执行工具）。
 *
 * 拒绝条件（全部在注册期抛出 CapabilityRegistrationError，错误项逐条列出）：
 * - provider/capability id 非法或重复（跨 provider 全局唯一）
 * - capability id 未带 provider 命名空间前缀
 * - 版本号、描述、tags 等元数据类型错误
 * - 输入/输出 schema 不是合法 JSON Schema 子集，或顶层不是 object
 * - 前置条件 / 副作用 / 资源 / 重试语义缺失或非法
 * - descriptor.preconditions 与 implementation.preconditions 不一一对应
 */

import {
  CapabilityRegistrationError,
  formatErrors,
} from "./errors";
import { validateSchemaDefinition } from "./json-schema";
import type {
  CapabilityDescriptor,
  CapabilityImplementation,
  CapabilityProvider,
  CapabilityRegistration,
  CapabilitySummary,
  JsonSchema,
  ProviderInfo,
  ProviderStatus,
  RetrySemantics,
  SideEffectDeclaration,
  ResourceRequirement,
} from "./types";

const ID_RE = /^[a-z][a-z0-9-]*$/;
const CAPABILITY_ID_RE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const SIDE_EFFECT_KINDS = ["process-exec", "fs-write", "fs-read", "engine-state", "network"] as const;
const RESOURCE_KINDS = ["project-workspace", "engine-editor", "build-target", "user-cache", "network"] as const;
const RESOURCE_MODES = ["exclusive", "shared"] as const;
const RESOURCE_SCOPES = ["project", "machine"] as const;
const RETRY_STRATEGIES = ["none", "rerun", "poll-status"] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** 校验 provider 元数据（注册 provider 时） */
export function validateProvider(provider: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(provider)) return ["provider 必须是对象"];
  if (!isNonEmptyString(provider.id) || !ID_RE.test(provider.id)) {
    errors.push(`provider.id 必须是匹配 ^[a-z][a-z0-9-]*$ 的字符串（收到 ${JSON.stringify(provider.id)}）`);
  }
  if (!isNonEmptyString(provider.version) || !VERSION_RE.test(provider.version)) {
    errors.push(`provider.version 必须是语义化版本（收到 ${JSON.stringify(provider.version)}）`);
  }
  if (!isNonEmptyString(provider.description)) {
    errors.push("provider.description 必须是非空字符串");
  }
  if (typeof provider.status !== "function") {
    errors.push("provider.status 必须是函数（只做发现，不得执行工具）");
  }
  if (typeof provider.capabilities !== "function") {
    errors.push("provider.capabilities 必须是函数");
  }
  return errors;
}

function validateRetry(retry: unknown, at: string): string[] {
  const errors: string[] = [];
  if (!isPlainObject(retry)) return [`${at} 必须是对象`];
  if (typeof retry.safe !== "boolean") errors.push(`${at}.safe 必须是布尔值`);
  if (!Number.isInteger(retry.maxAttempts) || (retry.maxAttempts as number) < 1) {
    errors.push(`${at}.maxAttempts 必须是 >= 1 的整数`);
  }
  if (!isNonEmptyString(retry.strategy) || !(RETRY_STRATEGIES as readonly string[]).includes(retry.strategy)) {
    errors.push(`${at}.strategy 必须是 [${RETRY_STRATEGIES.join(", ")}] 之一`);
  }
  if (!isNonEmptyString(retry.description)) errors.push(`${at}.description 必须是非空字符串`);
  return errors;
}

function validatePreconditions(list: unknown, at: string): string[] {
  const errors: string[] = [];
  if (!Array.isArray(list)) return [`${at} 必须是数组`];
  const seen = new Set<string>();
  list.forEach((entry, i) => {
    const where = `${at}[${i}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${where} 必须是对象`);
      return;
    }
    if (!isNonEmptyString(entry.id) || !CAPABILITY_ID_RE.test(entry.id)) {
      errors.push(`${where}.id 必须是带命名空间的稳定 id（如 unity.pipeline-ready）`);
    } else if (seen.has(entry.id)) {
      errors.push(`${where}.id "${entry.id}" 重复`);
    } else {
      seen.add(entry.id);
    }
    if (!isNonEmptyString(entry.description)) errors.push(`${where}.description 必须是非空字符串`);
  });
  return errors;
}

function validateSideEffects(list: unknown, at: string): string[] {
  const errors: string[] = [];
  if (!Array.isArray(list)) return [`${at} 必须是数组（无副作用也要显式声明空数组）`];
  const seen = new Set<string>();
  list.forEach((entry, i) => {
    const where = `${at}[${i}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${where} 必须是对象`);
      return;
    }
    if (!isNonEmptyString(entry.id) || !ID_RE.test(entry.id)) {
      errors.push(`${where}.id 必须是匹配 ^[a-z][a-z0-9-]*$ 的字符串`);
    } else if (seen.has(entry.id)) {
      errors.push(`${where}.id "${entry.id}" 重复`);
    } else {
      seen.add(entry.id);
    }
    if (!isNonEmptyString(entry.kind) || !(SIDE_EFFECT_KINDS as readonly string[]).includes(entry.kind)) {
      errors.push(`${where}.kind 必须是 [${SIDE_EFFECT_KINDS.join(", ")}] 之一`);
    }
    if (!isNonEmptyString(entry.description)) errors.push(`${where}.description 必须是非空字符串`);
    if (typeof entry.reversible !== "boolean") errors.push(`${where}.reversible 必须是布尔值`);
  });
  return errors;
}

function validateResources(list: unknown, at: string): string[] {
  const errors: string[] = [];
  if (!Array.isArray(list)) return [`${at} 必须是数组（无资源需求也要显式声明空数组）`];
  list.forEach((entry, i) => {
    const where = `${at}[${i}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${where} 必须是对象`);
      return;
    }
    if (!isNonEmptyString(entry.kind) || !(RESOURCE_KINDS as readonly string[]).includes(entry.kind)) {
      errors.push(`${where}.kind 必须是 [${RESOURCE_KINDS.join(", ")}] 之一`);
    }
    if (!isNonEmptyString(entry.mode) || !(RESOURCE_MODES as readonly string[]).includes(entry.mode)) {
      errors.push(`${where}.mode 必须是 [${RESOURCE_MODES.join(", ")}] 之一`);
    }
    if (!isNonEmptyString(entry.scope) || !(RESOURCE_SCOPES as readonly string[]).includes(entry.scope)) {
      errors.push(`${where}.scope 必须是 [${RESOURCE_SCOPES.join(", ")}] 之一`);
    }
    if (!isNonEmptyString(entry.description)) errors.push(`${where}.description 必须是非空字符串`);
  });
  return errors;
}

/** 校验 capability 描述与实现；providerId 用于命名空间前缀核对 */
export function validateCapability(
  descriptor: unknown,
  implementation: unknown,
  providerId: string,
): string[] {
  const errors: string[] = [];
  if (!isPlainObject(descriptor)) return ["descriptor 必须是对象"];
  const d = descriptor as Partial<CapabilityDescriptor>;

  if (!isNonEmptyString(d.id) || !CAPABILITY_ID_RE.test(d.id)) {
    errors.push(`id 必须是带命名空间的稳定 id（如 unity.compile；收到 ${JSON.stringify(d.id)}）`);
  } else if (!d.id.startsWith(`${providerId}.`)) {
    errors.push(`id "${d.id}" 必须使用 provider 命名空间前缀 "${providerId}."`);
  }
  if (!isNonEmptyString(d.version) || !VERSION_RE.test(d.version)) {
    errors.push(`version 必须是语义化版本（收到 ${JSON.stringify(d.version)}）`);
  }
  if (!isNonEmptyString(d.description)) errors.push("description 必须是非空字符串");

  for (const key of ["inputSchema", "outputSchema"] as const) {
    const schema = d[key] as unknown;
    const schemaErrors = validateSchemaDefinition(schema, key);
    if (schemaErrors.length > 0) {
      errors.push(...schemaErrors);
    } else if ((schema as JsonSchema).type !== "object") {
      errors.push(`${key}.type 必须是 object（capability 契约固定为结构化对象）`);
    }
  }

  errors.push(...validatePreconditions(d.preconditions, "preconditions"));
  errors.push(...validateSideEffects(d.sideEffects, "sideEffects"));
  errors.push(...validateResources(d.resources, "resources"));
  errors.push(...validateRetry(d.retry, "retry"));

  if (d.timeoutMs !== undefined && (!Number.isInteger(d.timeoutMs) || d.timeoutMs <= 0)) {
    errors.push("timeoutMs 必须是正整数");
  }
  if (d.tags !== undefined) {
    if (!Array.isArray(d.tags) || d.tags.some((t) => !isNonEmptyString(t))) {
      errors.push("tags 必须是非空字符串数组");
    }
  }

  if (!isPlainObject(implementation) || typeof implementation.execute !== "function") {
    errors.push("implementation.execute 必须是函数");
    return errors;
  }

  const declared = new Set(
    Array.isArray(d.preconditions)
      ? d.preconditions.filter((p) => isPlainObject(p) && isNonEmptyString(p.id)).map((p) => p.id as string)
      : [],
  );
  const checkers = implementation.preconditions;
  const provided = new Set(checkers && isPlainObject(checkers) ? Object.keys(checkers) : []);
  for (const id of declared) {
    if (!provided.has(id)) errors.push(`缺少前置条件检查实现: ${id}`);
    else if (typeof (checkers as Record<string, unknown>)[id] !== "function") errors.push(`前置条件检查必须是函数: ${id}`);
  }
  for (const id of provided) {
    if (!declared.has(id)) errors.push(`存在未声明的前置条件检查实现: ${id}`);
  }

  return errors;
}

interface Entry {
  descriptor: CapabilityDescriptor;
  implementation: CapabilityImplementation;
  provider: ProviderInfo;
}

export class CapabilityRegistry {
  private readonly providersById = new Map<string, CapabilityProvider>();
  private readonly entries = new Map<string, Entry>();

  /** 注册 provider 及其全部能力；任一项非法则整体拒绝，不产生部分注册 */
  registerProvider(provider: CapabilityProvider): void {
    const providerErrors = validateProvider(provider);
    if (providerErrors.length > 0) {
      throw new CapabilityRegistrationError(providerErrors);
    }
    if (this.providersById.has(provider.id)) {
      throw new CapabilityRegistrationError([`provider id "${provider.id}" 重复`]);
    }

    const registrations = provider.capabilities();
    if (!Array.isArray(registrations) || registrations.length === 0) {
      throw new CapabilityRegistrationError([`provider "${provider.id}" 未声明任何 capability`]);
    }

    const errors: string[] = [];
    const pending: { descriptor: CapabilityDescriptor; implementation: CapabilityImplementation }[] = [];
    for (const registration of registrations) {
      const item = registration as CapabilityRegistration;
      const itemErrors = validateCapability(item?.descriptor, item?.implementation, provider.id);
      if (itemErrors.length > 0) {
        errors.push(...itemErrors);
        continue;
      }
      if (this.entries.has(item.descriptor.id)) {
        errors.push(`capability id "${item.descriptor.id}" 重复`);
        continue;
      }
      if (pending.some((p) => p.descriptor.id === item.descriptor.id)) {
        errors.push(`capability id "${item.descriptor.id}" 在同一 provider 内重复`);
        continue;
      }
      pending.push({ descriptor: item.descriptor, implementation: item.implementation });
    }
    if (errors.length > 0) throw new CapabilityRegistrationError(errors);

    const info: ProviderInfo = {
      id: provider.id,
      version: provider.version,
      description: provider.description,
    };
    this.providersById.set(provider.id, { ...provider });
    for (const item of pending) {
      this.entries.set(item.descriptor.id, {
        descriptor: structuredClone(item.descriptor),
        implementation: { ...item.implementation, preconditions: { ...item.implementation.preconditions } },
        provider: info,
      });
    }
  }

  /** provider 发现状态（只读发现，不执行工具） */
  async providerStatus(providerId: string): Promise<ProviderStatus | undefined> {
    const provider = this.providersById.get(providerId);
    if (!provider) return undefined;
    try {
      return await provider.status();
    } catch (err) {
      return { state: "unavailable", detail: err instanceof Error ? err.message : String(err) };
    }
  }

  providers(): ProviderInfo[] {
    return [...this.providersById.values()].map((p) => ({
      id: p.id,
      version: p.version,
      description: p.description,
    }));
  }

  list(): CapabilitySummary[] {
    return [...this.entries.values()]
      .map((entry) => this.summarize(entry))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  describe(id: string): (CapabilityDescriptor & { provider: ProviderInfo }) | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    return structuredClone({ ...entry.descriptor, provider: entry.provider });
  }

  get(id: string): Entry | undefined {
    const entry = this.entries.get(id);
    return entry ? { ...entry, descriptor: structuredClone(entry.descriptor), provider: { ...entry.provider }, implementation: { ...entry.implementation, preconditions: { ...entry.implementation.preconditions } } } : undefined;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  private summarize(entry: Entry): CapabilitySummary {
    return {
      id: entry.descriptor.id,
      version: entry.descriptor.version,
      description: entry.descriptor.description,
      provider: { ...entry.provider },
      tags: [...(entry.descriptor.tags ?? [])],
      preconditions: entry.descriptor.preconditions.map((p) => p.id),
      sideEffectKinds: [...new Set(entry.descriptor.sideEffects.map((s: SideEffectDeclaration) => s.kind))],
      resources: entry.descriptor.resources.map((r: ResourceRequirement) => ({
        kind: r.kind,
        mode: r.mode,
        scope: r.scope,
      })),
      retry: { ...(entry.descriptor.retry as RetrySemantics) },
    };
  }
}

export { formatErrors };
