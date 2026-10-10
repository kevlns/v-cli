# 阶段 A：身份能力矩阵与缺口清单

> 状态：已完成（2026-10-10），经两轮独立审查收敛（记录见 survey §10；job 协议勘验系第一轮审查发现补入）。
> 结论先行：**Pipeline 命令层不支持任务身份**——启动无 runId、状态查询与取消均为
> "最近一次/当前"语义、连续任务相互顶替、编译槽位被引擎级事件覆写、状态跨会话残留。
> HTTP 层另有一套**内存态 job 协议**（jobId 提交/按 id 查询/定向取消），但不跨 domain reload
> 且经 unity CLI 不可达（见 §2b）——命令层与 HTTP 层任何单一机制都不足以支撑跨 reload 的任务关联。
> v-cli 侧在阶段 D 后端补齐前不得提供句柄关联查询/取消，现有状态能力必须标注观察语义。
> 每条结论标注来源（C# 源文件:行号 属 P.Cell 内 com.unity.pipeline 0.5.0-exp.1 patch 2，或 2026-10-10 实测）。

## 1. 逐操作身份矩阵（Unity / com.unity.pipeline，命令层）

| 操作 | 启动返回身份 | 状态查询身份 | 取消目标身份 | 可关联性判定 | 证据 |
| --- | --- | --- | --- | --- | --- |
| `recompile`（触发） | 无。响应只返回 `{status:"compiling"}` 或 `{status:"up_to_date"}`（`"triggered"` 仅写入状态文件，不在响应中），无 runId | — | —（无取消命令） | **不可关联**。触发响应与后续编译事件之间无纽带 | RecompileCommand.cs L46-70（L56 写文件、L64/L69 返回值） |
| `recompile_status` | — | 无参数；读单槽位文件 `Temp/pipeline_recompile_status.json` | — | **不可关联**。且为引擎级观察：任何编译（资产导入/包变更）经 CompilationPipeline 事件覆写同槽位；"我触发的编译"与"引擎自己发生的编译"无法区分 | RecompileCommand.cs L72-98（三事件钩子 L80-98） |
| `run_tests --async_tests` | 无。返回 `{Result:"running", StatusPath:"Temp/pipeline_test_status.json", ExecutedAt, ...}`；StatusPath 是固定路径不是身份；ExecutedAt 是弱时间戳证据（**不作为 id**） | — | — | **不可关联**。仅知"有测试按此参数启动过" | PipelineTestRunner.cs L249-297 |
| `test_status` | — | 无参数；状态文件存在→原文；仅请求文件存在→`running`；均无→`no_tests` | — | **不可关联**。读到的 completed 报告无法证明属于哪次启动；跨 Editor 会话残留旧报告 | TestCommands.cs L99-104 + PipelineTestRunner.cs L765-772；2026-10-10 实测读到前次会话报告 |
| `cancel_tests` | — | — | **无参数**：取消"当前"运行（活动收集器+请求文件），覆写状态文件为 cancelled，删请求文件 | **不可定向**。无法表达"取消指定任务"；另一句柄的运行可能被误伤 | PipelineTestRunner.cs L777-805 |
| 连续两次 `run_tests` | 第二次启动先 `InvalidatePreviousRun()`：取消旧运行、注销收集器；async 启动前删旧状态文件 | — | — | **顶替语义**：旧任务既被取消又丢失报告；旧句柄若继续轮询会读到新任务的报告（串报告） | PipelineTestRunner.cs L53-55, L269-271, L626-634 |
| `editor_status` | —（只读） | — | — | 工程身份**可**校验：信封 `data.target.projectPath` 回显 | 2026-10-10 实测（协议样本 §2.1） |
| `doctor` | —（只读） | — | — | 不涉及任务身份 | 2026-10-10 实测 |

## 2. 可用身份与不可用身份汇总（命令层）

| 身份维度 | 现状 | 说明 |
| --- | --- | --- |
| 目标工程身份 | ✅ 可校验 | `data.target.projectPath` 回显 + v-cli 绑定 realpath 双核对（GAP-U2：v-cli 尚未核对，阶段 C 补） |
| 底层任务身份 | ❌ 命令层不存在 | 无任何 Pipeline 命令产生/接受 runId（全矩阵；全包 grep `runId` 零命中）。HTTP 层 job 协议见 §2b，受限不可达 |
| 启动关联 | ❌ 只能"弱关联" | 触发响应的 ExecutedAt/argv 是证据，**禁止**包装成 backendRunId（计划 §4 红线） |
| 取消定向 | ❌ 无 | cancel_tests 全局取消当前（HTTP 层 job 协议有定向取消但不可达，§2b） |
| 状态终态归属 | ❌ 无 | completed 报告无归属字段 |

## 2b. HTTP 层 job 协议

Pipeline HTTP 服务在 `/api/exec` 之上另有一套按任务身份的 job 机制：

