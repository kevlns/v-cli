import { describe, expect, it } from "vitest";
import { CapabilityRegistrationError } from "../src/core/execution/errors";
import { validateSchemaDefinition, validateValue } from "../src/core/execution/json-schema";
import { CapabilityRegistry, validateCapability, validateProvider } from "../src/core/execution/registry";
import type {
  CapabilityDescriptor,
  CapabilityImplementation,
  CapabilityProvider,
  JsonSchema,
  ProviderBindingContract,
} from "../src/core/execution/types";

/** 最小合法绑定契约（注册期校验基准） */
const MINIMAL_BINDING: ProviderBindingContract = {
  schema: { type: "object", additionalProperties: false, properties: {} },
  pathFields: [],
  resolve: () => ({ ok: true, dirs: {}, files: {}, warnings: [] }),
};

const INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: { type: "string", enum: ["EditMode", "PlayMode"] },
    count: { type: "integer", minimum: 0, maximum: 10 },
    note: { type: "string", nullable: true },
  },
  required: ["mode"],
};

const OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
};

function descriptor(overrides: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  return {
    id: "demo.echo",
    version: "0.1.0",
    description: "示例能力",
    inputSchema: INPUT_SCHEMA,
    outputSchema: OUTPUT_SCHEMA,
    preconditions: [{ id: "demo.ready", description: "就绪" }],
    sideEffects: [],
    resources: [],
    retry: { safe: true, maxAttempts: 1, strategy: "none", description: "只读" },
    ...overrides,
  };
}

function implementation(overrides: Partial<CapabilityImplementation> = {}): CapabilityImplementation {
  return {
    preconditions: {
      "demo.ready": () => ({ id: "demo.ready", status: "satisfied", detail: "ok" }),
    },
    execute: async () => ({
      execution: { status: "succeeded", lifecycle: "completed", exitCode: 0 },
      acceptance: { status: "not-run", reason: "无验收定义", pending: false, evidence: [] },
      output: { ok: true },
    }),
    ...overrides,
  };
}

function provider(
  capabilities: { descriptor: CapabilityDescriptor; implementation: CapabilityImplementation }[],
  overrides: Partial<CapabilityProvider> = {},
): CapabilityProvider {
  return {
    id: "demo",
    version: "0.1.0",
    description: "示例 provider",
    status: () => ({ state: "available", detail: "ok" }),
    capabilities: () => capabilities,
    binding: MINIMAL_BINDING,
    ...overrides,
  };
}

describe("schema 定义校验（注册期）", () => {
  it("缺少 type / 未知 type / 非法关键字被拒绝", () => {
    expect(validateSchemaDefinition({}, "s")).toContain("s.type 必须是 [object, array, string, number, integer, boolean, null] 之一（收到 undefined）");
    for (const bad of [{ type: "any" }, { type: "object", properties: 1 }, { type: "string", pattern: "[" }]) {
      expect(validateSchemaDefinition(bad, "s").length, JSON.stringify(bad)).toBeGreaterThan(0);
    }
  });

  it("required 引用未声明属性被拒绝；nullable 必须是布尔", () => {
    expect(validateSchemaDefinition({ type: "object", properties: { a: { type: "string" } }, required: ["b"] }, "s")).toContain(
      's.required 引用了未声明的属性 "b"',
    );
    expect(validateSchemaDefinition({ type: "string", nullable: "yes" }, "s")).toContain("s.nullable 必须是布尔值");
  });

  it("合法 schema 通过（含 additionalProperties 子 schema 与 nullable）", () => {
    expect(
      validateSchemaDefinition(
        {
          type: "object",
          nullable: true,
          properties: { a: { type: "string", nullable: true }, b: { type: "array", items: { type: "integer" } } },
          additionalProperties: { type: "string" },
          required: ["a"],
        },
        "s",
      ),
    ).toEqual([]);
  });
});

describe("真实值校验（运行期）", () => {
  it("类型/required/enum/additionalProperties/边界都生效", () => {
    expect(validateValue({ mode: "EditMode" }, INPUT_SCHEMA)).toEqual([]);
    expect(validateValue({}, INPUT_SCHEMA)[0]).toContain('缺少必需属性 "mode"');
    expect(validateValue({ mode: "Play" }, INPUT_SCHEMA)[0]).toContain("必须是");
    expect(validateValue({ mode: "EditMode", extra: 1 }, INPUT_SCHEMA)[0]).toContain('含未声明属性 "extra"');
    expect(validateValue({ mode: "EditMode", count: 11 }, INPUT_SCHEMA)[0]).toContain("maximum 10");
    expect(validateValue({ mode: "EditMode", count: 1.5 }, INPUT_SCHEMA)[0]).toContain("必须是 integer");
    expect(validateValue({ mode: "EditMode", note: null }, INPUT_SCHEMA)).toEqual([]);
  });

  it("输出校验：缺字段/多字段/类型错误都被报告（带 JSON Pointer）", () => {
    expect(validateValue({ ok: true }, OUTPUT_SCHEMA)).toEqual([]);
    expect(validateValue({}, OUTPUT_SCHEMA)[0]).toContain('$ 缺少必需属性 "ok"');
    expect(validateValue({ ok: true, extra: 1 }, OUTPUT_SCHEMA)[0]).toContain('$ 含未声明属性 "extra"');
    expect(validateValue({ ok: "yes" }, OUTPUT_SCHEMA)[0]).toContain("$.ok 必须是 boolean");
  });
});

