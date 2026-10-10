---
name: v-cli
description: >
  使用 kevlns 的个人工具箱 CLI（v-cli）处理配置表冲突、Unity 工程精确版本工具链、Figma 转 Unity UGUI Prefab、Steam/微信小游戏交付与美术工坊风格分析、生图和图编辑。当任务提到 v-cli、xlmerge、ship-cli、美术工坊、art-workshop、
  unity / figma 命令、figma-to-uprefab、配置表 .xlsx/.xlsm Git 冲突处理、Unity CLI 安装、Unity 工程诊断/体检（doctor）、
  com.unity.pipeline 适配包安装、v-cli agent init 工作区初始化时使用本 skill。
---

# v-cli 使用规范

## 工具概述

- `@kevlns/v-cli` 是 npm 全局安装的个人工具箱 CLI，插件化架构；环境要求 Node.js >= 20（`unity` 与 `figma` 插件仅 win32，其他平台 v-cli 拒绝路由）。
- 命令分三类：
  - **builtin**（内置）：`doctor`（环境体检）、`plugin list/path`（插件管理）、`ts`（时间戳互转）、`agent index/describe/docs/init`（agent 引导）、`project init/inspect`（工程绑定）、`capability list/describe/run`（结构化能力执行）。
  - **local**：`~/.v-cli/commands/` 下的本地插件。
  - **official**（官方插件，经 v-cli 路由）：`xlmerge`、`unity`、`figma`、`ship`、`art`。
- **本文件不写死任何版本号**：v-cli 本体与官方插件的实际版本、命令集合、参数一律以 `v-cli doctor` 与 `v-cli agent index --json` 的实时输出为准。

## 工程执行基座：project / capability（结构化执行与验收分离）

v-cli 是**注册和执行基座**：capability 具有稳定 id、版本、输入/输出 schema、前置条件、声明的副作用、资源需求与重试语义。
Vant 组织层负责任务调度/持久化任务/资源租约；v-cli 只做注册与执行，并在 `<工程根>/.vant/state/operations/<operationId>/` 留本地记录。

### 命令

- `v-cli project init [--project <目录>] [--unity-project <目录>] [--editor-version <版本>] [--test-mode <EditMode|PlayMode>] [--json]`
  — 写入 `.vant/config/v-cli.json`（只放 CLI 能力/适配器绑定）。**已存在一律拒绝**；不修改、不读 Vant 的 `.vant/config/project.json`（角色/workflow 归 Vant）。
- `v-cli project inspect [--project <目录>] [--json]` — 只读检查配置、绑定目录、`.vant` 布局与 provider 发现状态。
- `v-cli capability list [--provider <id>] [--json]` — 列出 capability（只读，不执行工具）。
- `v-cli capability describe <id> [--json]` — 单能力完整契约；执行前先读它，不猜参数。
- `v-cli capability run <id> [--project <目录>] [--input <json> | --input-file <路径>] [--set k=v]… [--operation-id <id>] [--task-id <id>] [--run-id <id>] [--no-persist] [--json]`

### 硬性规则

1. **验收与退出码**：进程退出码 0 不等于业务通过。`execution.status`（succeeded/failed/cancelled/unknown）与 `acceptance.status`（passed/failed/not-run）分开读。
   `capability run` 退出码：`0` 验收 passed；`1` 执行或验收失败；`2` 未执行（入参/配置/前置条件/资源授权）；`3` 已执行但验收 not-run；`4` 已确认取消；`5` 结果未知。
