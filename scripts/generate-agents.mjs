#!/usr/bin/env node
/**
 * AGENTS.md 生成器（无第三方依赖，输出确定）。
 *
 * 用法：
 *   node scripts/generate-agents.mjs [--manifest <path> ...] [--check] [--output <path>]
 *
 * - 带 --manifest（可重复）：直接从清单文件生成（显式/bootstrap 模式）。
 * - 不带 --manifest（默认/门禁模式）：
 *   1) 先从仓库 node_modules 解析已安装的官方插件依赖；
 *   2) 一个都没装到时，若 sibling 仓库清单 ../xlmerge/v-cli.plugin.json 与
 *      ../u-cli-mod/v-cli.plugin.json 存在，用之作为确定性开发/bootstrap 回退
 *      （发布前的本地仓库、以及依赖发布后安装的 CI 都能跑 npm run check:agents）；
 *   3) 两路都解析不到时，生成“未安装”提示的核心版（check 模式会因与已提交文件
 *      不一致而失败，显式暴露该要求）。
 * - --check：内存中重新生成并与现有文件逐字节比较，不一致时非零退出且不写文件。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = process.cwd();
const DEFAULT_OUTPUT = path.join(ROOT, "AGENTS.md");
const MARKER = "<!-- v-cli-agents:generated -->";

const OFFICIAL_WHITELIST = [
  { package: "@kevlns/xlmerge", command: "xlmerge" },
  { package: "@kevlns/u-cli-mod", command: "unity" },
];

/** 开发/bootstrap 回退：官方依赖未安装时，sibling 仓库清单作为确定性来源 */
const SIBLING_MANIFESTS = [
  path.join("..", "xlmerge", "v-cli.plugin.json"),
  path.join("..", "u-cli-mod", "v-cli.plugin.json"),
];

