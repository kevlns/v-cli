<!-- Copyright © 2026 Vant <sl_kevln@163.com> -->

# Vant 工具命令入口 Agent 规范

## 定位

发现工具、绑定工程、执行结构化能力并保存操作证据。

## 调用流程

按任务选择下方路由和参数。陌生操作可定向读取单项契约；需要诊断环境时用 doctor。

## 调用规范


<!-- v-cli-agents:generated -->

> 本文件由 `scripts/generate-agents.mjs` 自动生成，请勿手改。
> 修改插件清单后运行 `npm run generate:agents` 重新生成，`npm run check:agents` 校验漂移。

### 核心约定（v-cli 本体）

- 环境要求 Node.js >= 20；v-cli 版本 @kevlns/v-cli@0.8.2
- 命令分三类：builtin（内置）、local（~/.vant/tools/v-cli/commands/ 下的本地插件）、official（官方插件白名单）；
- 单个命令的完整元数据用 `v-cli agent describe <命令名> --json` 查看
- AI Agent 引导文档：`v-cli agent docs` 输出运行技能入口（`--json` 含 sha256/content）；
- 工程执行基座（内置命令）：`v-cli project init|inspect` 管理工程根绑定 `.vant/config/v-cli.json`
  （该文件只写 CLI 能力/适配器绑定；角色/workflow/项目组织属于 Vant 的 `.vant/config/project.json`，v-cli 既不读也不写）；
  `v-cli capability list|describe|coverage|run` 列出/查看/执行结构化 capability（稳定 id、输入输出 schema、前置条件、声明的副作用、资源需求、重试语义）
- 所有官方命令都登记能力映射；`capability coverage --json` 检查遗漏。内核执行跨进程共享/独占资源租约；权限授权与资源互斥分开，后台审阅进程确认退出前继续占用资源。
- capability run 的语义：工程根用 `--project` 显式锚定；输入由配置绑定（不接受 projectPath 等覆盖）；
  **执行状态与验收状态分离**——工具进程退出码 0 不等于业务通过，capability 退出码 0 只在验收 passed 时出现（1=执行/验收失败，2=未执行，3=已执行但验收 not-run 需按 followUp 轮询，4=已确认取消，5=结果未知）；
  每次执行在 `<工程根>/.vant/state/operations/<operationId>/` 保存输入摘要、事件与结果证据（本地记录，不是任务队列；`--no-persist` 可关闭）；
  **lifecycle 是任务级六态**（accepted/running/completed/failed/cancelled/unknown；unknown=不可解释/不可知，绝不升级）；异步触发在结果 `handle` 中返回可序列化执行句柄——查询/取消类能力以 `input.handle` 传入并用内核校验（落盘证据回读，失败明确拒绝不回退最近任务）；Unity 后端提供 runId：`unity.compile`/`unity.test-start` 句柄的 backendTaskId=runId，用 `unity.compile-query`/`unity.test-query`/`unity.test-cancel-run` 按句柄关联查询/定向取消（关联失效=后端 unknown_run，明确 failed 不采信其他任务记录）
- 默认结构化 provider 为 unity、figma、art、ship、xlmerge；按需用 `v-cli capability describe <id> --json` 读契约，受控 argv 调用不拼 shell；
  figma provider（`@kevlns/figma-to-uprefab`，离线）：`figma.contract` 校验 staging 契约（roots>0 才通过）、`figma.doctor` 只读诊断——v-cli 注入无令牌托管配置，无网络、不碰凭据；
  exec 类能力默认自动跑一次 doctor 核对就绪判据（不得跳过）；`unity.compile`/`unity.test-start` 是异步触发，只报告 accepted，按原 handle 轮询 `unity.compile-query`/`unity.test-query`；无参 status 只观察当前/最近槽位；测试 completed、有效非零报告且全部用例通过才 passed
