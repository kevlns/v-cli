#!/usr/bin/env node
/**
 * test:package — 发布后安装冒烟测试（真实 npm 全局安装）。
 *
 * 流程：npm pack 生成 tgz → 在隔离临时 prefix 中做一次真实 `npm install --global`，
 * 官方依赖 @kevlns/xlmerge@1.2.1 / @kevlns/u-cli-mod@0.1.0 由 registry
 * 正常解析安装 → 通过 npm 生成的 bin wrapper（非直接运行 dist/cli.mjs）执行 CLI，断言：
 *   - `--version` 为 0.2.0；
 *   - `plugin list --json` 报告 xlmerge available；unity 在 win32 为 available、
 *     非 win32 为 platform-mismatch；
 *   - `agent index --json` / `agent describe --json` 暴露官方清单全量元数据
 *     （arguments/options/output/exitCodes/safety）；
 *   - `agent docs` 逐字节输出安装包内 AGENTS.md，`agent docs --json` 给出
 *     package/version/sha256/content 且哈希自洽（test:package 的 docs 断言）；
 *   - `--help` / `agent --help` / `agent init --help` 中可发现 AI Agent 快速开始
 *     与推荐顺序（help 是 agent 的发现入口）；
 *   - `v-cli xlmerge --help` 路由成功且输出确属 xlmerge；
 *   - win32 上 `v-cli unity --version` 成功；非 win32 断言 fail-closed 平台不匹配。
 *
 * 隔离：V_CLI_HOME 指向临时目录、cwd 为独立空工作目录、显式移除
 * V_CLI_PLUGIN_RESOLVE_FROM。不使用 shell 拼接（execFileSync/spawnSync 显式参数数组，
 * win32 的 .cmd shim 经 cmd.exe /d /s /c + windowsVerbatimArguments 启动，参数为固定
 * 静态词元）。tgz 与临时目录在 finally 清理；任何断言失败输出命令 stdout/stderr。
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const ROOT = process.cwd();
const IS_WIN = process.platform === "win32";
const VERSION = "0.2.0";
const XL_VERSION = "1.2.1";
const UNITY_VERSION = "0.1.0";
const STREAM_CAP = 4000;

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

/** 截断输出流（失败诊断用，避免刷屏） */
function excerpt(text) {
  const s = String(text ?? "");
  return s.length > STREAM_CAP ? `${s.slice(0, STREAM_CAP)}\n…（截断，共 ${s.length} 字符）` : s;
}

/** SHA-256（hex） */
function sha256(str) {
  return createHash("sha256").update(str, "utf-8").digest("hex");
}

/** 执行 npm 命令；失败时把 stdout/stderr 带进错误信息 */
function runNpm(args, options) {
  const npm = npmExec();
  try {
    return execFileSync(npm.cmd, [...npm.args, ...args], {
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
      ...options,
    });
  } catch (err) {
    const detail = `${err.message}\n--- stdout ---\n${excerpt(err.stdout)}\n--- stderr ---\n${excerpt(err.stderr)}`;
    throw new Error(`npm ${args.join(" ")} 失败: ${detail}`);
  }
}

/** 通过安装产物的 bin wrapper 运行 v-cli（win32 经 cmd.exe 启动 .cmd shim）。 */
function cliRun(prefix, args, options) {
  const shim = IS_WIN ? path.join(prefix, "v-cli.cmd") : path.join(prefix, "bin", "v-cli");
  if (!fs.existsSync(shim)) {
    let listing = "";
    try {
      listing = fs.readdirSync(IS_WIN ? prefix : path.join(prefix, "bin")).join(", ");
    } catch {
      // 目录不存在时保持空列表
    }
    throw new Error(`安装产物缺少 bin wrapper: ${shim}（prefix 内容: ${listing || "空"}）`);
  }
  const base = {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
    ...options,
  };
  if (IS_WIN) {
    // .cmd 无法直接 spawn（EINVAL）；cmd /d /s /c 外扩一层引号（/S 剥掉最外层一对），
    // windowsVerbatimArguments 保证命令原样传给 cmd。参数为受控静态词元，无注入面。
    const cmdLine = `"${`"${shim}" ${args.join(" ")}`}"`;
    return spawnSync("cmd.exe", ["/d", "/s", "/c", cmdLine], {
      ...base,
      windowsVerbatimArguments: true,
    });
  }
  return spawnSync(shim, args, base);
}