describe("Capability 注册校验", () => {
  it("非法 provider 元数据被拒绝", () => {
    expect(validateProvider(null)).toEqual(["provider 必须是对象"]);
    const errors = validateProvider({ id: "Bad", version: "1", description: "", status: 1, capabilities: 2 });
    expect(errors.join()).toContain("provider.id");
    expect(errors.join()).toContain("provider.version");
    expect(errors.join()).toContain("provider.description");
    expect(errors.join()).toContain("provider.status 必须是函数");
    expect(errors.join()).toContain("provider.capabilities 必须是函数");
  });

  it("绑定契约缺失或非法被拒绝（schema 非 object / pathFields 未声明 / resolve 非函数 / defaultBinding 非函数）", () => {
    expect(
      validateProvider(provider([], { binding: undefined as unknown as ProviderBindingContract })),
    ).toContainEqual(expect.stringContaining("provider.binding 必须是对象"));

    const badSchema = { ...MINIMAL_BINDING, schema: { type: "string" } as JsonSchema };
    expect(validateProvider(provider([], { binding: badSchema }))).toContainEqual(
      expect.stringContaining("provider.binding.schema.type 必须是 object"),
    );

    const undeclaredField: ProviderBindingContract = {
      schema: { type: "object", additionalProperties: false, properties: {} },
      pathFields: [{ field: "workspaceDir", kind: "dir", required: true }],
      resolve: () => ({ ok: true, dirs: {}, files: {}, warnings: [] }),
    };
    expect(validateProvider(provider([], { binding: undeclaredField }))).toContainEqual(
      expect.stringContaining('未在 provider.binding.schema.properties 中声明'),
    );

    const noResolve = { schema: MINIMAL_BINDING.schema, pathFields: [] };
    expect(validateProvider(provider([], { binding: noResolve as unknown as ProviderBindingContract }))).toContainEqual(
      expect.stringContaining("provider.binding.resolve 必须是函数"),
    );

    expect(
      validateProvider(provider([], { defaultBinding: "nope" as unknown as CapabilityProvider["defaultBinding"] })),
    ).toContainEqual(expect.stringContaining("provider.defaultBinding 出现时必须是函数"));
  });

  it("capability id 必须带 provider 命名空间前缀", () => {
    const errors = validateCapability(descriptor({ id: "other.echo" }), implementation(), "demo");
    expect(errors.join()).toContain('必须使用 provider 命名空间前缀 "demo."');
  });

  it("前置条件声明与检查实现必须一一对应", () => {
    const missing = validateCapability(descriptor(), implementation({ preconditions: {} }), "demo");
    expect(missing.join()).toContain("缺少前置条件检查实现: demo.ready");
    const extra = validateCapability(
      descriptor(),
      implementation({
        preconditions: {
          "demo.ready": () => ({ id: "demo.ready", status: "satisfied", detail: "" }),
          "demo.extra": () => ({ id: "demo.extra", status: "satisfied", detail: "" }),
        },
      }),
      "demo",
    );
    expect(extra.join()).toContain("存在未声明的前置条件检查实现: demo.extra");
  });

  it("副作用/资源/重试语义缺失或非法被拒绝", () => {
    const errors = validateCapability(
      descriptor({
        sideEffects: [{ id: "x", kind: "bad-kind" as never, description: "d", reversible: false }],
        resources: [{ kind: "bad" as never, mode: "exclusive", scope: "project", description: "d" }],
        retry: { safe: true, maxAttempts: 0, strategy: "nope" as never, description: "" },
      }),
      implementation(),
      "demo",
    );
    expect(errors.join()).toContain("sideEffects[0].kind");
    expect(errors.join()).toContain("resources[0].kind");
    expect(errors.join()).toContain("retry.maxAttempts");
    expect(errors.join()).toContain("retry.strategy");
  });

  it("输入/输出 schema 顶层必须是 object", () => {
    const errors = validateCapability(
      descriptor({ inputSchema: { type: "string" } as unknown as JsonSchema }),
      implementation(),
      "demo",
    );
    expect(errors.join()).toContain("inputSchema.type 必须是 object");
  });
});

