# AGENTS.md

<!-- v-cli-agents:generated -->

> 本文件由 `scripts/generate-agents.mjs` 自动生成，请勿手改。
> 修改插件清单后运行 `npm run generate:agents` 重新生成，`npm run check:agents` 校验漂移。

## 核心约定（v-cli 本体）

- 环境要求 Node.js >= 20；v-cli 版本 @kevlns/v-cli@0.2.0-beta.3
- 命令分三类：builtin（内置）、local（~/.v-cli/commands/ 下的本地插件）、official（官方插件白名单）；
  **最新、live 的命令集合以实际发现为准**：先运行 `v-cli agent index --json` 获取全部命令与 agent 元数据
- 单个命令的完整元数据用 `v-cli agent describe <命令名> --json` 查看
- AI Agent 引导文档：`v-cli agent docs` 输出本文件原文（`--json` 含 sha256/content）；
  `v-cli agent init .` 把它写入工作区（已存在默认拒绝，`--force` 覆盖，`--dry-run` 预览；符号链接目标 fail-closed）
- 官方插件命令（`v-cli xlmerge …`、`v-cli unity …`）在子进程中运行（stdio 继承）：v-cli 只做路由，
  不解析、不改写插件的 stdout/stderr；插件 `--help`/`--json` 等参数由插件自己消费
- 插件对 worktree 的写入/提交行为以插件清单 v-cli.plugin.json 的 `agent.safety` 为准：
  v-cli 不替插件做 diff/write-back/commit；**未经显式 flag 不得 push**

## @kevlns/u-cli-mod — 命令 `v-cli unity …`

**版本**：0.1.0-beta.3
**描述**：Pin a Unity project to its exact editor version route, download the verified Unity CLI and install the adapted com.unity.pipeline package for Unity 2022 (Windows-first, non-official Unity tooling).
**平台**：win32（仅 Windows 主机可用；非 Windows 上 v-cli 会拒绝路由）

**何时使用**：Use for Windows-first Unity Editor 2022 workflows that must stay pinned to an exact editor version: diagnose a project against its route, list pinned routes, download the verified Unity CLI, transactionally install the adapted com.unity.pipeline package, or run Unity Pipeline CLI commands with enforced project targeting. Never use on non-Windows hosts.

**全局选项**：
- `-V, --version` — output the version number
- `-h, --help` — display help for command

**子命令**：
- `doctor` — 检查工程版本、路由、CLI 与 Pipeline 状态（用法：`v-cli unity doctor <project> [options]`）
  - 安全标签：read-only; never writes the project or the cache；fail-closed exact m_EditorVersion + m_EditorVersionWithRevision match (no wildcard, no fallback)；queries running Unity.exe processes via PowerShell; a failed query is reported in the unityProcesses output, not fatal
- `routes` — 列出所有已配置的 Editor 精确路由（用法：`v-cli unity routes [options]`）
  - 安全标签：read-only; no network access；uses only embedded pinned route metadata shipped in the package
- `cli install` — 下载并校验固定版本的 Unity CLI（SHA-256 + Authenticode）（用法：`v-cli unity cli install [options]`）
  - 安全标签：writes only under the user cache: %LOCALAPPDATA%\editor-pipeline-cli\cache\cli；downloads from the pinned Unity official CDN HTTPS URL only；verifies fixed SHA-256 + expected size + Authenticode signer subject and certificate thumbprint before the binary is placed；unverified temp download is deleted on any failure; the final file is created by atomic rename
- `pipeline install` — 按工程 Editor 版本事务式安装适配后的 com.unity.pipeline（用法：`v-cli unity pipeline install <project> [options]`）
  - 安全标签：transactional install: stage -> verify -> backup -> replace -> re-verify -> receipt; automatic rollback on any failure；fail-closed when a matching Unity Editor is running, unless --allow-running-editor；--dry-run never writes the project and never writes a receipt；source and destination trees must match the pinned expected-tree (385 files, SHA-256) before and after placement；writes only under <project>/Packages/com.unity.pipeline and <project>/Library/editor-pipeline-cli