- 官方插件命令（`v-cli xlmerge …`、`v-cli unity …`、`v-cli figma …`、`v-cli ship …`、`v-cli art …`）在子进程中运行（stdio 继承）：v-cli 只做路由，不解析或改写插件输出。
- `art` 是随包美术工坊插件；用 `v-cli art config show`、`v-cli art agent index` 和 `v-cli art config validate` 确认工程、核心及远程/本地后端。本地执行前用 `workflow list` 和 `doctor` 检查工作流与环境；任务控制用 `task list/status/wait/cancel/recover/resume`；resume 只查询原上游与下载。`shutdown` 停止当前工作区关联任务，核验共享队列和进程身份后关闭服务。真实分析和生成按任务授权执行。
- `ship` 是随包官方插件（@kevlns/ship-cli），随 v-cli 安装并自动发现；Steam 和微信小游戏分别通过 steam 与 wx 路由发布。缺失时明确报告 missing，不在运行时自动安装。
- 插件 `--help`/`--json` 等参数由插件自己消费；art 的模型登记、参数策略和执行回执归工具维护，v-cli 不复制目录。
- 插件对 worktree 的写入/提交行为以插件清单 v-cli.plugin.json 的 `agent.safety` 为准：
  v-cli 不替插件做 diff/write-back/commit；**未经显式 flag 不得 push**

### @kevlns/art-workshop — 命令 `v-cli art …`

**版本**：0.7.1
**描述**：管理图片、视频与 Spine 骨骼动画制作。
**平台**：win32, linux, darwin

**何时使用**：读取对象和版本，保存规则即更新当前风格。按规则生成样张，在图片卡片上定版后自动加入风格运行时参考；原始分主题参考只用于分析。生成先编译预演，未知运行只恢复原身份。

**操作指南**：`v-cli agent docs art`（插件包内 清单声明的 SKILL.md）
**实时参数/命令**：`v-cli agent describe art --json`