/** 运行 v-cli 并断言退出码 0；失败时抛出带 stdout/stderr 的错误 */
function cliExpectOk(prefix, args, options) {
  const r = cliRun(prefix, args, options);
  if (r.error) {
    throw new Error(`v-cli ${args.join(" ")} 启动失败: ${r.error.message}`);
  }
  if (r.status !== 0) {
    throw new Error(
      `v-cli ${args.join(" ")} 退出码 ${r.status}（期望 0）\n--- stdout ---\n${excerpt(r.stdout)}\n--- stderr ---\n${excerpt(r.stderr)}`,
    );
  }
  return r.stdout ?? "";
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/** 断言命令元数据包含 arguments/options/output/exitCodes/safety 五要素 */
function hasFullMeta(c) {
  return (
    Array.isArray(c?.arguments) &&
    Array.isArray(c?.options) &&
    typeof c?.output === "object" &&
    c?.output !== null &&
    typeof c?.exitCodes === "object" &&
    c?.exitCodes !== null &&
    Array.isArray(c?.safety)
  );
}

/** 官方依赖是否真实落盘（npm 各版本布局可能 hoist 或嵌套，取并集） */
function installedDepPath(prefix, pkg) {
  const roots = IS_WIN
    ? [path.join(prefix, "node_modules"), path.join(prefix, "node_modules", "@kevlns", "v-cli", "node_modules")]
    : [path.join(prefix, "lib", "node_modules"), path.join(prefix, "lib", "node_modules", "@kevlns", "v-cli", "node_modules")];
  for (const root of roots) {
    const p = path.join(root, pkg, "package.json");
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/** 完整校验：真实全局安装 → wrapper 运行 → 逐项断言；临时目录由 finally 清理 */
function smoke(filename) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "v-cli-pkg-smoke-"));
  const prefix = path.join(tmp, "prefix");
  const home = path.join(tmp, "home");
  const work = path.join(tmp, "work");
  fs.mkdirSync(prefix, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(work, { recursive: true });

  const env = { ...process.env, V_CLI_HOME: home };
  delete env.V_CLI_PLUGIN_RESOLVE_FROM; // 纯净安装：不继承任何插件解析钩子
  delete env.npm_config_prefix;

  try {
    // 1) 真实 npm 全局安装进隔离 prefix（官方依赖从 registry 解析）
    console.log("[test:package] npm install --global --prefix（隔离）…");
    runNpm(
      ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", path.join(ROOT, filename)],
      { cwd: ROOT, env, timeout: 300_000 },
    );
    for (const dep of ["@kevlns/xlmerge", "@kevlns/u-cli-mod"]) {
      assert(
        installedDepPath(prefix, dep),
        `npm 全局安装后未能解析到官方依赖 ${dep}（registry 解析失败？）`,
      );
    }

    const runOpts = { cwd: work, env };

    // 2) --version
    const version = cliExpectOk(prefix, ["--version"], runOpts).trim();
    assert(version === VERSION, `安装版 CLI --version = ${version}（期望 ${VERSION}）`);

    // 3) plugin list --json：官方插件可用性
    const list = JSON.parse(cliExpectOk(prefix, ["plugin", "list", "--json"], runOpts));
    const xl = list.find((r) => r.source === "official" && r.name === "xlmerge");
    assert(xl, "plugin list 缺少官方行 xlmerge");
    assert(
      xl.status === "available" && xl.version === XL_VERSION,
      `xlmerge 状态 = ${xl.status}@${xl.version ?? "-"}（期望 available@${XL_VERSION}）`,
    );
    const unity = list.find((r) => r.source === "official" && r.name === "unity");
    assert(unity, "plugin list 缺少官方行 unity");
    if (IS_WIN) {
      assert(
        unity.status === "available" && unity.version === UNITY_VERSION,
        `unity 状态 = ${unity.status}@${unity.version ?? "-"}（win32 期望 available@${UNITY_VERSION}）`,
      );
    } else {
      assert(
        unity.status === "platform-mismatch",
        `unity 状态 = ${unity.status}（非 win32 期望 platform-mismatch）`,
      );
    }

    // 4) agent index --json：官方清单全量元数据
    const rows = JSON.parse(cliExpectOk(prefix, ["agent", "index", "--json"], runOpts));
    const xlRow = rows.find((r) => r.type === "official" && r.name === "xlmerge");
    assert(xlRow?.metadataStatus === "full", `agent index xlmerge metadataStatus = ${xlRow?.metadataStatus}（期望 full）`);
    const xlDetect = xlRow?.commands?.find((c) => c.path.join(" ") === "detect");
    assert(hasFullMeta(xlDetect), "agent index xlmerge detect 缺少 arguments/options/output/exitCodes/safety");
    const unRow = rows.find((r) => r.type === "official" && r.name === "unity");
    if (IS_WIN) {
      assert(unRow?.metadataStatus === "full", `agent index unity metadataStatus = ${unRow?.metadataStatus}（win32 期望 full）`);
      const unDoctor = unRow?.commands?.find((c) => c.path.join(" ") === "doctor");
      assert(hasFullMeta(unDoctor), "agent index unity doctor 缺少 arguments/options/output/exitCodes/safety");
    } else {
      assert(
        unRow?.metadataStatus === "minimal" && unRow?.status === "platform-mismatch",
        `agent index unity metadataStatus = ${unRow?.metadataStatus}（非 win32 期望 minimal）`,
      );
    }

    // 5) agent describe --json：单命令完整记录
    const xlDesc = JSON.parse(cliExpectOk(prefix, ["agent", "describe", "xlmerge", "--json"], runOpts));
    assert(
      xlDesc.name === "xlmerge" &&
        xlDesc.type === "official" &&
        xlDesc.package === "@kevlns/xlmerge" &&
        xlDesc.status === "available" &&
        xlDesc.metadataStatus === "full",
      `agent describe xlmerge 身份/状态不符: ${JSON.stringify({ name: xlDesc.name, type: xlDesc.type, package: xlDesc.package, status: xlDesc.status, metadataStatus: xlDesc.metadataStatus })}`,
    );
    const xlDescDetect = xlDesc.commands?.find((c) => c.path.join(" ") === "detect");
    assert(hasFullMeta(xlDescDetect), "agent describe xlmerge detect 缺少 arguments/options/output/exitCodes/safety");
    if (IS_WIN) {
      const unDesc = JSON.parse(cliExpectOk(prefix, ["agent", "describe", "unity", "--json"], runOpts));
      const unDescDoctor = unDesc.commands?.find((c) => c.path.join(" ") === "doctor");
      assert(hasFullMeta(unDescDoctor), "agent describe unity doctor 缺少 arguments/options/output/exitCodes/safety");
    }

    // 6) xlmerge --help 路由到插件本体
    const help = cliExpectOk(prefix, ["xlmerge", "--help"], runOpts);
    assert(help.includes("resolve_xlsx_conflict.py"), "xlmerge --help 输出不像 xlmerge 的用法头");
    assert(!help.includes("安装后可用"), "xlmerge --help 落到了 v-cli 静态注册占位（未路由到插件）");

    // 7) unity 路由：win32 成功；非 win32 fail-closed
    if (IS_WIN) {
      const ver = cliExpectOk(prefix, ["unity", "--version"], runOpts).trim();
      assert(ver === UNITY_VERSION, `unity --version = ${ver}（期望 ${UNITY_VERSION}）`);
    } else {
      const r = cliRun(prefix, ["unity", "--version"], runOpts);
      assert(
        r.status !== 0 && r.status !== null && /仅支持平台/.test(r.stderr ?? ""),
        `非 win32 平台 unity 路由应当 fail-closed（退出码 ${r.status ?? "信号中断"}）；stderr: ${excerpt(r.stderr)}`,
      );
    }

    // 8) agent docs：真实安装包内 AGENTS.md 逐字节输出 + JSON 哈希自洽 + 帮助发现
    const installedPkgRoot = IS_WIN
      ? path.join(prefix, "node_modules", "@kevlns", "v-cli")
      : path.join(prefix, "lib", "node_modules", "@kevlns", "v-cli");
    const installedDocs = fs.readFileSync(path.join(installedPkgRoot, "AGENTS.md"), "utf-8");
    const repoDocs = fs.readFileSync(path.join(ROOT, "AGENTS.md"), "utf-8");
    assert(installedDocs === repoDocs, "安装包内 AGENTS.md 与仓库 AGENTS.md 不一致");
    const authorsNote = cliExpectOk(prefix, ["agent", "docs"], runOpts);
    assert(authorsNote === installedDocs, "agent docs stdout 与安装包内 AGENTS.md 不一致（应逐字节相等）");
    const docsJson = JSON.parse(cliExpectOk(prefix, ["agent", "docs", "--json"], runOpts));
    assert(
      docsJson.package === "@kevlns/v-cli" && docsJson.version === VERSION,
      `agent docs --json 身份 = ${docsJson.package}@${docsJson.version}（期望 @kevlns/v-cli@${VERSION}）`,
    );
    assert(docsJson.content === installedDocs, "agent docs --json content 与安装包内 AGENTS.md 不一致");
    assert(docsJson.sha256 === sha256(installedDocs), "agent docs --json sha256 与 content 不一致");
    const xlDocs = JSON.parse(cliExpectOk(prefix, ["agent", "docs", "xlmerge", "--json"], runOpts));
    assert(
      xlDocs.package === "@kevlns/xlmerge" && xlDocs.version === XL_VERSION,
      `agent docs xlmerge 身份 = ${xlDocs.package}@${xlDocs.version}`,
    );
    assert(xlDocs.content.includes("不默认走无头自动合并"), "xlmerge AGENTS.md 缺少 UI-first 规范");
    const unityDocs = JSON.parse(cliExpectOk(prefix, ["agent", "docs", "unity", "--json"], runOpts));
    assert(
      unityDocs.package === "@kevlns/u-cli-mod" && unityDocs.version === UNITY_VERSION,
      `agent docs unity 身份 = ${unityDocs.package}@${unityDocs.version}`,
    );
    assert(unityDocs.content.includes("首次对某工程执行 `exec` 前"), "u-cli-mod AGENTS.md 缺少首次就绪规范");
    const topHelp = cliExpectOk(prefix, ["--help"], runOpts);
    for (const line of [
      "AI Agent 快速开始",
      "1. v-cli agent docs",
      "2. v-cli agent index --json",
      "3. v-cli agent describe <name> --json",
      "4. v-cli agent init .",
    ]) {
      assert(topHelp.includes(line), `安装版 --help 缺少 ${line}`);
    }
    const agentHelp = cliExpectOk(prefix, ["agent", "--help"], runOpts);
    assert(agentHelp.includes("docs") && agentHelp.includes("init"), "安装版 agent --help 缺少 docs/init");
    const docsHelp = cliExpectOk(prefix, ["agent", "docs", "--help"], runOpts);
    for (const line of ["sha256", "v-cli agent docs xlmerge --json"]) {
      assert(docsHelp.includes(line), `安装版 agent docs --help 缺少 ${line}`);
    }
    const initHelp = cliExpectOk(prefix, ["agent", "init", "--help"], runOpts);
    for (const line of ["--force", "--dry-run", "默认当前工作目录"]) {
      assert(initHelp.includes(line), `安装版 agent init --help 缺少 ${line}`);
    }

    return `test:package OK — ${filename} 真实全局安装后 wrapper 冒烟全绿：--version=${version}，xlmerge@${XL_VERSION} available，unity@${UNITY_VERSION} ${IS_WIN ? "available" : "platform-mismatch（fail-closed 已断言）"}，agent docs sha256=${sha256(installedDocs).slice(0, 12)}…，help 发现 AI Agent 快速开始`;
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // 清理失败不掩盖主结论
    }
  }
}

let tgzPath = null;
try {
  const packOut = runNpm(["pack", "--json", "--ignore-scripts"], { cwd: ROOT });
  const filename = JSON.parse(packOut)[0].filename;
  tgzPath = path.join(ROOT, filename);
  console.log(smoke(filename));
} catch (err) {
  console.error(`test:package 失败: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (tgzPath) {
    try {
      fs.unlinkSync(tgzPath);
    } catch {
      // 忽略清理失败
    }
  }
}