| 能力 | 事实 | 证据 |
| --- | --- | --- |
| 提交 | `POST /api/exec` 携带 `job:true` → 立即返回 `{jobId, state:"queued"}`；队列满 429 | BasePipelineServer.cs L1479-1494 |
| 按身份查询 | `GET /api/job?id=` → 状态/进度/保留结果；不存在 → 404"jobs do not survive domain reloads and are pruned after retention" | L1257-1280 |
| 定向取消 | `POST /api/job/cancel` 按 id：排队任务直接取消、运行中协作式取消 | L503-513（路由）+ L1148-1206（RunJobDetached：MarkRunning/MarkCompleted/MarkCanceled/MarkFailed） |
| 权威文档 | connectivity.md L202-215、CHANGELOG.md L11（均在包内） | Documentation~ |
| **硬限制** | **内存态**：不跨 domain reload；保留 1 小时/最近 100 个。编译/测试终态恰需跨 reload → 单独不可用 | 404 文案原文 |
| **可达性** | 路由 unity.exe CLI `command` 子命令仅 `--project-path/--runtime/--runtime-path/--timeout`，无 job 选项；u-cli-mod exec 亦无 → **当前 v-cli/u-cli-mod 路径不可达** | 2026-10-10 实测 `unity command --help` |

对阶段 D 的意义：job 协议提供了"启动可验证身份 + 定向取消"的现成实现；若 u-cli-mod 新增 HTTP 直连（工程 `InstanceDescriptor` 含端口）即可触达。与命令层 runId（跨 reload 终态归属）互补，组合方案见 survey §6。

## 3. 后端协议补齐需求（阶段 D 输入；涉及 u-cli-mod / com.unity.pipeline 的独立提交）

按计划 §7"后端身份要求"逐条对齐：

1. **runId 产生**：执行端（Editor 内）在启动 run_tests / recompile 时生成（GUID 即可），写入请求文件与状态文件。
2. **跨 domain reload 存活**：身份随状态文件持久化（现有模式即文件持久化，runId 放同一文件即天然存活）；重挂收集器不得换 id。
3. **终态报告含 runId**：completed/error/cancelled payload 携带 runId。
4. **按身份查询**：`test_status`/`recompile_status` 接受可选 runId：命中→该任务报告；不存在→明确 `unknown_run`（**不是**回退最近一次）；无参调用保持现状（向后兼容=最近一次，语义在帮助与 AGENTS.md 标注）。
5. **按身份取消**：`cancel_tests` 接受可选 runId：目标存在且运行中→取消并确认；目标不存在/已结束→明确拒绝（不误伤其他运行）。
6. **编译与测试分别设计**：编译槽位被引擎级事件覆写是固有行为——runId 方案对编译需要"触发时生成 id + compilationFinished 时把 id 写进终态"，并接受"非本命令触发的编译不携带该 id（读到无 id 的终态=引擎自发编译，明确归类）"；测试槽位由命令独占管理，不存在此问题。两套生命周期不共用假设。
7. **u-cli-mod 透传**：exec 对 `--` 之后整段参数原样转发（仅剥离自身 `--wait`），末尾统一追加 `--project-path`（exec.ts `buildExecArgs` L26-28）——后端新增 runId 类参数无需改 u-cli-mod。若采用组合方案（§2b），u-cli-mod 需新增 Pipeline HTTP 直连命令（独立提交审查）。CLI 哈希校验/路由不受影响。
8. **先评估 job 协议复用**（survey §6 路线 1）：u-cli-mod 直连 `/api/exec job:true` / `/api/job` / `/api/job/cancel` 可复用"启动身份 + 定向取消"的现成实现；跨 reload 终态归属仍需上述命令层 runId。二者组合而非互斥。

## 4. v-cli 侧边界（GAP-U1 补齐前有效）

| 能力/形态 | 边界 |
| --- | --- |
| `unity.compile` / `unity.test-start` | 保留触发（accepted 语义不变）；句柄产出但 `backendTaskId:null`、`recoverable:true`（可查证据）；结果明确"终态关联 unverified" |
| `unity.compile-status` / `unity.test-status` | 保留为**观察语义**能力：描述、输出 schema、README 明示"最近一次/引擎当前状态"；证据标注 `correlation:"unverified"`（GAP-V1 随阶段 B 修订） |
| 句柄关联查询/取消 | **不提供**（能力不存在，而非提供后报错）；`unity.test-cancel` 保留"取消当前运行"语义并如实命名 |
| P.Cell 真实验收（计划 §10 第 4 步） | 后端补齐前，"真实句柄轮询追踪同一份非零报告"不可执行——该步降级为观察语义验证 + GAP-U1 登记；不得标记异步闭环完成（计划 §7 末段） |

## 5. 缺口登记（滚动维护；阶段结束状态见计划文档）

| 编号 | 缺口 | 归属 | 阻塞 |
| --- | --- | --- | --- |
| GAP-U1 | Unity Pipeline 命令层无任务身份（§1 全部结论）；HTTP 层 job 协议受限不可达且不跨 reload（§2b） | 阶段 D（u-cli-mod/pipeline 独立提交；先评估 job 复用，§3.8） | 阻塞"句柄查询/取消"验收与 P.Cell §10.4 完整执行 |
| GAP-U2 | v-cli 未核对 `data.target.projectPath` 回显 | 阶段 C | **已闭合**（2026-10-10 阶段 C） |
| GAP-V1 | compile-status/test-status 描述已写"读取最近一次"，但缺**归属不可证明**警示（不属于哪次触发/编译槽位被引擎级事件覆写/状态跨会话残留） | 阶段 B | **已闭合**（2026-10-10 阶段 B 补警示） |
| GAP-F1 | P.Cell 无真实 Figma staging/配置/UPM 包 | 阶段 E | 真实正例降级为隔离样本；正例后补 |
