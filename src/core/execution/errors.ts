/** 结构化错误：统一 code/category/message/retryable/details */

import type { ErrorCategory, StructuredError } from "./types";

export function structuredError(
  code: string,
  category: ErrorCategory,
  message: string,
  options: { retryable?: boolean; details?: unknown } = {},
): StructuredError {
  return {
    code,
    category,
    message,
    retryable: options.retryable ?? false,
    ...(options.details === undefined ? {} : { details: options.details }),
  };
}

/** 实现可抛出该错误以返回结构化失败（内核不再包成 internal） */
export class CapabilityError extends Error {
  readonly structured: StructuredError;

  constructor(structured: StructuredError) {
    super(structured.message);
    this.name = "CapabilityError";
    this.structured = structured;
  }
}

/** 注册期错误：包含全部校验失败项（重复 id / 非法 schema / 非法元数据） */
export class CapabilityRegistrationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`capability 注册被拒绝：${errors.join("；")}`);
    this.name = "CapabilityRegistrationError";
    this.errors = errors;
  }
}

export function toStructuredError(err: unknown): StructuredError {
  if (err instanceof CapabilityError) return err.structured;
  return structuredError(
    "internal-error",
    "internal",
    err instanceof Error ? err.message : String(err),
  );
}

export function formatErrors(errors: string[]): string {
  return errors.join("；");
}
