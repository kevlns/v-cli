# Vant 工具命令入口 Agent 规范

## 定位

发现工具、绑定工程、执行结构化能力并保存操作证据。

## 调用流程

先 doctor 和 agent index，再读取目标工具的 agent docs 与 describe。

## 调用规范


<!-- v-cli-agents:generated -->

> 本文件由 `scripts/generate-agents.mjs` 自动生成，请勿手改。
> 修改插件清单后运行 `npm run generate:agents` 重新生成，`npm run check:agents` 校验漂移。

### 核心约定（v-cli 本体）

- 环境要求 Node.js >= 20；v-cli 版本 @kevlns/v-cli@0.4.8
- 命令分三类：builtin（内置）、local（~/.vant/tools/v-cli/commands/ 下的本地插件）、official（官方插件白名单）；
  **命令集合以实际发现为准**：先运行 `v-cli agent index --json` 获取全部命令与 agent 元数据
- 单个命令的完整元数据用 `v-cli agent describe <命令名> --json` 查看
- AI Agent 引导文档：`v-cli agent docs` 输出本文件原文（`--json` 含 sha256/content）；
  `v-cli agent init .` 把它写入工作区（已存在默认拒绝，`--force` 覆盖，`--dry-run` 预览；符号链接目标 fail-closed）；
  同时把随包发布的 v-cli skill（skills/v-cli）装配到 <目录> 下匹配的 agent 技能目录（如 .claude/skills、.agent/skill、AgentHome/skills 等），无匹配则跳过；
  随包版本是规范唯一权威：同名 SKILL.md 一律按随包版本刷新（本地修改会被覆盖并提示）；随包没有的文件（项目扩展，如 PROJECT.md）默认保留，`--force` 时完全同步
- 工程执行基座（内置命令）：`v-cli project init|inspect` 管理工程根绑定 `.vant/config/v-cli.json`
  （该文件只写 CLI 能力/适配器绑定；角色/workflow/项目组织属于 Vant 的 `.vant/config/project.json`，v-cli 既不读也不写）；
  `v-cli capability list|describe|coverage|run` 列出/查看/执行结构化 capability（稳定 id、输入输出 schema、前置条件、声明的副作用、资源需求、重试语义）
- 所有官方命令都登记能力映射；`capability coverage --json` 检查遗漏。内核执行跨进程共享/独占资源租约；权限授权与资源互斥分开，后台审阅进程确认退出前继续占用资源。
- capability run 的语义：工程根用 `--project` 显式锚定；输入由配置绑定（不接受 projectPath 等覆盖）；
  **执行状态与验收状态分离**——工具进程退出码 0 不等于业务通过，capability 退出码 0 只在验收 passed 时出现（1=执行/验收失败，2=未执行，3=已执行但验收 not-run 需按 followUp 轮询，4=已确认取消，5=结果未知）；
  每次执行在 `<工程根>/.vant/state/operations/<operationId>/` 保存输入摘要、事件与结果证据（本地记录，不是任务队列；`--no-persist` 可关闭）；
  **lifecycle 是任务级六态**（accepted/running/completed/failed/cancelled/unknown；unknown=不可解释/不可知，绝不升级）；异步触发在结果 `handle` 中返回可序列化执行句柄——查询/取消类能力以 `input.handle` 传入并用内核校验（落盘证据回读，失败明确拒绝不回退最近任务）；Unity 后端提供 runId：`unity.compile`/`unity.test-start` 句柄的 backendTaskId=runId，用 `unity.compile-query`/`unity.test-query`/`unity.test-cancel-run` 按句柄关联查询/定向取消（关联失效=后端 unknown_run，明确 failed 不采信其他任务记录）
- 默认结构化 provider 为 unity、figma、art、ship、xlmerge；先 `v-cli capability describe <id> --json` 读契约，受控 argv 调用不拼 shell；
  figma provider（`@kevlns/figma-to-uprefab`，离线）：`figma.contract` 校验 staging 契约（roots>0 才通过）、`figma.doctor` 只读诊断——v-cli 注入无令牌托管配置，无网络、不碰凭据；
  exec 类能力默认自动跑一次 doctor 核对就绪判据（不得跳过）；`unity.compile`/`unity.test-start` 是异步触发，只报告 accepted，按原 handle 轮询 `unity.compile-query`/`unity.test-query`；无参 status 只观察当前/最近槽位；测试 completed、有效非零报告且全部用例通过才 passed
- **首调规范**：首次调用任何 official 插件命令前，必须先运行 `v-cli agent docs <命令名>`，
  掌握该插件包内 `AGENTS.md`；使用规范、快速流程与禁止事项以插件 AGENTS.md 为准。