- `setup` — cli install + pipeline install（用法：`v-cli unity setup <project> [options]`）
  - 安全标签：combines the cli install and pipeline install safety contracts；fail-closed running-Editor guard unless --allow-running-editor；--dry-run never writes the project；--skip-cli avoids all CLI downloads
- `exec` — 调用路由 CLI 执行 Unity Pipeline 命令；--project-path 由工具统一绑定（用法：`v-cli unity exec <project> [options] -- <unity-cli-args...>`）
  - 安全标签：re-verifies the pinned CLI SHA-256 before every invocation (fail-closed on tamper)；rejects every --project-path variant (case-insensitive: --project-path, --projectPath, -projectPath, --project_path, mixed case)；always appends the resolved --project-path as the final argument; the wrapper owns project targeting；no route fallback: the project must match a pinned route exactly；the documented -- separator is consumed by the wrapper and never forwarded to the Unity CLI
- `cache clean` — 清理下载缓存与生成的适配包（用法：`v-cli unity cache clean [options]`）
  - 安全标签：removes only directories under the user cache root %LOCALAPPDATA%\editor-pipeline-cli；default scope: generated packages + pipeline downloads only; without --all the CLI cache and logs are preserved

## @kevlns/xlmerge — 命令 `v-cli xlmerge …`

**版本**：1.2.1-beta.3
**描述**：Visual resolver for Git merge conflicts in .xlsx/.xlsm planning tables: three-way sheet/row/cell diff, local UI, write-back and commit.
**平台**：darwin, linux, win32

**何时使用**：When a user asks to resolve Git merge conflicts in .xlsx/.xlsm planning or configuration tables (策划表/配置表冲突): run detect first; when count > 0 run launch and give the returned url to the user. Do not inspect workbook cells or summarize diffs yourself; the resolver owns diff, choices, write-back and commit.

**全局选项**：
- `--repo <path>` — Git repository (default: current directory; searches upward for the Git root).
- `--runtime-dir <dir>` — Optional directory for extracted Git stage workbooks and manifest (default: system temp). Used by prepare, resolve and launch.

**子命令**：
- `detect` — List unresolved .xlsx/.xlsm files in the repository.（用法：`v-cli xlmerge --repo <repo> detect`）
  - 安全标签：read-only；no-worktree-modification
- `prepare` — Extract base/ours/theirs stage versions from the Git index and build a sheet-aware manifest.（用法：`v-cli xlmerge --repo <repo> prepare [--path <file>]`）
  - 安全标签：writes-runtime-dir；no-worktree-modification；no-commit
- `resolve` — Prepare conflicts and serve the local visual resolver in the foreground (blocking).（用法：`v-cli xlmerge --repo <repo> resolve [--path <file>] [--no-browser]`）
  - 安全标签：blocking；binds-loopback；opens-browser-by-default；no-push；writes-runtime-dir；writes-worktree-via-ui；commits-by-default-via-ui
- `launch` — Prepare conflicts, start the visual resolver in the background and return its URL.（用法：`v-cli xlmerge --repo <repo> launch [--path <file>] [--no-browser]`）
  - 安全标签：starts-background-server；binds-loopback；opens-browser-by-default；no-push；writes-runtime-dir；writes-worktree-via-ui；commits-by-default-via-ui
- `apply` — Write back decisions from a decisions JSON without launching the UI.（用法：`v-cli xlmerge --repo <repo> apply --manifest <manifest.json> --decisions <decisions.json> [--no-commit] [--push] [--message <text>]`）
  - 安全标签：writes-worktree；commits-by-default；pushes-only-with-flag

---

所有清单字段的解释见 `schemas/v-cli-plugin.schema.json` 与 `v-cli agent describe` 输出。
