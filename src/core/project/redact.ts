/**
 * 凭据脱敏：落盘前对输入/参数做键名匹配替换。
 *
 * 目的：默认参数不把凭据写进 .vant/state/operations 记录。
 * 说明：这是"键名 + 值形态"的保守脱敏，不是内容级 DLP；
 * 工具自身 stdout/stderr 属于证据原文，按日志原样保存（见 spec 文档的取舍说明）。
 */

const SECRET_KEY_RE =
  /(pass(word|phrase)?|secret|token|credential|auth|api[-_]?key|apikey|private[-_]?key|access[-_]?key|cookie|session|bearer)/i;

export interface RedactionResult<T> {
  value: T;
  /** 被替换的键路径（JSON Pointer 风格） */
  redactedPaths: string[];
}

const REDACTED = "***redacted***";

export function redactSecrets<T>(input: T): RedactionResult<T> {
  const redactedPaths: string[] = [];
  const seen = new WeakSet<object>();

  const walk = (value: unknown, pointer: string): unknown => {
    if (Array.isArray(value)) {
      if (seen.has(value)) return "[circular]";
      seen.add(value);
      return value.map((item, i) => walk(item, `${pointer}[${i}]`));
    }
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[circular]";
      seen.add(value);
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const child = pointer === "$" ? `$.${key}` : `${pointer}.${key}`;
        if (SECRET_KEY_RE.test(key)) {
          out[key] = item === undefined || item === null ? item : REDACTED;
          if (item !== undefined && item !== null) redactedPaths.push(child);
          continue;
        }
        out[key] = walk(item, child);
      }
      return out;
    }
    return value;
  };

  return { value: walk(input, "$") as T, redactedPaths };
}

/** argv 级脱敏：`--token=xxx` / `--token xxx` 形态直接替换值 */
export function redactArgv(argv: string[]): RedactionResult<string[]> {
  const redactedPaths: string[] = [];
  const out = [...argv];
  for (let i = 0; i < out.length; i++) {
    const token = out[i];
    const eq = /^--?([A-Za-z0-9._-]+)=(.*)$/.exec(token);
    if (eq && SECRET_KEY_RE.test(eq[1])) {
      out[i] = `--${eq[1]}=${REDACTED}`;
      redactedPaths.push(`argv[${i}]`);
      continue;
    }
    if (/^--?[A-Za-z0-9._-]+$/.test(token) && SECRET_KEY_RE.test(token.replace(/^--?/, ""))) {
      if (i + 1 < out.length) {
        out[i + 1] = REDACTED;
        redactedPaths.push(`argv[${i + 1}]`);
        i++;
      }
    }
  }
  return { value: out, redactedPaths };
}

export const REDACTION_PLACEHOLDER = REDACTED;