- 官方插件命令（`v-cli xlmerge …`、`v-cli unity …`、`v-cli figma …`、`v-cli ship …`、`v-cli art …`）在子进程中运行（stdio 继承）：v-cli 只做路由，不解析或改写插件输出。
- `art` 是随包美术工坊插件；先读 `v-cli agent docs art`，用 `v-cli art config show`、`v-cli art agent index` 和 `v-cli art config validate` 确认工程、核心及远程/本地后端。本地执行前用 `workflow list` 和 `doctor` 检查工作流与环境；任务控制用 `task list/status/wait/cancel/recover/resume`；resume 只查询原上游与下载。`shutdown` 停止当前工作区关联任务，核验共享队列和进程身份后关闭服务。真实分析和生成按任务授权执行。
- `ship` 是随包官方插件（@kevlns/ship-cli），随 v-cli 安装并自动发现；先运行 `v-cli agent docs ship`、`v-cli ship doctor --json`，再按 Steam / 微信小游戏流程执行。缺失时明确报告 missing，不在运行时自动安装。
- 插件 `--help`/`--json` 等参数由插件自己消费；art 的模型登记、参数策略和执行回执归工具维护，v-cli 不复制目录。
- 插件对 worktree 的写入/提交行为以插件清单 v-cli.plugin.json 的 `agent.safety` 为准：
  v-cli 不替插件做 diff/write-back/commit；**未经显式 flag 不得 push**

### @kevlns/art-workshop — 命令 `v-cli art …`

**版本**：0.3.9
**描述**：管理项目风格、参考图、图片生成、编辑和定版。支持本地 ComfyUI 与远程图片模型。
**平台**：win32, linux, darwin

**何时使用**：先读取对象和版本，编译并预演后在授权范围后台执行。风格分析有独立运行身份，采用检查报告来源；任务空闲才可编辑，停止未确认保留资源。生成完成仅做技术完整性校验，用户定版，不要求人工三维评分。

**首次调用前必读**：`v-cli agent docs art`（插件包内 AGENTS.md 规范正本）
**实时参数/命令**：`v-cli agent describe art --json`

### @kevlns/figma-to-uprefab — 命令 `v-cli figma …`

**版本**：0.1.4
**描述**：将 Figma 标记画板导出为源数据和图片，通过 Unity 转换器生成 UGUI 预制体。
**平台**：win32（仅 Windows 主机可用；非 Windows 上 v-cli 会拒绝路由）

**何时使用**：导出 Figma 标记画板，校验源清单与图片，在 Unity 中生成暂存 UGUI 预制体；不将产物直接转入运行时目录或写入 UIConfig。

**首次调用前必读**：`v-cli agent docs figma`（插件包内 AGENTS.md 规范正本）
**实时参数/命令**：`v-cli agent describe figma --json`

### @kevlns/ship-cli — 命令 `v-cli ship …`

**版本**：0.1.2
**描述**：校验已构建的游戏产物，执行 Steam 上传、微信小游戏预览和开发版上传。
**平台**：win32, linux, darwin

**何时使用**：处理已构建游戏的 Steam 上传、微信小游戏预览与开发版上传；执行离线产物校验与环境检查。正式发布、提审和账号管理在平台后台完成，工具不构建引擎产物。

**首次调用前必读**：`v-cli agent docs ship`（插件包内 AGENTS.md 规范正本）
**实时参数/命令**：`v-cli agent describe ship --json`

### @kevlns/u-cli-mod — 命令 `v-cli unity …`

**版本**：0.3.1
**描述**：按 Unity Editor 精确版本定位工具链，校验和安装 com.unity.pipeline，并执行工程命令。
**平台**：win32（仅 Windows 主机可用；非 Windows 上 v-cli 会拒绝路由）

**何时使用**：用于 Windows 的 Unity 2022 工程诊断、精确版本路由、已校验工具下载、事务式安装及明确绑定工程的 Pipeline 调用。

**首次调用前必读**：`v-cli agent docs unity`（插件包内 AGENTS.md 规范正本）
**实时参数/命令**：`v-cli agent describe unity --json`

### @kevlns/xlmerge — 命令 `v-cli xlmerge …`

**版本**：2.0.4
**描述**：在浏览器中审阅 Git 冲突工作簿的三方差异，校验后写回并提交合并结果。
**平台**：darwin, linux, win32

**何时使用**：When a user asks to resolve Git merge conflicts in .xlsx/.xlsm planning or configuration tables (策划表/配置表冲突): run detect first; when reviewCount > 0 run launch and give the returned url to the user. Configured auto-theirs filters may resolve and commit matched generated workbooks without opening the UI. Do not inspect workbook cells or summarize diffs yourself; the resolver owns diff, choices, write-back and commit.

**首次调用前必读**：`v-cli agent docs xlmerge`（插件包内 AGENTS.md 规范正本）
**实时参数/命令**：`v-cli agent describe xlmerge --json`

---

所有清单字段的解释见 `schemas/v-cli-plugin.schema.json` 与 `v-cli agent describe` 输出。

## 结果验证

执行状态、任务生命周期和业务验收分别判断；未知结果不能视为成功。

## 参考资料

[使用说明](README.md) · [文档规范](docs/documentation.md)

## 许可与版权

MIT。Copyright © 2026 Vant。
