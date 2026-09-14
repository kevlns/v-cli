#!/usr/bin/env node
/**
 * pack:guard — 发布内容护栏。
 *
 * 步骤：npm pack --dry-run --json（身份/文件清单）→ 真实 npm pack → tar 解列复核，
 * 断言：包身份 @kevlns/v-cli@0.2.6、必需文件齐全、禁止内容（src/tests/scripts/
 * 配置/源码/压缩包/node_modules）不出现、两个官方依赖精确固定、engines.node >= 20。
 * 任何断言失败 → 非零退出。
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
const EXPECTED_NAME = "@kevlns/v-cli";
const EXPECTED_VERSION = "0.2.6";
const REQUIRED_FILES = [
  "dist/cli.mjs",
  "AGENTS.md",
  "schemas/v-cli-plugin.schema.json",
  "skills/v-cli/SKILL.md",
  "README.md",
  "LICENSE",
  "package.json",
];
const FORBIDDEN_PREFIXES = [
  "src/",
  "tests/",
  "scripts/",
  "node_modules/",
  "tsup.config",
  "vitest.config",
  "tsconfig.json",
  ".tgz",
];

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

/** 跨平台 npm 解析：优先 npm_execpath（npm run 环境），回退 npm-cli.js，最后裸命令 */
function npmExec() {
  if (process.env.npm_execpath && fs.existsSync(process.env.npm_execpath)) {
    return { cmd: process.execPath, args: [process.env.npm_execpath] };
  }
  const fallback = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (fs.existsSync(fallback)) {
    return { cmd: process.execPath, args: [fallback] };
  }
  return { cmd: npmCmd, args: [] };
}

function npmExecFile(args, options) {
  const npm = npmExec();
  return execFileSync(npm.cmd, [...npm.args, ...args], options);
}

export function runPackGuard({ cwd = ROOT, keepTarball = false } = {}) {
  const errors = [];
  let tgzPath = null;
  try {
    // 1) dry-run 身份 + 文件清单（--ignore-scripts：dist 已由 npm run build 产出，避免测试期重建竞态）
    const dryOut = npmExecFile(["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd,
      encoding: "utf-8",
    });
    const dryInfo = JSON.parse(dryOut)[0];
    if (dryInfo.name !== EXPECTED_NAME) {
      errors.push(`pack 身份 name 错误: ${dryInfo.name}（期望 ${EXPECTED_NAME}）`);
    }
    if (dryInfo.version !== EXPECTED_VERSION) {
      errors.push(`pack 身份 version 错误: ${dryInfo.version}（期望 ${EXPECTED_VERSION}）`);
    }
    const dryPaths = dryInfo.files.map((f) => f.path);
    for (const required of REQUIRED_FILES) {
      if (!dryPaths.includes(required)) {
        errors.push(`dry-run 缺少必需文件: ${required}`);
      }
    }
    for (const forbidden of FORBIDDEN_PREFIXES) {
      const hit = dryPaths.find((p) => p.startsWith(forbidden));
      if (hit) {
        errors.push(`dry-run 出现禁止内容: ${hit}`);
      }
    }

    // 2) 真实 pack（--ignore-scripts 同上；发布时 prepack 构建由 npm publish 保证）
    const packOut = npmExecFile(["pack", "--json", "--ignore-scripts"], { cwd, encoding: "utf-8" });
    const packed = JSON.parse(packOut)[0];
    const filename = packed.filename;
    const expectedTarball = "kevlns-v-cli-0.2.6.tgz";
    if (filename !== expectedTarball) {
      errors.push(`tar 包名错误: ${filename}（期望 ${expectedTarball}）`);
    }
    tgzPath = path.join(cwd, filename);

    // 3) tar 解列复核（相对路径：Windows bsdtar 会把盘符冒号当远程主机）
    const tarRel = path.relative(cwd, tgzPath);
    const tar = spawnSync("tar", ["-tf", tarRel], { cwd, encoding: "utf-8" });
    if (tar.status !== 0) {
      errors.push(`tar -tf 失败: ${tar.stderr || tar.error?.message || "未知"}`);
    } else {
      const entries = tar.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      for (const required of REQUIRED_FILES) {
        if (!entries.some((e) => e === `package/${required}` || e.endsWith(`/${required}`))) {
          errors.push(`tar 中缺少必需文件: ${required}`);
        }
      }
      for (const forbidden of FORBIDDEN_PREFIXES) {
        const hit = entries.find((e) => e.includes(forbidden));
        if (hit) {
          errors.push(`tar 中出现禁止内容: ${hit}`);
        }
      }
    }

    // 4) 包内 package.json 复核（依赖精确固定 + engines）
    const pkgOut = spawnSync("tar", ["-xOf", tarRel, "package/package.json"], { cwd, encoding: "utf-8" });
    if (pkgOut.status !== 0) {
      errors.push(`tar -xOf package/package.json 失败: ${pkgOut.stderr || "未知"}`);
    } else {
      const inner = JSON.parse(pkgOut.stdout);
      const pinned = {
        "@kevlns/xlmerge": "2.0.0",
        "@kevlns/u-cli-mod": "0.1.4",
      };
      for (const [dep, expect] of Object.entries(pinned)) {
        if (inner.dependencies?.[dep] !== expect) {
          errors.push(
            `包内 dependencies.${dep} = ${JSON.stringify(inner.dependencies?.[dep])}（期望精确 ${expect}）`,
          );
        }
      }
      if (typeof inner.engines?.node !== "string" || !inner.engines.node.includes(">=20")) {
        errors.push(`包内 engines.node = ${JSON.stringify(inner.engines?.node)}（期望包含 >=20）`);
      }
      if (inner.name !== EXPECTED_NAME || inner.version !== EXPECTED_VERSION) {
        errors.push(`包内 package.json 身份错误: ${inner.name}@${inner.version}`);
      }
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  } finally {
    if (tgzPath && !keepTarball) {
      try {
        fs.unlinkSync(tgzPath);
      } catch {
        // 清理失败不掩盖主结论
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// CLI 入口
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runPackGuard();
  if (result.ok) {
    console.log(`pack:guard OK — ${EXPECTED_NAME}@${EXPECTED_VERSION} 内容符合发布护栏`);
    process.exit(0);
  }
  console.error("pack:guard 失败:");
  for (const e of result.errors) console.error(`  - ${e}`);
  process.exit(1);
}