describe("CapabilityRegistry", () => {
  it("注册成功后 list/describe 可用且排序稳定", () => {
    const registry = new CapabilityRegistry();
    registry.registerProvider(
      provider([
        { descriptor: descriptor({ id: "demo.zeta" }), implementation: implementation() },
        { descriptor: descriptor({ id: "demo.alpha" }), implementation: implementation() },
      ]),
    );
    expect(registry.list().map((r) => r.id)).toEqual(["demo.alpha", "demo.zeta"]);
    expect(registry.describe("demo.alpha")?.provider.id).toBe("demo");
    expect(registry.has("demo.alpha")).toBe(true);
    expect(registry.providers().map((p) => p.id)).toEqual(["demo"]);
  });

  it("重复 provider id / 重复 capability id 被拒绝", () => {
    const registry = new CapabilityRegistry();
    registry.registerProvider(provider([{ descriptor: descriptor(), implementation: implementation() }]));
    expect(() => registry.registerProvider(provider([{ descriptor: descriptor({ id: "demo.other" }), implementation: implementation() }]))).toThrow(
      CapabilityRegistrationError,
    );
    const second = new CapabilityRegistry();
    second.registerProvider(provider([{ descriptor: descriptor(), implementation: implementation() }]));
    expect(() =>
      second.registerProvider(
        provider([{ descriptor: descriptor({ id: "demo.alpha" }), implementation: implementation() }], {
          id: "other",
          capabilities: () => [
            { descriptor: descriptor({ id: "demo.alpha" }), implementation: implementation() },
          ],
        }),
      ),
    ).toThrow(/命名空间前缀/);
  });

  it("同一 provider 内重复 capability id 被拒绝，且不产生部分注册", () => {
    const registry = new CapabilityRegistry();
    expect(() =>
      registry.registerProvider(
        provider([
          { descriptor: descriptor({ id: "demo.same" }), implementation: implementation() },
          { descriptor: descriptor({ id: "demo.same" }), implementation: implementation() },
        ]),
      ),
    ).toThrow(/重复/);
    expect(registry.list()).toEqual([]);
    expect(registry.providers()).toEqual([]);
  });

  it("非法 schema / 非法元数据抛出注册错误且无部分注册", () => {
    const registry = new CapabilityRegistry();
    try {
      registry.registerProvider(
        provider([
          { descriptor: descriptor({ outputSchema: { type: "object", properties: { a: { type: "nope" as never } } } }), implementation: implementation() },
        ]),
      );
      throw new Error("应当抛出");
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityRegistrationError);
      expect((err as CapabilityRegistrationError).errors.join()).toContain("outputSchema.properties.a.type");
    }
    expect(registry.list()).toEqual([]);
  });

  it("无 capability 的 provider 被拒绝", () => {
    const registry = new CapabilityRegistry();
    expect(() => registry.registerProvider(provider([]))).toThrow(/未声明任何 capability/);
  });

  it("list/describe 不执行工具（execute 计数保持 0）", () => {
    let executed = 0;
    let statusCalled = 0;
    const registry = new CapabilityRegistry();
    registry.registerProvider(
      provider([{ descriptor: descriptor(), implementation: implementation({ execute: async () => {
        executed++;
        return { execution: { status: "succeeded", lifecycle: "completed" }, acceptance: { status: "not-run", reason: "" } };
      } }) }], {
        status: () => {
          statusCalled++;
          return { state: "available", detail: "ok" };
        },
      }),
    );
    registry.list();
    registry.describe("demo.echo");
    expect(executed).toBe(0);
    expect(statusCalled).toBe(0);
  });

  it("providerStatus 捕获发现异常并归类为 unavailable（不抛出）", async () => {
    const registry = new CapabilityRegistry();
    registry.registerProvider(
      provider([{ descriptor: descriptor(), implementation: implementation() }], {
        status: () => {
          throw new Error("discover boom");
        },
      }),
    );
    const status = await registry.providerStatus("demo");
    expect(status?.state).toBe("unavailable");
    expect(status?.detail).toContain("discover boom");
    expect(await registry.providerStatus("nope")).toBeUndefined();
  });
});

describe("审查回归：schema 和注册快照", () => {
  it("拒绝不支持的关键字、循环 schema 和倒置边界", () => {
    for (const schema of [{ type: "string", format: "email" }, { type: "number", minimum: 2, maximum: 1 }, { type: "object", enum: [{}] }]) expect(validateSchemaDefinition(schema, "s").length).toBeGreaterThan(0);
    const cyclic: any = { type: "object", properties: {} }; cyclic.properties.self = cyclic;
    expect(validateSchemaDefinition(cyclic, "s").join()).toContain("循环");
    expect(validateValue(false, { type: "boolean", enum: [true] }).length).toBeGreaterThan(0);
  });
  it("注册和查询均隔离外部修改", () => {
    const d = descriptor(); const r = new CapabilityRegistry(); r.registerProvider(provider([{ descriptor: d, implementation: implementation() }]));
    d.inputSchema = { type: "object" };
    r.describe("demo.echo")!.inputSchema = { type: "object" };
    const queried = r.get("demo.echo")!; queried.descriptor.inputSchema = { type: "object" };
    expect(r.describe("demo.echo")!.inputSchema).toEqual(INPUT_SCHEMA);
  });
});