2. **退出码 3 = 未通过**：`acceptance.pending=true` 时按 `followUp` 轮询对应状态能力，不得把"已启动/已触发"报告为成功。
3. **异步能力**：`unity.compile`/`unity.test-start` 只报告 accepted；完成判定用 `unity.compile-status`/`unity.test-status`。
4. **测试通过判据**：只有 `test_status=completed` **且失败数 0 且存在有效报告**才算 passed；缺字段/未知取值一律不通过。
5. **取消**：只有确认（响应字段或 `test_status` 探测）才认为取消生效；未确认不得报告已取消。
6. **工程根**：一律 `--project` 显式锚定；能力输入不接受 `projectPath` 覆盖（用 `--set projectPath=…` 会因 schema `additionalProperties:false` 直接失败）。
7. **配置缺失**：报 `project-config-missing` 时先 `v-cli project init --project <工程根>`；不要手写配置里的角色/workflow（会被拒绝）。
8. **operationId**：默认自动生成；显式传入时同一 id 只能执行一次（已存在直接拒绝，绝不覆盖）。`--no-persist` 仅用于测试/SDK 探测，会失去本地证据记录。
9. Unity capability 走受控 argv（不拼 shell）；exec 前默认自动 doctor 就绪核对（不得跳过）。真实 Unity 协议字段以 `capability describe` 与执行结果中的 `output`/`evidence` 为准，不要自行发明字段。

### Unity capability 一览（先 describe 再 run）

| id | 用途 | 验收 |
|---|---|---|
| `unity.doctor` | 只读体检（路由/CLI/适配包） | routeSupported+cli.state=valid+pipeline.installed+pipeline.state=current |
| `unity.editor-status` | Editor/Pipeline 连接状态 | `status="ready"` |
| `unity.compile` | 触发重编译（异步） | 一律 not-run(pending) → 轮询 `unity.compile-status` |
| `unity.compile-status` | 重编译状态 | completed/up_to_date → passed；进行中 → pending；其余不通过 |
| `unity.test-start` | 启动测试（固定 `--async_tests`） | 一律 not-run(pending) → 轮询 `unity.test-status` |
| `unity.test-status` | 测试状态与失败数 | completed + 失败数 0 + 有效报告 → passed |
| `unity.test-cancel` | 请求取消测试 | 需确认（响应或探测）才 passed |

## 能力发现协议（核心规则，必须遵守）

**一切能力、参数、用法以 v-cli 自己的 agent 命令输出为准，严禁自行翻查 npm 安装目录、源码或 README 来猜测用法。**

- `v-cli agent docs` — 输出 v-cli 内置 AGENTS.md（宿主规范全文；`--json` 含 sha256/content）。
- `v-cli agent index --json` — 枚举全部命令（builtin/local/official）与 agent 元数据，获取最新命令集合。
- `v-cli agent describe <命令名> --json` — 单个命令的完整记录：用法、参数、选项、输出格式、退出码、安全标签。
- `v-cli agent docs <命令名>` — 输出官方插件包内 AGENTS.md（该插件的使用规范正本）。
- live 命令集合以实际发现为准：先 `agent index --json`，再对目标命令 `agent describe <命令> --json`。

## 首调规范

**首次调用任何 official 插件命令（`v-cli xlmerge …`、`v-cli unity …`、`v-cli figma …`、`v-cli ship …`、`v-cli art …`）前，必须先运行 `v-cli agent docs <命令名>` 读取该插件包内的 AGENTS.md 规范正本。** 使用规范、快速流程与禁止事项以插件自身 AGENTS.md 为准。

官方插件命令在子进程中运行（stdio 继承）：v-cli 只做路由，不解析、不改写插件输出；插件 `--help`/`--json` 等参数由插件自己消费。插件对 worktree 的写入/提交行为以插件清单的安全标签为准；**未经显式 flag 不得 push**。

## 工程初始化（agent init）

