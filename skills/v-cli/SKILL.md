---
name: v-cli
description: >
  使用 kevlns 的个人工具箱 CLI（v-cli）处理配置表冲突与 Unity 工程精确版本工具链。当任务提到 v-cli、xlmerge、
  unity 命令、配置表 .xlsx/.xlsm Git 冲突处理、Unity CLI 安装、Unity 工程诊断/体检（doctor）、
  com.unity.pipeline 适配包安装、v-cli agent init 工作区初始化时使用本 skill。
---

# v-cli 使用规范

## 工具概述

- `@kevlns/v-cli` 是 npm 全局安装的个人工具箱 CLI，插件化架构；环境要求 Node.js >= 20（`unity` 插件仅 win32，其他平台 v-cli 拒绝路由）。
- 命令分三类：
  - **builtin**（内置）：`doctor`（环境体检）、`plugin list/path`（插件管理）、`ts`（时间戳互转）、`agent index/describe/docs/init`（agent 引导）。
  - **local**：`~/.v-cli/commands/` 下的本地插件。
  - **official**（官方插件，经 v-cli 路由）：`xlmerge`、`unity`。
- **本文件不写死任何版本号**：v-cli 本体与官方插件的实际版本、命令集合、参数一律以 `v-cli doctor` 与 `v-cli agent index --json` 的实时输出为准。

## 能力发现协议（核心规则，必须遵守）

**一切能力、参数、用法以 v-cli 自己的 agent 命令输出为准，严禁无头搜索 npm 安装目录、源码或 README 猜测用法。**

- `v-cli agent docs` — 输出 v-cli 内置 AGENTS.md（宿主规范全文；`--json` 含 sha256/content）。
- `v-cli agent index --json` — 枚举全部命令（builtin/local/official）与 agent 元数据，获取最新命令集合。
- `v-cli agent describe <命令名> --json` — 单个命令的完整记录：用法、参数、选项、输出格式、退出码、安全标签。
- `v-cli agent docs <命令名>` — 输出官方插件包内 AGENTS.md（该插件的使用规范正本）。
- live 命令集合以实际发现为准：先 `agent index --json`，再对目标命令 `agent describe <命令> --json`。

## 首调规范

**首次调用任何 official 插件命令（`v-cli xlmerge …`、`v-cli unity …`）前，必须先运行 `v-cli agent docs <命令名>` 读取该插件包内的 AGENTS.md 规范正本。** 使用规范、快速流程与禁止事项以插件自身 AGENTS.md 为准。

官方插件命令在子进程中运行（stdio 继承）：v-cli 只做路由，不解析、不改写插件输出；插件 `--help`/`--json` 等参数由插件自己消费。插件对 worktree 的写入/提交行为以插件清单的安全标签为准；**未经显式 flag 不得 push**。

## 工程初始化（agent init）

- `v-cli agent init [目录] [--force] [--dry-run] [--json]`：把内置 AGENTS.md 写入工作区，并把随包的 v-cli skill 装配到该目录下匹配的 agent 技能目录（如 `.claude/skills`、`.agent/skill`、`AgentHome/skills` 等，清单见 `src/core/agent-dirs.ts`）；无匹配目录则跳过。
- **强制约束**：只能在本仓 Git 根目录执行，先 `git rev-parse --show-toplevel` 定位并切换到根，禁止在任何子目录执行。
- 命中以下任一场景必须执行一次：① `v-cli` 未安装（先确认 Node.js >= 20 与 npm 可用，`npm install -g @kevlns/v-cli`，用 `v-cli --version` 与 `v-cli agent index --json` 验证）；② 项目内 skill（`<技能目录>/v-cli/SKILL.md`）缺失。两个场景同时命中只执行一次；命令用单数 `agent`，不得写成 `v-cli agents …`。
- 产物与归属：
  - 根 `AGENTS.md` 为**工具生成物**（建议纳入 `.gitignore`），禁止手改；需要更新内容时升级 v-cli 后重跑 init。
  - 分支不变式（实测）：① `AGENTS.md` 不存在 → 写入它**并**装配 skill；② `AGENTS.md` 已存在且未加 `--force` → **整体拒绝**（`action=refused`、`skill.status=skipped-init-failed`），不做任何改动；`--force` 会同时覆盖两者。
  - **skill 保护**：命中目录下已有 `v-cli/SKILL.md` 且内容与随包版本**不同**（项目侧已按实时命令面回补）时，默认**保留本地版本**（`action=kept`）而不覆盖；内容一致时正常覆盖；只有 `--force` 才会用随包版本替换本地版本。因此项目侧正本不会因日常 init 而降级。
- 先 `--dry-run --json` 预览目标与动作（含 `skill.assembled[].action` 与 `overwrite`），再实际写入。