- `v-cli art help` 显示命令入口与 v-cli 发现方式
- `v-cli art config path` 显示本地配置文件路径
- `v-cli art config show` 显示生效的本地配置和外部资源路径
- `v-cli art config init` 配置不存在时创建本地模板；已存在时读取，不覆盖
- `v-cli art refs guide [--project <id>]` 解释参考分类目录的用途与推荐图片样式
- `v-cli art agent index` 发现模块、工程、核心、任务与随包 skill
- `v-cli art agent docs` 输出全部随包模式、配置、工程、命令、诊断与核心指南
- `v-cli art agent export --host codex --directory <DIR> [--dry]` 显式导出技能到指定宿主目录；默认安装不导出
- `v-cli art list` 列出外部工作目录中的工程
- `v-cli art style show [--project <id>] [--core <id>]` 读取当前工程的指定冻结核心并验证完整性
- `v-cli art generate show [--project <id>] [--job <id>]` 读取文生图任务
- `v-cli art generate plan [--project <id>] [--job <id>] [--core <id>] [--out <file>]` 编译文生图计划，明确来源及真实请求
- `v-cli art generate run [--plan <file>] [--project <id>] [--job <id>] [--core <id>] [--item <id>] [--variant <id>] [--explore] [--offset <n>] [--limit <n>] [--dry]` 执行或预演文生图计划
- `v-cli art edit show [--project <id>] [--job <id>]` 读取图编辑任务
- `v-cli art edit plan [--project <id>] [--job <id>] [--core <id>] [--out <file>]` 编译图编辑计划，明确来源及真实请求
- `v-cli art edit run [--plan <file>] [--project <id>] [--job <id>] [--core <id>] [--item <id>] [--variant <id>] [--explore] [--offset <n>] [--limit <n>] [--dry]` 执行或预演图编辑计划
- `v-cli art check RUN` 核验运行计划、执行归属、产物与文件哈希；不进行人工评分
- `v-cli art compare BEFORE AFTER` 比较两份计划或执行记录的核心、执行配置和单体变更
- `v-cli art task list` 列出任务状态
- `v-cli art task status TASK` 查看单次任务及后端 prompt_id
- `v-cli art task wait TASK` 等待任务结束；超时不取消任务
- `v-cli art task cancel TASK` 取消单次任务并等待停止
- `v-cli art shutdown` 停止当前工作区关联任务，核验共享队列和进程身份后关闭服务
- `v-cli art config validate` 校验配置和 API workflow 的结构、连接与参数绑定
- `v-cli art doctor` 检测本地 ComfyUI 环境、节点与模型
- `v-cli art workflow list` 列出默认内置工作流及 API/UI 文件位置
- `v-cli art style create` 创建独立草稿对象
- `v-cli art style list` 列出工程对象及任务展示状态
- `v-cli art style read` 读取指定对象与版本
- `v-cli art style update` 保存风格名称、规则与配置；已保存风格可随时修改，更新当前执行版本并保留历史快照
- `v-cli art style derive` 派生独立草稿，保留结构化规则与独立参考；当前冻结证据标记沿用，不继承核心、执行或授权
- `v-cli art style discard` 确认空闲后丢弃草稿并清理所属资源
- `v-cli art job create` 创建独立草稿对象
- `v-cli art job list` 列出工程对象及任务展示状态
- `v-cli art job read` 读取指定对象与版本
- `v-cli art job update` 校验预期版本及空闲状态后更新对象
- `v-cli art job derive` 派生独立草稿，不继承执行、报告或定版
- `v-cli art job discard` 归档已停止的任务，保留配置、参考、收藏、图片与执行历史；可恢复到活跃列表
- `v-cli art job restore` 恢复已归档任务到活跃列表，保留原身份、配置与历史；不重新执行
- `v-cli art style recover` 恢复已授权采用事务
- `v-cli art project init` 新建版本 2 工程
- `v-cli art project upgrade` 显式一次性工程升级
- `v-cli art reference list` 查看对象参考
- `v-cli art reference import` 导入对象私有图片
- `v-cli art reference remove` 移除参考关联
- `v-cli art candidate list` 查看真实候选及完整性
- `v-cli art candidate favorites --project <id>` 网格收藏夹的数据来源，列出工程中仍可用的收藏图片及源任务身份
- `v-cli art candidate favorite --project <id> --job <id> --run <id> --candidate <id> --value <true|false>` 设置图片收藏状态，不修改任务需求、版本、定版或运行状态
- `v-cli art candidate finalizations` 查看资产定版
- `v-cli art candidate finalize` 按资产定版候选
- `v-cli art candidate delete` 删除候选及关联定版
- `v-cli art job analyze` 分析任务动态参考，仅转写指定用途，不继承静态风格
- `v-cli art task recover --project P --operation OPERATION` 仅从唯一原运行登记恢复身份；绝不重新执行
- `v-cli art reference update --project P --kind style --id ID --revision N --item REF --input PATCH.json` 更新参考分类、任务用途与说明，版本校验并使分析失效
- `v-cli art art job template --project <id> --kind <generate|edit> [--core <id>]` 只读返回工具权威的任务配置模板；生成任务使用已冻结核心的题材
- `v-cli art art job from-candidate --project <id> --id <task> --run <id> --candidate <id>` 将已停止批次中的可用图片导入私有底图，创建独立编辑草稿，不要求定版通过、不运行
- `v-cli art task resume TASK` 仅恢复原上游任务的查询和下载，绝不重新提交
- `v-cli art environment guide` 本地环境部署指南
- `v-cli art environment list` 本地环境目录发现
- `v-cli art environment prepare` 自动准备兼容 Python 运行时，保留已有环境
- `v-cli art environment inspect` 本地环境只读检测
- `v-cli art environment verify` 本地环境确定性验收
- `v-cli art environment register` 本地环境验收并登记
- `v-cli art environment unregister` 本地环境解除登记
- `v-cli art style export` 导出冻结风格及必要参考，不复制运行状态
- `v-cli art style import` 导入固定版本的共享冻结风格，保留原身份和版本
- `v-cli art style sources` 只读列出多个冻结风格来源并报告不可用目录和身份冲突
- `v-cli art conversation start --config <path> --input <path>` 编译并幂等提交会话出图，不创建项目任务
- `v-cli art conversation status --config <path> --session <id> --request <id>` 查询原运行与真实产物
- `v-cli art conversation cancel --config <path> --session <id> --request <id>` 取消原运行
- `v-cli art conversation resume --config <path> --session <id> --request <id>` 仅恢复原上游身份，不重新提交
- `v-cli art conversation close --config <path> --session <id> --request <id>` 宿主退出时停止本请求的worker，保留外部共享服务
- `v-cli art style migration-complete` 校验当前迁移草稿并完成配置迁移；input 为 {note}，不分析、不生成或定版
- `v-cli art job migration-complete` 校验当前迁移草稿并完成配置迁移；input 为 {note}，不分析、不生成或定版
- `v-cli art image help` 显示命令入口与 v-cli 发现方式
- `v-cli art image config path` 显示本地配置文件路径
- `v-cli art image config show` 显示生效的本地配置和外部资源路径
- `v-cli art image config init` 配置不存在时创建本地模板；已存在时读取，不覆盖
- `v-cli art image refs guide [--project <id>]` 解释参考分类目录的用途与推荐图片样式
- `v-cli art image agent index` 发现模块、工程、核心、任务与随包 skill
- `v-cli art image agent docs` 输出全部随包模式、配置、工程、命令、诊断与核心指南
- `v-cli art image agent export --host codex --directory <DIR> [--dry]` 显式导出技能到指定宿主目录；默认安装不导出
- `v-cli art image list` 列出外部工作目录中的工程
- `v-cli art image style show [--project <id>] [--core <id>]` 读取当前工程的指定冻结核心并验证完整性
- `v-cli art image generate show [--project <id>] [--job <id>]` 读取文生图任务
- `v-cli art image generate plan [--project <id>] [--job <id>] [--core <id>] [--out <file>]` 编译文生图计划，明确来源及真实请求
- `v-cli art image generate run [--plan <file>] [--project <id>] [--job <id>] [--core <id>] [--item <id>] [--variant <id>] [--explore] [--offset <n>] [--limit <n>] [--dry]` 执行或预演文生图计划
- `v-cli art image edit show [--project <id>] [--job <id>]` 读取图编辑任务
- `v-cli art image edit plan [--project <id>] [--job <id>] [--core <id>] [--out <file>]` 编译图编辑计划，明确来源及真实请求
- `v-cli art image edit run [--plan <file>] [--project <id>] [--job <id>] [--core <id>] [--item <id>] [--variant <id>] [--explore] [--offset <n>] [--limit <n>] [--dry]` 执行或预演图编辑计划
- `v-cli art image check RUN` 核验运行计划、执行归属、产物与文件哈希；不进行人工评分
- `v-cli art image compare BEFORE AFTER` 比较两份计划或执行记录的核心、执行配置和单体变更
- `v-cli art image task list` 列出任务状态
- `v-cli art image task status TASK` 查看单次任务及后端 prompt_id
- `v-cli art image task wait TASK` 等待任务结束；超时不取消任务
- `v-cli art image task cancel TASK` 取消单次任务并等待停止
- `v-cli art image shutdown` 停止当前工作区关联任务，核验共享队列和进程身份后关闭服务
- `v-cli art image config validate` 校验配置和 API workflow 的结构、连接与参数绑定
- `v-cli art image doctor` 检测本地 ComfyUI 环境、节点与模型
- `v-cli art image workflow list` 列出默认内置工作流及 API/UI 文件位置
- `v-cli art image style create` 创建独立草稿对象
- `v-cli art image style list` 列出工程对象及任务展示状态
- `v-cli art image style read` 读取指定对象与版本
- `v-cli art image style update` 校验预期版本及空闲状态后更新对象
- `v-cli art image style derive` 派生独立草稿，保留结构化规则与独立参考；当前冻结证据标记沿用，不继承核心、执行或授权
- `v-cli art image style discard` 确认空闲后丢弃草稿并清理所属资源
- `v-cli art image job create` 创建独立草稿对象
- `v-cli art image job list` 列出工程对象及任务展示状态
- `v-cli art image job read` 读取指定对象与版本
- `v-cli art image job update` 校验预期版本及空闲状态后更新对象
- `v-cli art image job derive` 派生独立草稿，不继承执行、报告或定版
- `v-cli art image job discard` 归档已停止的任务，保留配置、参考、收藏、图片与执行历史；可恢复到活跃列表
- `v-cli art image job restore` 恢复已归档任务到活跃列表，保留原身份、配置与历史；不重新执行
- `v-cli art image style recover` 恢复已授权采用事务
- `v-cli art image project init` 新建版本 2 工程
- `v-cli art image project upgrade` 显式一次性工程升级
- `v-cli art image reference list` 查看对象参考
- `v-cli art image reference import` 导入对象私有图片
- `v-cli art image reference remove` 移除参考关联
- `v-cli art image candidate list` 查看真实候选及完整性
- `v-cli art image candidate favorites --project <id>` 网格收藏夹的数据来源，列出工程中仍可用的收藏图片及源任务身份
- `v-cli art image candidate favorite --project <id> --job <id> --run <id> --candidate <id> --value <true|false>` 设置图片收藏状态，不修改任务需求、版本、定版或运行状态
- `v-cli art image candidate finalizations` 查看资产定版
- `v-cli art image candidate finalize` 按资产定版候选
- `v-cli art image candidate delete` 删除候选及关联定版
- `v-cli art image job analyze` 分析任务动态参考，仅转写指定用途，不继承静态风格
- `v-cli art image task recover --project P --operation OPERATION` 仅从唯一原运行登记恢复身份；绝不重新执行
- `v-cli art image reference update --project P --kind style --id ID --revision N --item REF --input PATCH.json` 更新参考分类、任务用途与说明，版本校验并使分析失效
- `v-cli art art job template --project <id> --kind <generate|edit> [--core <id>]` 只读返回工具权威的任务配置模板；生成任务使用已冻结核心的题材
- `v-cli art art job from-candidate --project <id> --id <task> --run <id> --candidate <id>` 将已停止批次中的可用图片导入私有底图，创建独立编辑草稿，不要求定版通过、不运行
- `v-cli art image task resume TASK` 仅恢复原上游任务的查询和下载，绝不重新提交
- `v-cli art image environment guide` 本地环境部署指南
- `v-cli art image environment list` 本地环境目录发现
- `v-cli art image environment prepare` 自动准备兼容 Python 运行时，保留已有环境
- `v-cli art image environment inspect` 本地环境只读检测
- `v-cli art image environment verify` 本地环境确定性验收
- `v-cli art image environment register` 本地环境验收并登记
- `v-cli art image environment unregister` 本地环境解除登记
- `v-cli art image style export` 导出冻结风格及必要参考，不复制运行状态
- `v-cli art image style import` 导入固定版本的共享冻结风格，保留原身份和版本
- `v-cli art image style sources` 只读列出多个冻结风格来源并报告不可用目录和身份冲突
- `v-cli art image conversation start --config <path> --input <path>` 编译并幂等提交会话出图，不创建项目任务
- `v-cli art image conversation status --config <path> --session <id> --request <id>` 查询原运行与真实产物
- `v-cli art image conversation cancel --config <path> --session <id> --request <id>` 取消原运行
- `v-cli art image conversation resume --config <path> --session <id> --request <id>` 仅恢复原上游身份，不重新提交
- `v-cli art image conversation close --config <path> --session <id> --request <id>` 宿主退出时停止本请求的worker，保留外部共享服务
- `v-cli art image style migration-complete` 校验当前迁移草稿并完成配置迁移；input 为 {note}，不分析、不生成或定版
- `v-cli art image job migration-complete` 校验当前迁移草稿并完成配置迁移；input 为 {note}，不分析、不生成或定版
- `v-cli art video describe [--input <file>]` 读取视频业务与输入契约
- `v-cli art video snapshot [--input <file>]` 读取视频项目快照
- `v-cli art video settings get [--input <file>]` 读取视频设置及CAS版本
- `v-cli art video settings save --input <file> --operation <id>` 按expectedRevision保存视频设置
- `v-cli art video settings presets h3 [--input <file>]` 读取H3视频模型预设
- `v-cli art video runtime status [--input <file>]` 核对本地视频运行时状态
- `v-cli art video runtime start [--input <file>] --operation <id>` 显式启动本地视频运行时
- `v-cli art video runtime stop [--input <file>] --operation <id>` 核对所有权后显式停止本地视频运行时
- `v-cli art video task list [--input <file>]` 视频通道 task list；输入由video describe公布的业务契约校验
- `v-cli art video task read --input <file>` 视频通道 task read；输入由video describe公布的业务契约校验
- `v-cli art video task create --input <file> --operation <id>` 视频通道 task create；输入由video describe公布的业务契约校验
- `v-cli art video task rename --input <file> --operation <id>` 视频通道 task rename；输入由video describe公布的业务契约校验
- `v-cli art video task archive --input <file> --operation <id>` 视频通道 task archive；输入由video describe公布的业务契约校验
- `v-cli art video operation create --input <file> --operation <id>` 视频通道 operation create；输入由video describe公布的业务契约校验
- `v-cli art video operation update --input <file> --operation <id>` 视频通道 operation update；输入由video describe公布的业务契约校验
- `v-cli art video operation rename --input <file> --operation <id>` 视频通道 operation rename；输入由video describe公布的业务契约校验
- `v-cli art video operation derive --input <file> --operation <id>` 视频通道 operation derive；输入由video describe公布的业务契约校验
- `v-cli art video operation validate --input <file>` 视频通道 operation validate；输入由video describe公布的业务契约校验
- `v-cli art video operation run --input <file> --operation <id>` 视频通道 operation run；输入由video describe公布的业务契约校验
- `v-cli art video operation resume --input <file> --operation <id>` 视频通道 operation resume；输入由video describe公布的业务契约校验
- `v-cli art video operation cancel --input <file> --operation <id>` 视频通道 operation cancel；输入由video describe公布的业务契约校验
- `v-cli art video operation accept --input <file> --operation <id>` 视频通道 operation accept；输入由video describe公布的业务契约校验
- `v-cli art video operation bind --input <file> --operation <id>` 视频通道 operation bind；输入由video describe公布的业务契约校验
- `v-cli art video script read --input <file>` 视频通道 script read；输入由video describe公布的业务契约校验
- `v-cli art video script update --input <file> --operation <id>` 视频通道 script update；输入由video describe公布的业务契约校验
- `v-cli art video script plan --input <file>` 视频通道 script plan；输入由video describe公布的业务契约校验
- `v-cli art video script apply --input <file> --operation <id>` 视频通道 script apply；输入由video describe公布的业务契约校验
- `v-cli art video film compose --input <file> --operation <id>` 视频通道 film compose；输入由video describe公布的业务契约校验
- `v-cli art video film refine --input <file> --operation <id>` 视频通道 film refine；输入由video describe公布的业务契约校验
- `v-cli art video film preview --input <file> --operation <id>` 视频通道 film preview；输入由video describe公布的业务契约校验
- `v-cli art video film adopt --input <file> --operation <id>` 视频通道 film adopt；输入由video describe公布的业务契约校验
- `v-cli art video film undo --input <file> --operation <id>` 视频通道 film undo；输入由video describe公布的业务契约校验
- `v-cli art video material list [--input <file>]` 视频通道 material list；输入由video describe公布的业务契约校验
- `v-cli art video material import --input <file> --operation <id>` 视频通道 material import；输入由video describe公布的业务契约校验
- `v-cli art video material import-file --input <file> --operation <id>` 视频通道 material import-file；输入由video describe公布的业务契约校验
- `v-cli art video material upload --input <file> --operation <id>` 视频通道 material upload；输入由video describe公布的业务契约校验
- `v-cli art video material hide --input <file> --operation <id>` 视频通道 material hide；输入由video describe公布的业务契约校验
- `v-cli art video image --input <file>` 视频通道 image；输入由video describe公布的业务契约校验
- `v-cli art video media status [--input <file>]` 视频通道 media status；输入由video describe公布的业务契约校验
- `v-cli art video execution status --operation <id>` 核对原CLI/宿主视频意图及回执
- `v-cli art style confirm --project ID --id STYLE --revision N` 确认保存的风格描述、约束和绘制规则并确定性编译契约
- `v-cli art style sample-job --project ID --id STYLE --revision N` 为已确认风格创建样张任务；支持自定义主体、验证目标、尺寸和生成方案，不自动生成
- `v-cli art style sample-select --project ID --id STYLE --revision N --job VALUE --run VALUE --candidate VALUE` 样张定版：将有效候选自动加入当前风格运行时参考；按图片内容哈希去重，重复操作不新增
- `v-cli art style sample-remove --project ID --id STYLE --revision N --sample VALUE` 取消样张定版并移除当前运行时参考；保留历史计划依赖的图片文件
- `v-cli art image style confirm --project ID --id STYLE --revision N` 确认保存的风格描述、约束和绘制规则并确定性编译契约
- `v-cli art image style sample-job --project ID --id STYLE --revision N` 为已确认风格创建样张任务；支持自定义主体、验证目标、尺寸和生成方案，不自动生成
- `v-cli art image style sample-select --project ID --id STYLE --revision N --job VALUE --run VALUE --candidate VALUE` 样张定版：将有效候选自动加入当前风格运行时参考；按图片内容哈希去重，重复操作不新增
- `v-cli art image style sample-remove --project ID --id STYLE --revision N --sample VALUE` 取消样张定版并移除当前运行时参考；保留历史计划依赖的图片文件
- `v-cli art spine describe` 读取 Spine 制作契约
- `v-cli art spine parts --input <file>` 按母版坐标拆件、蒙版补绘与拼合检查
- `v-cli art spine build --input <file>` 编译并校验骨架绑定、蒙皮、动作和图集
- `v-cli art spine capture --input <file>` 使用 WebGL 捕获指定姿势的 PNG 和对照图
### @kevlns/figma-to-uprefab — 命令 `v-cli figma …`

