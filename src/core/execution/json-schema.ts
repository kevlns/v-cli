/**
 * 轻量 JSON Schema 子集：既校验"schema 定义本身"（注册期），
 * 也校验"真实值"（运行期输入/输出）。零依赖，错误信息带 JSON Pointer。
 *
 * 支持的关键字：type / properties / required / additionalProperties /
 * minProperties / maxProperties / items / minItems / maxItems / enum /
 * minLength / maxLength / pattern / minimum / maximum。
 */

import type { JsonSchema, JsonSchemaType } from "./types";

const TYPES: readonly JsonSchemaType[] = [
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
];

export const JSON_TYPES = TYPES;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function describeValue(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function isSchemaLike(v: unknown): v is Record<string, unknown> {
  return isPlainObject(v);
}

/** 校验 schema 定义本身；返回错误列表（空 = 合法） */
export function validateSchemaDefinition(schema: unknown, label: string): string[] {
  const errors: string[] = [];
  const ancestors = new Set<object>();

  const walk = (node: unknown, at: string): void => {
    if (!isSchemaLike(node)) {
      errors.push(`${at} 必须是对象`);
      return;
    }
    if (ancestors.has(node)) { errors.push(`${at} 含循环 schema`); return; }
    ancestors.add(node);
    const type = node.type;
    if (typeof type !== "string" || !(TYPES as readonly string[]).includes(type)) {
      errors.push(`${at}.type 必须是 [${TYPES.join(", ")}] 之一（收到 ${JSON.stringify(type)}）`);
      ancestors.delete(node);
      return;
    }
    const keywords: Record<string, string[]> = {
      object: ["properties", "required", "additionalProperties", "minProperties", "maxProperties"],
      array: ["items", "minItems", "maxItems"], string: ["minLength", "maxLength", "pattern"],
      number: ["minimum", "maximum"], integer: ["minimum", "maximum"], boolean: [], null: [],
    };
    const allowed = new Set(["type", "description", "nullable", "enum", ...keywords[type]]);
    if (["object", "array", "null"].includes(type)) allowed.delete("enum");
    for (const key of Object.keys(node)) {
      if (!allowed.has(key)) errors.push(`${at}.${key} 不在支持的 schema 关键字内`);
    }
    if (node.description !== undefined && typeof node.description !== "string") {
      errors.push(`${at}.description 必须是字符串`);
    }
    if (node.nullable !== undefined && typeof node.nullable !== "boolean") {
      errors.push(`${at}.nullable 必须是布尔值`);
    }
    if (node.enum !== undefined) {
      if (!Array.isArray(node.enum) || node.enum.length === 0) {
        errors.push(`${at}.enum 必须是非空数组`);
      } else if (type === "string" && node.enum.some((e) => typeof e !== "string")) {
        errors.push(`${at}.enum 的元素必须是字符串`);
      } else if ((type === "number" || type === "integer") && node.enum.some((e) => typeof e !== "number" || !Number.isFinite(e) || (type === "integer" && !Number.isInteger(e)))) {
        errors.push(`${at}.enum 的元素必须是数字`);
      } else if (type === "boolean" && node.enum.some((e) => typeof e !== "boolean")) {
        errors.push(`${at}.enum 的元素必须是布尔值`);
      }
    }

    if (type === "object") {
      const props = node.properties;
      if (props !== undefined) {
        if (!isPlainObject(props)) {
          errors.push(`${at}.properties 必须是对象`);
        } else {
          for (const [key, sub] of Object.entries(props)) {
            walk(sub, `${at}.properties.${key}`);
          }
        }
      }
      const required = node.required;
      if (required !== undefined) {
        if (!Array.isArray(required) || required.some((r) => typeof r !== "string" || r.length === 0)) {
          errors.push(`${at}.required 必须是非空字符串数组`);
        } else if (isPlainObject(props)) {
          for (const key of required as string[]) {
            if (!(key in props)) {
              errors.push(`${at}.required 引用了未声明的属性 "${key}"`);
            }
          }
        }
      }
      const additional = node.additionalProperties;
      if (additional !== undefined && typeof additional !== "boolean") {
        walk(additional, `${at}.additionalProperties`);
      }
      for (const key of ["minProperties", "maxProperties"] as const) {
        const value = node[key];
        if (value !== undefined && (!Number.isInteger(value) || (value as number) < 0)) {
          errors.push(`${at}.${key} 必须是非负整数`);
        }
      }
    }

    if (type === "array") {
      if (node.items !== undefined) walk(node.items, `${at}.items`);
      for (const key of ["minItems", "maxItems"] as const) {
        const value = node[key];
        if (value !== undefined && (!Number.isInteger(value) || (value as number) < 0)) {
          errors.push(`${at}.${key} 必须是非负整数`);
        }
      }
    }

    if (type === "string") {
      for (const key of ["minLength", "maxLength"] as const) {
        const value = node[key];
        if (value !== undefined && (!Number.isInteger(value) || (value as number) < 0)) {
          errors.push(`${at}.${key} 必须是非负整数`);
        }
      }
      if (node.pattern !== undefined) {
        if (typeof node.pattern !== "string") {
          errors.push(`${at}.pattern 必须是字符串`);
        } else {
          try {
            new RegExp(node.pattern);
          } catch (err) {
            errors.push(`${at}.pattern 不是合法正则: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }

    if (type === "number" || type === "integer") {
      for (const key of ["minimum", "maximum"] as const) {
        const value = node[key];
        if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
          errors.push(`${at}.${key} 必须是数字`);
        }
      }
    }
    for (const [min, max] of [["minimum", "maximum"], ["minLength", "maxLength"], ["minItems", "maxItems"], ["minProperties", "maxProperties"]]) {
      if (typeof node[min] === "number" && typeof node[max] === "number" && node[min] > node[max]) errors.push(`${at}.${min} 不能大于 ${max}`);
    }
    ancestors.delete(node);
  };

  walk(schema, label);
  return errors;
}

function matchesType(value: unknown, type: JsonSchemaType): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
  }
}

/**
 * 校验真实值；返回错误列表（空 = 通过）。
 * schema 必须已通过 validateSchemaDefinition（未校验的畸形 schema 会被保守拒绝）。
 */
export function validateValue(value: unknown, schema: JsonSchema, pointer = "$"): string[] {
  const errors: string[] = [];
  if (value === null && schema.nullable === true) {
    return errors;
  }
  if (!matchesType(value, schema.type)) {
    errors.push(`${pointer} 必须是 ${schema.type}${schema.nullable ? " 或 null" : ""}（收到 ${describeValue(value)}）`);
    return errors;
  }
  if (schema.type === "boolean" && schema.enum && !schema.enum.includes(value as boolean)) errors.push(`${pointer} 不在 enum 内`);

  if (schema.type === "object" && isPlainObject(value)) {
    // 原型污染纵深防御：危险键无论 additionalProperties 与 properties 如何声明都拒绝
    for (const key of Object.keys(value)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        errors.push(`${pointer} 含危险键 "${key}"，拒绝`);
      }
    }
    const required = schema.required ?? [];
    for (const key of required) {
      if (!Object.hasOwn(value, key)) errors.push(`${pointer} 缺少必需属性 "${key}"`);
    }
    for (const [key, sub] of Object.entries(value)) {
      const declared = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
      if (declared) {
        errors.push(...validateValue(sub, declared, `${pointer}.${key}`));
        continue;
      }
      const additional = schema.additionalProperties;
      if (additional === false) {
        errors.push(`${pointer} 含未声明属性 "${key}"（additionalProperties: false）`);
      } else if (additional !== undefined && additional !== true) {
        errors.push(...validateValue(sub, additional, `${pointer}.${key}`));
      }
    }
    const count = Object.keys(value).length;
    if (schema.minProperties !== undefined && count < schema.minProperties) {
      errors.push(`${pointer} 属性数 ${count} 少于 minProperties ${schema.minProperties}`);
    }
    if (schema.maxProperties !== undefined && count > schema.maxProperties) {
      errors.push(`${pointer} 属性数 ${count} 多于 maxProperties ${schema.maxProperties}`);
    }
  }

  if (schema.type === "array" && Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${pointer} 元素数 ${value.length} 少于 minItems ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${pointer} 元素数 ${value.length} 多于 maxItems ${schema.maxItems}`);
    }
    if (schema.items) {
      value.forEach((item, i) => {
        errors.push(...validateValue(item, schema.items as JsonSchema, `${pointer}[${i}]`));
      });
    }
  }

  if (schema.type === "string" && typeof value === "string") {
    if (schema.enum && !schema.enum.includes(value)) {
      errors.push(`${pointer} 必须是 ${schema.enum.map((e) => JSON.stringify(e)).join(" | ")} 之一`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${pointer} 长度 ${value.length} 小于 minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${pointer} 长度 ${value.length} 大于 maxLength ${schema.maxLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${pointer} 不匹配 pattern ${JSON.stringify(schema.pattern)}`);
    }
  }

  if ((schema.type === "number" || schema.type === "integer") && typeof value === "number") {
    if (schema.enum && !schema.enum.includes(value)) {
      errors.push(`${pointer} 必须是 ${schema.enum.join(" | ")} 之一`);
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${pointer} 小于 minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${pointer} 大于 maximum ${schema.maximum}`);
    }
  }

  return errors;
}

/** 校验对象值并给出顶层错误摘要（运行期使用） */
export function assertObjectValue(value: unknown, schema: JsonSchema, pointer = "$"): string[] {
  return validateValue(value, schema, pointer);
}