- `v-cli agent init [目录] [--force] [--dry-run] [--json]`：把内置 AGENTS.md 写入工作区，并把随包的 v-cli skill 装配到该目录下匹配的 agent 技能目录（如 `.claude/skills`、`.agent/skill`、`AgentHome/skills` 等）；无匹配目录则跳过。
- **强制约束**：只能在目标工程的 Git 根目录执行，先 `git rev-parse --show-toplevel` 定位并切换到根，禁止在任何子目录执行。
- 命中以下任一场景必须执行一次：① `v-cli` 未安装（先确认 Node.js >= 20 与 npm 可用，`npm install -g @kevlns/v-cli`，用 `v-cli --version` 与 `v-cli agent index --json` 验证）；② 项目内 skill（`<技能目录>/v-cli/SKILL.md`）缺失。两个场景同时命中只执行一次；命令用单数 `agent`，不得写成 `v-cli agents …`。
- 产物与归属：
  - 根 `AGENTS.md` 为**工具生成物**（建议纳入 `.gitignore`），禁止手改；需要更新内容时升级 v-cli 后重跑 `agent init --force`。
  - `AGENTS.md` 已存在且未加 `--force` 时**整体拒绝**，不做任何改动；`--force` 同时覆盖 AGENTS.md 与 skill。
  - **skill 同步**：随包版本是唯一权威——已有 `v-cli/SKILL.md` 一律按随包刷新（本地修改被覆盖并提示）；随包没有的文件（项目扩展，如 `PROJECT.md`）默认保留，`--force` 时完全同步。项目不要直接改 `SKILL.md`，专属内容写扩展文件。
- 先 `--dry-run --json` 预览目标与动作（含 `skill.assembled[].action` 与 `overwrite`），再实际写入。

## 官方插件一：xlmerge（跨平台）

Git 中 `.xlsx` / `.xlsm` 策划表/配置表冲突的公式感知可视化解决工具（三向 Sheet/行/Cell diff + 本地 UI + 原子写回与提交）。

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

receipt 属工程本地生成物；就绪以当前路由的完整文件树校验为准。新克隆 / 清理 Library 后，文件树完好仍为 `current`，不因 receipt 缺失或陈旧要求重装。`pipeline.verification` 列出不匹配文件与仅行尾差异；`sourceReady=false` 只表示生成缓存需重建，不代表已安装包失效。新生成文本统一 LF，已安装文本兼容 LF/CRLF 等价，二进制和实际内容仍严格校验。

### 关键规则（违反即报错或导致损坏，必须遵守）

1. **exec 前必须满足上述就绪判据**；未就绪时先 setup，不要直接 exec。
2. **禁止在 exec 参数中传入任何 `--project-path` 变体**（`-projectPath`、`--project_path`、大小写混合、`=` 形式等）：目标工程由工具统一绑定，exec 会拒绝所有变体并把解析后的 `--project-path` 作为最后一个参数附加；`--` 分隔符被包装器消费，不转发给 Unity CLI。
3. **运行中的 Editor 是 fail-closed 保护，判定对象是「目标工程自己的」Editor 进程**；其他工程实例在跑不阻塞安装。被阻止时引导用户先关闭目标工程 Editor，**除非用户显式要求，不得使用 `--allow-running-editor` 绕过**。
4. **安装是事务式的**：不要手动清理工程内 `Packages/com.unity.pipeline` 或 `Library/editor-pipeline-cli`；失败会自动回滚，人为清理会破坏回滚与 receipt 校验。写入范围仅这两个目录。
5. **版本路由是精确匹配**（`m_EditorVersion` + revision 同时一致，以 `ProjectVersion.txt` 为准），无"就近版本"回退；工程版本不在路由表内时如实报告 `doctor` 输出的 `supportedVersions`，不得猜测、不得改写 `ProjectVersion.txt`。
6. **exec 每次调用前都会重新校验 CLI 哈希**（防篡改，属正常行为）；校验失败按提示 `v-cli unity cli install --force` 修复即可。
7. **读取 Editor 当前 Console 首选 `command read_console`**；`get_console_logs` 是兼容别名，`command console` 是回调捕获流，适合 cursor/since 跟随，不能替代原生 Console 快照。若 schema 中缺 `read_console`，先核对 `doctor` 的 `patchVersion`/`installedPatchVersion`/`state`，不要把它当成 `console` 的别名。
8. 工程内适配包已随仓入库；工具重装写出的文件树与仓库版本一致时（行尾由 `.gitattributes` 归一）**不应产生 git diff**，若出现大面积 diff 应先判定为行尾/编码现象再复核内容，不得据此手工回滚适配包。