**版本**：0.3.1
**描述**：将 Figma 标记画板导出为源数据和图片，通过 Unity 转换器生成 UGUI 预制体。
**平台**：win32（仅 Windows 主机可用；非 Windows 上 v-cli 会拒绝路由）

**何时使用**：导出 Figma 标记画板，校验源清单与图片，在 Unity 中生成暂存 UGUI 预制体；不将产物直接转入运行时目录或写入 UIConfig。

**操作指南**：`v-cli agent docs figma`（插件包内 清单声明的 SKILL.md）
**实时参数/命令**：`v-cli agent describe figma --json`

- `v-cli figma setup <project> [options]` 将工程配置写入 ~/.config/figma-to-uprefab/config.json，不修改工程。
- `v-cli figma config init [options]` 创建工程配置，默认 uiSystem 为 UGUI，不写入令牌字段。
- `v-cli figma config validate [options]` 按 schema 校验工程配置、令牌和 uiSystem；环境变量令牌优先，非 UGUI 值拒绝执行。
- `v-cli figma config migrate [options]` 将指定工程配置转换到用户配置文件，并重命名来源文件为 *.migrated；不复制令牌。
- `v-cli figma export <fileKey> [options]` 从 Figma REST 导出源清单、节点 PNG 和根索引，只写入暂存目录。
- `v-cli figma contract [options]` 只读校验暂存目录、schema 和路径约束。
- `v-cli figma doctor [options]` 只读检查配置、暂存数据、Unity 转换器、编辑器与令牌状态。
- `v-cli figma agent docs [options]` 输出或导出随包 SKILL.md，不安装技能。
- `v-cli figma unity install [options]` 将 com.kevlns.figma-to-uprefab 安装到工程；支持预演、哈希回执、改动检测、原子替换与回滚。
- `v-cli figma unity status [options]` 检查转换器是否安装、文件是否与回执一致。
- `v-cli figma unity uninstall [options]` 移除转换器；安装内容被修改时拒绝执行，除非明确指定 --force。
- `v-cli figma build [options]` 通过 Unity 批处理运行 C# 转换器；未安装、回执缺失或编辑器占用时拒绝执行。
### @kevlns/ship-cli — 命令 `v-cli ship …`