## 官方插件一：xlmerge（跨平台）

Git 中 `.xlsx` / `.xlsm` 策划表/配置表冲突的公式感知可视化解决工具（三向 Sheet/行/列/Cell diff + 本地 UI + 原子写回与提交）。

- 命令面：`detect`、`filter add`、`prepare`、`resolve`、`launch`、`apply`（参数以 `v-cli agent describe xlmerge --json` 为准）。
- 正常流程（只做命令路由，不做表格分析）：
  1. `v-cli xlmerge --repo <仓库路径> detect` — 只读检测，返回 `count` / `reviewCount` / `autoTheirs` / `conflicts`。
  2. `count > 0` 时 `v-cli xlmerge --repo <仓库路径> launch`（不传 `--path`，整批处理）：
     - `reviewCount > 0`：把返回的 `url` 交给用户，**停止分析**，等用户在页面完成选择。
     - `reviewCount == 0`：不启动 UI，按过滤项写回并提交，报告其 JSON 结果。
  3. `count == 0`：报告无未解决冲突并结束。
- 硬性边界：不检查工作簿 Cell、不自行三方 diff、不总结冲突、不替用户选 ours/theirs、不因冲突量大而进入计划模式；**禁用阻塞式 `resolve` 作为正常入口**；`launch --no-browser` + `prepare`/`apply` 的无头链路仅限自动化测试或用户明确给出决策 JSON；`apply` 默认写回并 commit，`--no-commit` 仅用于测试，`--push` 仅在用户明确要求时。
- 仅处理单个文件时用 `launch --path <仓库相对路径>`；多文件禁止按文件循环调用。
- `filter add <path>` 会把规范化相对路径写入仓库根 `.xlmerge.json` 的 `autoTheirs`（幂等、大小写不敏感），命中项不进 UI，直接逐字节采用 Git index stage 3。**仅在用户明确要求某类生成表始终取远端整表时添加**。

## 官方插件二：unity（仅 win32）

Unity 2022 工程**精确版本路由**（版本号 + revision 双重匹配）+ 下载经验证的 Unity CLI（SHA-256 + Authenticode）+ 事务式安装适配版 `com.unity.pipeline` 包。

### 核心命令

| 命令 | 说明 |
|---|---|
| `v-cli unity doctor <project>` | 只读体检：路由 / CLI 状态 / 适配包状态 / 运行中的 Unity 进程 / 支持版本列表 |
| `v-cli unity setup <project>` | CLI + 适配包一键就绪（**首次入口推荐**，等价 cli install + pipeline install；`--dry-run` 预览、`--skip-cli` 跳过下载） |
| `v-cli unity pipeline install <project>` | 事务式安装适配包（staging → 校验 → 备份 → 替换 → 再校验 → receipt，失败自动回滚；`--dry-run` 只预览、`--force` 覆盖不一致的现有包） |
| `v-cli unity cli install` | 下载并校验固定版本 Unity CLI（`--editor <版本>` 限定、`--force` 重下） |
| `v-cli unity exec <project> [--wait <秒>] -- <unity-cli-args>` | 调用路由 CLI 执行 Unity Pipeline 命令（命令全集见 `v-cli agent docs unity`） |
| `v-cli unity routes` | 列出所有已配置的 Editor 精确路由（`-e <版本>` 过滤） |
| `v-cli unity cache clean` | 清理下载缓存与生成的适配包（`--all` 连 CLI 缓存一起清） |

### exec 前的就绪判据（必须全部满足）

- `doctor.cli.state == "valid"`；
- `doctor.pipeline.installed == true` **且** `doctor.pipeline.state == "current"`（`installedPatchVersion == patchVersion`）。

误判陷阱：`doctor` 退出码 0 只表示诊断完成；`pipeline.present == true` 只表示目录存在；升级 npm 包**不会**自动更新工程内适配包。未就绪一律先 `setup`，不得直接 `exec`。

就绪后的最后一道前提：`exec` 连接的是**已打开并加载适配包的目标工程 Editor**；Editor 未启动时报 `No Pipeline instance found for project: …`，这属于"未启动 Editor"，不是适配未就绪，**不得**因此重跑安装或绕过校验。

### 状态处置

| state | 处置 |
|---|---|
| `missing` | `v-cli unity setup <project>`（或 `pipeline install`） |
| `outdated` / `invalid` | 先关闭目标工程 Editor，再 `v-cli unity pipeline install <project> --force`（自动备份，备份与 receipt 都在 `Library/editor-pipeline-cli/`，已被 gitignore） |
| `current` | 可直接 `exec` |

