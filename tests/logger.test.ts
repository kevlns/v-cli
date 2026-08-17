import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger } from "../src/core/logger";

function capture() {
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return { out, err };
}

afterEach(() => vi.restoreAllMocks());

describe("Logger 双通道", () => {
  it("result 走 stdout，info/warn/error 走 stderr", () => {
    const { out, err } = capture();
    const log = new Logger(false);
    log.result("hello");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(out).toHaveBeenCalledWith("hello\n");
    expect(err.mock.calls.map((c) => String(c[0])).join("")).toContain("i");
    expect(err.mock.calls.map((c) => String(c[0])).join("")).toContain("w");
    expect(err.mock.calls.map((c) => String(c[0])).join("")).toContain("e");
  });

  it("json 模式下 result 输出合法 JSON", () => {
    const { out } = capture();
    const log = new Logger(true);
    log.result({ a: 1 });
    const text = out.mock.calls.map((c) => String(c[0])).join("");
    expect(JSON.parse(text)).toEqual({ a: 1 });
  });
});