**版本**：0.2.0
**描述**：校验已构建的游戏产物，执行 Steam 上传、微信小游戏预览和开发版上传。
**平台**：win32, linux, darwin

**何时使用**：处理已构建游戏的 Steam 上传、微信小游戏预览与开发版上传；执行离线产物校验与环境检查。正式发布、提审和账号管理在平台后台完成，工具不构建引擎产物。

**操作指南**：`v-cli agent docs ship`（插件包内 清单声明的 SKILL.md）
**实时参数/命令**：`v-cli agent describe ship --json`

- `v-cli ship doctor [--json]` 离线检查配置、steamcmd、凭据模式、微信工程、私钥与 miniprogram-ci，不联网。
- `v-cli ship config init [--force] [--json]` 写入 ship.config.json 模板；覆盖现有文件必须指定 --force。
- `v-cli ship config validate [--json]` 校验配置结构与字段关系，包括 Depot 来源、产物与缓存目录隔离；失败返回稳定错误码及处理建议。
- `v-cli ship config show [--json]` 输出已解析路径并应用默认值的配置。
- `v-cli ship steam vdf [--desc <text>] [--set-live <branch>] [--preview] [--json]` 在 <buildOutput>/vdf 生成 App 和 Depot 的 VDF，不运行 steamcmd。
- `v-cli ship steam preview [--desc <text>] [--json]` 以 Preview=1 执行 steamcmd，生成本地日志和文件清单，不上传内容。
- `v-cli ship steam push [--desc <text>] [--set-live <branch>] [--json]` 上传 Depot 构建；可明确启用非 default 测试分支，正式分支在 Steamworks 后台操作。
- `v-cli ship steam test [--write-appid] [--json]` 离线检查 steam_appid.txt、Steam API 库、已配置可执行文件，并返回启动和构建页面地址。
- `v-cli ship steam open <target>` 在浏览器打开 Steamworks 的 builds 页面。
- `v-cli ship wx validate [--json]` 离线检查结构与过滤后的源码体积；源码估算不是实际编译包大小。
- `v-cli ship wx preview [--qr-out <file>] [--desc <text>] [--robot <n>] [--json]` 通过工程内的 miniprogram-ci 生成手机预览二维码，不创建版本记录。
- `v-cli ship wx push --version <text> [--desc <text>] [--robot <n>] [--json]` Upload a new dev version via miniprogram-ci after running the same offline validation as wx validate (a failed validation prints the complete report with per-item fix suggestions and blocks the upload). Creates a dev version ONLY: selecting 体验版, submitting for review, release and gray rollout are human steps in the MP backend.
- `v-cli ship wx open <target>` 在浏览器打开微信公众平台后台。
### @kevlns/u-cli-mod — 命令 `v-cli unity …`

