# AGENTS.md

<!-- v-cli-agents:generated -->

> 本文件由 `scripts/generate-agents.mjs` 自动生成，请勿手改。
> 修改插件清单后运行 `npm run generate:agents` 重新生成，`npm run check:agents` 校验漂移。

## 核心约定（v-cli 本体）

- 环境要求 Node.js >= 20；v-cli 版本 @kevlns/v-cli@0.2.17
- 命令分三类：builtin（内置）、local（~/.v-cli/commands/ 下的本地插件）、official（官方插件白名单）；
  **命令集合以实际发现为准**：先运行 `v-cli agent index --json` 获取全部命令与 agent 元数据
- 单个命令的完整元数据用 `v-cli agent describe <命令名> --json` 查看
- AI Agent 引导文档：`v-cli agent docs` 输出本文件原文（`--json` 含 sha256/content）；
  `v-cli agent init .` 把它写入工作区（已存在默认拒绝，`--force` 覆盖，`--dry-run` 预览；符号链接目标 fail-closed）；
  同时把随包发布的 v-cli skill（skills/v-cli）装配到 <目录> 下匹配的 agent 技能目录（如 .claude/skills、.agent/skill、AgentHome/skills 等），无匹配则跳过；
  随包版本是规范唯一权威：同名 SKILL.md 一律按随包版本刷新（本地修改会被覆盖并提示）；随包没有的文件（项目扩展，如 PROJECT.md）默认保留，`--force` 时完全同步
- **首调规范**：首次调用任何 official 插件命令前，必须先运行 `v-cli agent docs <命令名>`，
  掌握该插件包内 `AGENTS.md`；使用规范、快速流程与禁止事项以插件 AGENTS.md 为准。
- 官方插件命令（`v-cli xlmerge …`、`v-cli unity …`、`v-cli figma …`、`v-cli ship …`、`v-cli art …`）在子进程中运行（stdio 继承）：v-cli 只做路由，
- `art` 是随包美术工坊插件；先读 `v-cli agent docs art`，用 `v-cli art config show` 和 `v-cli art agent index` 选择正确工程与核心。真实分析和生成按任务授权执行。
- `ship` 是随包官方插件（@kevlns/ship-cli），随 v-cli 安装并自动发现；先运行 `v-cli agent docs ship`、`v-cli ship doctor --json`，再按 Steam / 微信小游戏流程执行。缺失时明确报告 missing，不在运行时自动安装。
  不解析、不改写插件的 stdout/stderr；插件 `--help`/`--json` 等参数由插件自己消费
- 插件对 worktree 的写入/提交行为以插件清单 v-cli.plugin.json 的 `agent.safety` 为准：
  v-cli 不替插件做 diff/write-back/commit；**未经显式 flag 不得 push**

## @kevlns/art-workshop — 命令 `v-cli art …`

**版本**：0.1.3
**描述**：美术工坊：多工程风格分析与核心冻结、统一风格文生图及图编辑，支持计划预演与人工验收。
**平台**：win32, linux, darwin

**何时使用**：视觉风格分析与冻结、基于正确工程核心生成统一风格图片、按修改与保留计划编辑现有图片，或查看 refs 分类、预演与验收。先 config show 和 agent index 选择工程，远程分析及生图须有任务授权。

**首次调用前必读**：`v-cli agent docs art`（插件包内 AGENTS.md 规范正本）
**实时参数/命令**：`v-cli agent describe art --json`

## @kevlns/figma-to-uprefab — 命令 `v-cli figma …`

**版本**：0.1.2
**描述**：Figma REST -> staging-only Unity UGUI prefabs. Node orchestrates export/contract/install/build; the embedded Unity Editor package (source manifest + approximation overlay -> IR -> Prefab) is the only source->IR converter.
**平台**：win32（仅 Windows 主机可用；非 Windows 上 v-cli 会拒绝路由）

**何时使用**：Use to convert tagged Figma frames into staging-only Unity UGUI prefabs: export source manifests + node PNGs, validate the staging contract, install the embedded Unity converter package, or run the C# converter in Unity batch. Never use for promoting generated assets into runtime paths or writing UIConfig.

**首次调用前必读**：`v-cli agent docs figma`（插件包内 AGENTS.md 规范正本）
**实时参数/命令**：`v-cli agent describe figma --json`

## @kevlns/ship-cli — 命令 `v-cli ship …`

**版本**：0.1.1
**描述**：Cross-platform game shipping CLI: offline validation + packaging + push to platform test channels. Steam (steamcmd/SteamPipe VDF builds, branch set-live guard) and WeChat mini games (structure/size validation, miniprogram-ci preview QR and dev-version upload). Never publishes to players on its own.
**平台**：win32, linux, darwin

**何时使用**：Shipping a built game to distribution platforms: packaging/upload to Steam (depot builds via steamcmd) or WeChat mini games (dev-version upload via miniprogram-ci), plus offline package validation and environment preflight. NOT for: making content player-visible (Steam default-branch set-live, WeChat review submission/release/gray rollout are always human steps in platform backends), building engine players (produce artifacts first), or account/credential setup beyond pointing at env vars.

**首次调用前必读**：`v-cli agent docs ship`（插件包内 AGENTS.md 规范正本）
**实时参数/命令**：`v-cli agent describe ship --json`

## @kevlns/u-cli-mod — 命令 `v-cli unity …`

**版本**：0.2.4
**描述**：Pin a Unity project to its exact editor version route, download the verified Unity CLI and install the adapted com.unity.pipeline package for Unity 2022 (Windows-first, non-official Unity tooling).
**平台**：win32（仅 Windows 主机可用；非 Windows 上 v-cli 会拒绝路由）

**何时使用**：Use for Windows-first Unity Editor 2022 workflows that must stay pinned to an exact editor version: diagnose a project against its route, list pinned routes, download the verified Unity CLI, transactionally install the adapted com.unity.pipeline package, or run Unity Pipeline CLI commands with enforced project targeting. Never use on non-Windows hosts.

**首次调用前必读**：`v-cli agent docs unity`（插件包内 AGENTS.md 规范正本）
**实时参数/命令**：`v-cli agent describe unity --json`

## @kevlns/xlmerge — 命令 `v-cli xlmerge …`

**版本**：2.0.1
**描述**：Formula-aware visual resolver for Git merge conflicts in .xlsx/.xlsm planning tables: three-way sheet/row/cell diff, local UI, atomic write-back and commit.
**平台**：darwin, linux, win32

**何时使用**：When a user asks to resolve Git merge conflicts in .xlsx/.xlsm planning or configuration tables (策划表/配置表冲突): run detect first; when reviewCount > 0 run launch and give the returned url to the user. Configured auto-theirs filters may resolve and commit matched generated workbooks without opening the UI. Do not inspect workbook cells or summarize diffs yourself; the resolver owns diff, choices, write-back and commit.

**首次调用前必读**：`v-cli agent docs xlmerge`（插件包内 AGENTS.md 规范正本）
**实时参数/命令**：`v-cli agent describe xlmerge --json`

---

所有清单字段的解释见 `schemas/v-cli-plugin.schema.json` 与 `v-cli agent describe` 输出。