### 长任务命令：全量测试走异步，小范围走同步

- Unity CLI 对同步命令有 30 秒硬性等待上限（`--wait`/`--timeout` 均无法延长），同步 `run_tests` 全量必然超时。
- 全量：`-- command run_tests --mode EditMode --async_tests`（立即返回）→ 轮询 `-- command test_status` 至 `completed` 拿完整 Summary。
- 小范围：`--filter <命名空间或类>` 通常数秒内同步返回完整 Summary。
- 5 秒让位机制只保证 CLI 子进程存活并把输出写入 `Library/editor-pipeline-cli/exec-logs/*.log`，不改变 Editor 侧任务的同步语义；让出后不要重复发起同一命令，取消用 `-- command cancel_tests`。

## 官方插件三：figma（仅 win32）

- 用于标记 Figma 界面导出、staging 契约校验、Unity 转换包安装与 UGUI Prefab 构建；目标工程需要 Unity 2022.3 和 Vant Framework。
- 首次调用先读 `v-cli agent docs figma`，参数以 `v-cli agent describe figma --json` 为准。
- 用户配置按工程保存在 `~/.config/figma-to-uprefab/config.json`；token 来自 `FIGMA_ACCESS_TOKEN` 或工程配置段，不写入仓库。
- `export` 只导出 source manifest、节点 PNG 和根索引；source → IR → Prefab 由嵌入式 C# 转换器完成。
- 构建前使用 `contract --allow-missing-ir`；安装转换包并 `build` 后运行完整 `contract`。
- 输出限于 staging；不自动迁入正式资源目录、不写 UIConfig。NGUI 当前不支持。

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
v-cli unity exec <project> -- command run_tests --mode EditMode --async_tests     #    全量：立即返回，轮询 test_status
v-cli xlmerge --repo . detect                                       # 配置表：只读检测
v-cli xlmerge --repo . launch                                       # 有冲突时启动本地 UI，把 url 交给用户
```

## 游戏交付插件 ship

对已构建游戏进行 Steam / 微信小游戏校验、扫码预览或开发版上传时，先 `v-cli agent describe ship --json` 确认可用，再读取 `v-cli agent docs ship`。`ship` 是官方插件，与 v-cli 安装在同一 npm prefix 后自动发现；缺失时报告 missing，安装需要对应任务授权。

选择正确工程后执行 `v-cli ship --project <工程目录> doctor --json`，检查体检 ok 和 fail 项。具体平台命令、上传授权边界、凭据和体积口径以 ship 随包规范为准。Steam preview 不上传；微信 preview 调用服务并返回二维码路径。正式发布由平台后台处理。

## 美术工坊插件 art

风格分析与核心冻结、统一风格多工程生图或编辑现有图片时，先读 `v-cli agent docs art`，用 `v-cli agent describe art --json` 查看参数。再用 `v-cli art config show`、`v-cli art agent index` 和 `v-cli art config validate` 确认外部工作目录、工程、核心及后端。一份配置可声明远程百炼与本地 ComfyUI；风格分析仍使用远程百炼。本地先 `workflow list`、`doctor` 检查内置或自定义工作流与环境；默认内置 vant-builtin-qwen-image-2.1-Q4-8GB，服务在任务执行时懒启动。按 style、generate、edit 执行，先 plan 和 run --dry；冻结计划不能同时传 --backend。单次任务用 `task list/status/wait/cancel`，`shutdown` 停止全部任务并关闭服务。完整模式规范用 `v-cli art agent docs` 查看；真实分析、生图与编辑按任务授权执行。