**版本**：0.4.0
**描述**：按 Unity Editor 精确版本定位工具链，校验和安装 com.unity.pipeline，并执行工程命令。
**平台**：win32（仅 Windows 主机可用；非 Windows 上 v-cli 会拒绝路由）

**何时使用**：用于 Windows 的 Unity 2022 工程诊断、精确版本路由、已校验工具下载、事务式安装及明确绑定工程的 Pipeline 调用。

**操作指南**：`v-cli agent docs unity`（插件包内 清单声明的 SKILL.md）
**实时参数/命令**：`v-cli agent describe unity --json`

- `v-cli unity doctor <project> [options]` 检查工程版本、路由、CLI 与 Pipeline 状态
- `v-cli unity routes [options]` 列出所有已配置的 Editor 精确路由
- `v-cli unity cli install [options]` 下载并校验固定版本的 Unity CLI（SHA-256 + Authenticode）
- `v-cli unity pipeline install <project> [options]` 按工程 Editor 版本事务式安装适配后的 com.unity.pipeline
- `v-cli unity setup <project> [options]` 依次执行 cli install 和 pipeline install。
- `v-cli unity exec <project> [options] -- <unity-cli-args...>` 调用路由 CLI 执行 Unity Pipeline 命令；--project-path 由工具统一绑定
- `v-cli unity cache clean [options]` 清理下载缓存与生成的适配包
### @kevlns/xlmerge — 命令 `v-cli xlmerge …`