receipt 属工程本地生成物：新克隆 / 清理 Library 后即使 `Packages/com.unity.pipeline` 已入库且文件树完好，`state` 仍会是 `invalid`，需按上一行重装一次补齐 receipt。

### 关键规则（违反即报错或导致损坏，必须遵守）

1. **exec 前必须满足上述就绪判据**；未就绪时先 setup，不要直接 exec。
2. **禁止在 exec 参数中传入任何 `--project-path` 变体**（`-projectPath`、`--project_path`、大小写混合、`=` 形式等）：目标工程由工具统一绑定，exec 会拒绝所有变体并把解析后的 `--project-path` 作为最后一个参数附加；`--` 分隔符被包装器消费，不转发给 Unity CLI。
3. **运行中的 Editor 是 fail-closed 保护，判定对象是「目标工程自己的」Editor 进程**；其他工程实例在跑不阻塞安装。被阻止时引导用户先关闭目标工程 Editor，**除非用户显式要求，不得使用 `--allow-running-editor` 绕过**。
4. **安装是事务式的**：不要手动清理工程内 `Packages/com.unity.pipeline` 或 `Library/editor-pipeline-cli`；失败会自动回滚，人为清理会破坏回滚与 receipt 校验。写入范围仅这两个目录。
5. **版本路由是精确匹配**（`m_EditorVersion` + revision 同时一致，以 `ProjectVersion.txt` 为准），无"就近版本"回退；工程版本不在路由表内时如实报告 `doctor` 输出的 `supportedVersions`，不得猜测、不得改写 `ProjectVersion.txt`。
6. **exec 每次调用前都会重新校验 CLI 哈希**（防篡改，属正常行为）；校验失败按提示 `v-cli unity cli install --force` 修复即可。
7. **读取 Editor 当前 Console 首选 `command read_console`**；`get_console_logs` 是兼容别名，`command console` 是回调捕获流，适合 cursor/since 跟随，不能替代原生 Console 快照。若 schema 中缺 `read_console`，先核对 `doctor` 的 `patchVersion`/`installedPatchVersion`/`state`，不要把它当成 `console` 的别名。
8. 工程内适配包已随仓入库；工具重装写出的文件树与仓库版本一致时（行尾由 `.gitattributes` 归一）**不应产生 git diff**，若出现大面积 diff 应先判定为行尾/编码现象再复核内容，不得据此手工回滚适配包。

### 长任务命令：启动即让出，用状态命令轮询

- u-cli-mod **0.2.0 起接管等待预算**：`run_tests` 这类同步长任务默认只等 **5 秒**，到点后任务仍在 Editor 内继续执行，工具打印输出日志路径（`<工程>/Library/editor-pipeline-cli/exec-logs/*.log`）并立即返回（退出码 0），不再有 30s 白等。
- 让出后**不要重复发起同一命令**，改用状态命令轮询：测试 `-- command test_status`（直到读到 `summary`），烘焙 `-- command <xxx>_bake_status`。
- 需要同步拿到完整 `Summary` 时用 `--wait <秒>` 扩大等待（写在 `--` 之前，u-cli-mod 自行剥离，不会透传给 Unity CLI）；`--wait 0` = 立即返回。
- **优先缩小范围**（最省事）：`run_tests --mode EditMode --filter <命名空间或测试类>` 通常数秒内就同步返回完整 `Summary`，无需轮询。
- 让出后任务仍在跑，不要重复发起；如需取消用 `-- command cancel_tests`（运行中可能被拒，稍后重试）。
- 若仍见到 `Pipeline command 'run_tests' timed out after 30000ms`，说明本机 v-cli/u-cli-mod 尚未升级到 0.2.0；升级后该提示消失。

## 典型流程

```bash
v-cli doctor                                                        # 0. 本机环境体检（版本、插件可用性）
v-cli agent init . --dry-run --json                                 # 1.（工程根）预览初始化动作
v-cli agent init .                                                  # 2. 写入 AGENTS.md + 装配 skill
v-cli agent docs unity                                              # 3. 首调前必读插件规范正本
v-cli unity doctor <project>                                        # 4. 体检（只读）判就绪
v-cli unity setup <project> --dry-run                               # 5.（可选）先预览
v-cli unity setup <project>                                         # 6. 就绪（CLI + 适配包 + receipt）
v-cli unity exec <project> -- command editor_status                 # 7. 执行 Pipeline 命令
v-cli unity exec <project> -- command read_console --types error,warning --count 100
v-cli unity exec <project> -- command run_tests --mode EditMode --filter <类名>   # 8. 测试（小范围同步返回）
v-cli xlmerge --repo . detect                                       # 配置表：只读检测
v-cli xlmerge --repo . launch                                       # 有冲突时启动本地 UI，把 url 交给用户
```
