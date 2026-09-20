import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const PACK_GUARD = resolve(__dirname, "..", "scripts", "pack-guard.mjs");
const REPO_ROOT = resolve(__dirname, "..");

describe("pack:guard 发布护栏", () => {
  it("真实 npm pack 通过全部断言（身份/必需文件/禁止内容/依赖精确固定/engines）", () => {
    const out = execFileSync(process.execPath, [PACK_GUARD], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    });
    expect(out).toContain("pack:guard OK");
    expect(out).toContain("@kevlns/v-cli@0.2.9");
  });
});