**版本**：3.0.0
**描述**：处理 Git 中的 Excel 三方冲突，支持 Agent 根据项目规则裁决并写回，也支持浏览器逐项审阅。
**平台**：darwin, linux, win32

**何时使用**：在发生合并的工区 detect → prepare，读取 manifest 中 base/ours/theirs 的差异与稳定 ID，按项目约束及变更意图裁决。仅将无法判断的业务项交控制源。用 apply --no-commit 写回并验证 Git 索引，按原任务完成提交或交付。用户选择可视化审阅时使用 launch。

**操作指南**：`v-cli agent docs xlmerge`（插件包内 清单声明的 SKILL.md）
**实时参数/命令**：`v-cli agent describe xlmerge --json`

- `v-cli xlmerge --repo <repo> detect` 列出仓库中未解决的 .xlsx/.xlsm 冲突。
- `v-cli xlmerge --repo <repo> filter add <path>` 添加不区分大小写的工作簿路径后缀过滤项；匹配文件逐字节采用 Git stage 3。
- `v-cli xlmerge --repo <repo> prepare [--path <file>]` 生成按工作表组织的清单；命中整表过滤的文件跳过单元格分析。
- `v-cli xlmerge --repo <repo> resolve [--path <file>] [--no-browser]` 准备冲突并以前台阻塞模式启动本地审阅界面。
- `v-cli xlmerge --repo <repo> launch [--path <file>] [--no-browser]` 准备冲突，在后台启动审阅界面并返回地址。
- `v-cli xlmerge --repo <repo> apply --manifest <manifest.json> --decisions <decisions.json> [--no-commit] [--push] [--message <text>]` 按决策 JSON 写回，不启动界面。
- `v-cli xlmerge status --manifest <file>` 查询原审阅服务。
- `v-cli xlmerge cancel --manifest <file>` 请求停止原审阅服务并等待回执。
---

所有清单字段的解释见 `schemas/v-cli-plugin.schema.json` 与 `v-cli agent describe` 输出。

## 结果验证

执行状态、任务生命周期和业务验收分别判断；未知结果不能视为成功。

## 参考资料

工具包 README.md 与 docs/documentation.md；命令参数以实时 --help 为准。

## 许可与版权

LGPLv3（含 Vant 应用开发例外）。Copyright © 2026 Vant <sl_kevln@163.com>。