function parseArgs(argv) {
  const opts = { manifests: [], check: false, output: DEFAULT_OUTPUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") {
      opts.check = true;
    } else if (a === "--manifest") {
      const value = argv[++i];
      if (!value) {
        console.error("--manifest 缺少路径");
        process.exit(2);
      }
      opts.manifests.push(value);
    } else if (a === "--output") {
      const value = argv[++i];
      if (!value) {
        console.error("--output 缺少路径");
        process.exit(2);
      }
      opts.output = path.resolve(ROOT, value);
    } else {
      console.error(`未知参数: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

/** 从单份清单 JSON 文件读取并规整（尝试附带读取同目录 package.json 以带出版本行） */
function loadFromManifestFile(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  if (raw.schemaVersion !== 1) {
    throw new Error(`${file}: 仅支持 schemaVersion 1 的清单`);
  }
  const plugin = {
    file,
    package: raw.package,
    command: raw.command,
    bin: typeof raw.bin === "string" ? raw.bin : undefined,
    description: raw.description,
    platforms: Array.isArray(raw.platforms) ? raw.platforms : [],
    whenToUse: raw.agent && raw.agent.whenToUse,
    globalOptions: raw.agent && Array.isArray(raw.agent.globalOptions) ? raw.agent.globalOptions : [],
    commands: raw.agent && Array.isArray(raw.agent.commands) ? raw.agent.commands : [],
  };
  // bootstrap 模式与 installed 模式对齐：若清单旁有 package.json 且 name 一致，带出版本行
  // （installed 模式天然能读到版本；这样发布后两种模式的字节输出保持一致）
  try {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(path.dirname(file), "package.json"), "utf-8"));
    if (typeof pkgJson.name === "string" && pkgJson.name === plugin.package && typeof pkgJson.version === "string") {
      plugin.version = pkgJson.version;
    }
  } catch {
    // 无 package.json（纯清单 fixture）：不带版本行
  }
  return plugin;
}

/** 从仓库 node_modules 解析已安装的官方依赖 */
function loadInstalledPlugins() {
  const req = createRequire(path.join(ROOT, "__v_cli_generate_noop__.cjs"));
  const found = [];
  for (const spec of OFFICIAL_WHITELIST) {
    try {
      const pkgJsonPath = req.resolve(`${spec.package}/package.json`, { paths: [ROOT] });
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
      const rel = pkgJson.vCli && typeof pkgJson.vCli === "object" ? pkgJson.vCli.manifest : "v-cli.plugin.json";
      const manifestPath = path.join(path.dirname(pkgJsonPath), rel);
      const plugin = loadFromManifestFile(manifestPath);
      plugin.version = typeof pkgJson.version === "string" ? pkgJson.version : undefined;
      found.push(plugin);
    } catch {
      // 未安装：跳过
    }
  }
  return found;
}

function loadPlugins(opts) {
  if (opts.manifests.length > 0) {
    const seen = new Set();
    const plugins = [];
    for (const rel of opts.manifests) {
      const abs = path.resolve(ROOT, rel);
      if (seen.has(abs)) continue;
      seen.add(abs);
      plugins.push(loadFromManifestFile(abs));
    }
    return { mode: "explicit", plugins: sortByPackage(plugins) };
  }

  // 默认（门禁）模式：优先已安装的官方依赖
  const installed = loadInstalledPlugins();
  if (installed.length > 0) {
    return { mode: "installed", plugins: sortByPackage(installed) };
  }

  // 官方依赖尚未发布/尚未安装：sibling 仓库清单作为确定性开发/bootstrap 回退
  const siblings = [];
  for (const rel of SIBLING_MANIFESTS) {
    const abs = path.resolve(ROOT, rel);
    if (fs.existsSync(abs)) {
      siblings.push(loadFromManifestFile(abs));
    }
  }
  if (siblings.length > 0) {
    return { mode: "sibling", plugins: sortByPackage(siblings) };
  }

  return { mode: "none", plugins: [] };
}

function sortByPackage(plugins) {
  return plugins.sort((a, b) => a.package.localeCompare(b.package));
}

function renderCore(plugins, version) {
  const lines = [];
  lines.push("# AGENTS.md");
  lines.push("");
  lines.push(MARKER);
  lines.push("");
  lines.push("> 本文件由 `scripts/generate-agents.mjs` 自动生成，请勿手改。");
  lines.push("> 修改插件清单后运行 `npm run generate:agents` 重新生成，`npm run check:agents` 校验漂移。");
  lines.push("");
  lines.push("## 核心约定（v-cli 本体）");
  lines.push("");
  lines.push(`- 环境要求 Node.js >= 20；v-cli 版本 @kevlns/v-cli@${version}`);
  lines.push("- 命令分三类：builtin（内置）、local（~/.v-cli/commands/ 下的本地插件）、official（官方插件白名单）；");
  lines.push("  **最新、live 的命令集合以实际发现为准**：先运行 `v-cli agent index --json` 获取全部命令与 agent 元数据");
  lines.push("- 单个命令的完整元数据用 `v-cli agent describe <命令名> --json` 查看");
  lines.push("- AI Agent 引导文档：`v-cli agent docs` 输出本文件原文（`--json` 含 sha256/content）；");
  lines.push("  `v-cli agent init .` 把它写入工作区（已存在默认拒绝，`--force` 覆盖，`--dry-run` 预览；符号链接目标 fail-closed）；");
  lines.push("  同时把随包发布的 v-cli skill（skills/v-cli）装配到 <目录> 下匹配的 agent 技能目录（如 .claude/skills、.agent/skill、AgentHome/skills 等，清单见 src/core/agent-dirs.ts），无匹配则跳过");
  lines.push("- **首次调用规范**：首次调用任何 official 插件命令前，必须先运行 `v-cli agent docs <命令名>`，");
  lines.push("  掌握该插件包内 `AGENTS.md`；使用规范、快速流程与禁止事项以插件 AGENTS.md 为准。");
  lines.push("- 官方插件命令（`v-cli xlmerge …`、`v-cli unity …`）在子进程中运行（stdio 继承）：v-cli 只做路由，");
  lines.push("  不解析、不改写插件的 stdout/stderr；插件 `--help`/`--json` 等参数由插件自己消费");
  lines.push("- 插件对 worktree 的写入/提交行为以插件清单 v-cli.plugin.json 的 `agent.safety` 为准：");
  lines.push("  v-cli 不替插件做 diff/write-back/commit；**未经显式 flag 不得 push**");
  lines.push("");
  return lines;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 把清单里的独立用法前缀（bin 名或 command 名，如 `xlmerge …`、`u-cli-mod …`
 * 改写为控制器形式 `v-cli <命令名> …`（xlmerge → v-cli xlmerge、u-cli-mod → v-cli unity）。
 * 前缀不匹配时原样保留。纯字符串操作，确定性输出。
 */
function controllerUsage(plugin, usage) {
  const alts = [plugin.command];
  if (typeof plugin.bin === "string" && plugin.bin.length > 0) alts.push(plugin.bin);
  const prefixRe = new RegExp(`^\\s*(?:${alts.map(escapeRegExp).join("|")})(?=\\s|$)`);
  if (prefixRe.test(usage)) {
    return usage.replace(prefixRe, `v-cli ${plugin.command}`);
  }
  return usage;
}

function renderPlugin(plugin) {
  const lines = [];
  lines.push(`## ${plugin.package} — 命令 \`v-cli ${plugin.command} …\``);
  lines.push("");
  if (plugin.version) {
    lines.push(`**版本**：${plugin.version}`);
  }
  lines.push(`**描述**：${plugin.description}`);
  lines.push(`**平台**：${plugin.platforms.length > 0 ? plugin.platforms.join(", ") : "（未声明）"}${
    plugin.platforms.includes("win32") && !plugin.platforms.includes("darwin") && !plugin.platforms.includes("linux")
      ? "（仅 Windows 主机可用；非 Windows 上 v-cli 会拒绝路由）"
      : ""
  }`);
  if (plugin.whenToUse) {
    lines.push("");
    lines.push(`**何时使用**：${plugin.whenToUse}`);
  }
  lines.push("");
  lines.push(`**首次调用前必读**：\`v-cli agent docs ${plugin.command}\`（插件包内 AGENTS.md 规范正本）`);
  lines.push(`**实时参数/命令**：\`v-cli agent describe ${plugin.command} --json\``);
  lines.push("");
  return lines;
}

function render(plugins, version) {
  const lines = renderCore(plugins, version);
  if (plugins.length === 0) {
    lines.push("## 官方插件");
    lines.push("");
    lines.push("> 当前解析不到任何已安装的官方插件包（@kevlns/xlmerge / @kevlns/u-cli-mod 尚未安装）。");
    lines.push("> 请安装后重新生成本文件：`npm install @kevlns/xlmerge@1.2.1 @kevlns/u-cli-mod@0.1.4`");
    lines.push("> 或直接用实时索引：`v-cli agent index --json`（会列出官方插件与安装状态）。");
    lines.push("");
  } else {
    for (const plugin of plugins) {
      lines.push(...renderPlugin(plugin));
    }
  }
  lines.push("---");
  lines.push("");
  lines.push("所有清单字段的解释见 `schemas/v-cli-plugin.schema.json` 与 `v-cli agent describe` 输出。");
  return lines.join("\n") + "\n";
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
  const { mode, plugins } = loadPlugins(opts);
  const content = render(plugins, pkgJson.version);

  if (opts.check) {
    let existing = null;
    try {
      existing = fs.readFileSync(opts.output, "utf-8");
    } catch {
      existing = null;
    }
    if (existing === null) {
      console.error(`AGENTS.md 漂移检查失败：${opts.output} 不存在（请先运行 npm run generate:agents）`);
      process.exit(1);
    }
    if (existing === content) {
      console.log(`AGENTS.md 是最新的：${opts.output}`);
      process.exit(0);
    }
    const oldLines = existing.split("\n");
    const newLines = content.split("\n");
    const max = Math.min(oldLines.length, newLines.length);
    let firstDiff = -1;
    for (let i = 0; i < max; i++) {
      if (oldLines[i] !== newLines[i]) {
        firstDiff = i;
        break;
      }
    }
    if (firstDiff === -1) firstDiff = max;
    console.error(
      `AGENTS.md 漂移检测失败：第 ${firstDiff + 1} 行起不一致\n` +
        `  现有: ${oldLines[firstDiff] ?? "<EOF>"}\n` +
        `  生成: ${newLines[firstDiff] ?? "<EOF>"}\n` +
        `请运行 npm run generate:agents 重新生成后提交。`,
    );
    process.exit(1);
  }

  fs.writeFileSync(opts.output, content, "utf-8");
  console.log(`已生成 ${opts.output}（${modeText(mode, plugins.length)}）`);
}

function modeText(mode, count) {
  switch (mode) {
    case "explicit":
      return `bootstrap: ${count} 份清单`;
    case "installed":
      return `installed deps 模式（${count} 个官方插件）`;
    case "sibling":
      return `sibling 清单回退（官方依赖未安装，${count} 个官方插件）`;
    default:
      return `installed deps 模式（未解析到任何官方插件）`;
  }
}

main();
