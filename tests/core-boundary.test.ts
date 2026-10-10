/**
 * 架构方向约束（静态扫描）：src/core/** 不得 import src/providers/**。
 * default-registry 是显式装配点，位于 src/ 根（不在 core 内）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreDir = path.join(repoRoot, "src", "core");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(abs));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(abs);
  }
  return out;
}

describe("核心方向约束", () => {
  it("src/core/** 的任何文件都不得 import src/providers/**", () => {
    const files = listTsFiles(coreDir);
    expect(files.length).toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf-8");
      const importPattern = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g;
      for (const match of text.matchAll(importPattern)) {
        const specifier = match[1]!;
        if (specifier.includes("/providers/") || specifier.startsWith("providers/")) {
          offenders.push(`${path.relative(repoRoot, file)} → ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
