# 阶段 A：协议样本（脱敏）

> 状态：已完成（2026-10-10），经两轮独立审查收敛（记录见 survey §10）。
> 全部样本为 2026-10-10 实测或源码核对产物。无令牌、无个人凭据、无业务数据（测试全名为
> P.Cell 公开框架测试 FrameworkModuleBaseTests，属验证记录本身）。每条样本标注来源。
> 实测环境：P.Cell Client（Unity 2022.3.59f1c1，Editor 运行中）、com.unity.pipeline 0.5.0-exp.1
> patch 2（doctor state=current）、@kevlns/u-cli-mod@8f1ba28、@kevlns/figma-to-uprefab@f3e9a33。

## 1. Unity exec 信封结构（u-cli-mod exec → 路由 unity.exe → Editor 内 Pipeline HTTP 服务）

来源：2026-10-10 实测（editor_status / test_status / recompile_status / 未知命令）。

```jsonc
// 成功信封
{
  "success": true,                    // 外层信封布尔（u-cli-mod/路由 CLI 产生）
  "command": "command <name>",        // 被执行的命令行
  "data": {
    "command": "<name>",              // Pipeline 命令名
    "parameters": { ... },            // 请求参数回显（当前状态/取消命令恒为 {}）
    "result": <object | string>,      // 命令结果；可为 JSON 对象，也可为序列化 JSON 字符串（需二次解析）
    "target": {
      "host": "127.0.0.1",
      "port": 7800,                   // Editor 内 Pipeline HTTP 服务端口
      "projectPath": "C:\\...\\Client" // ★ 后端回显目标工程身份（v-cli 须与绑定核对，GAP-U2）
    },
    "success": true                   // 内层信封布尔
  },
  "errors": [],
  "warnings": []
}

// 失败信封（未知命令，400 Bad Request）
{
  "success": false,
  "command": "unity command no_such_command",   // 注意：外层 command 前缀是 "unity"
  "data": null,                                  // 失败时 data 为 null
  "errors": [ { "code": "COMMAND_FAILED", "message": "Pipeline server returned 400 ... Available: [154 个命令名]" } ],
  "warnings": []
}
```

字段来源：`u-cli-mod/src/commands/exec.ts`（stdio 透传，包装器不产自身 JSON）+ 实测。`errors[].code` 已观察到 `COMMAND_FAILED`；其余 code 值域未实测枚举（按"只认出现过的值"原则，运行期遇到新值按 unknown 处理）。

## 2. Pipeline 命令实测样本（--wait 15 --format json，全部只读）

### 2.1 editor_status

```jsonc
// data.result（对象形态）
{
  "status": "ready",                     // 就绪判据值（v-cli unity.editor-status 认定值）
  "compiling": false,
  "domainReloadInProgress": false,
  "playMode": "stopped",
  "lastHeartbeat": "2026-10-10T08:02:18.6091977Z",   // 活性证据
  "projectPath": "C:\\...\\Client",
  "unityVersion": "2022.3.59f1c1"
}
```

### 2.2 test_status —— ★ 陈旧报告实证

```jsonc
// data.result 为【序列化 JSON 字符串】（含 \r\n），需二次解析：
{
  "status": "completed",
  "duration": 0.82,
  "summary": { "total": 3, "passed": 3, "failed": 0, "skipped": 0, "inconclusive": 0 },
  "results": [
    { "FullName": "Vant.Tests.FrameworkModuleBaseTests.DisposeAsync_AlsoUnsubscribesChannel", "Status": "Passed", "Duration": 0.2153499, "Message": null, "StackTrace": null },
    { "FullName": "Vant.Tests.FrameworkModuleBaseTests.InitSubscribesStaticChannel_LateInjectionAttachesUpdate", "Status": "Passed", "Duration": 0.1087856, "Message": null, "StackTrace": null },
    { "FullName": "Vant.Tests.FrameworkModuleBaseTests.ReleaseNecessary_UnsubscribesChannel_UpdateStops", "Status": "Passed", "Duration": 0.2287005, "Message": null, "StackTrace": null }
  ]
}
```

**关键事实**：该报告来自**此前会话**的运行（第一阶段验证遗留），本次会话未启动任何测试。状态文件 `Temp/pipeline_test_status.json` 在 Editor 重启后依然存在并被视为"当前状态"——观察语义与陈旧风险的直接证据。**无 runId 字段**；`test_status` 无任何参数可传。

### 2.3 recompile_status

```jsonc
// data.result（序列化 JSON 字符串）：
{ "status": "up_to_date", "failed": false, "errors": [] }
// 值域（AGENTS.md + RecompileCommand.cs）：idle | triggered | compiling | completed | up_to_date
// 终态 payload 恒为 { status, failed: boolean, errors: string[] }
```

### 2.4 doctor（u-cli-mod 直属命令，非 exec）

```jsonc
{
  "projectPath": "C:\\...\\Client",
  "editorVersion": "2022.3.59f1c1",
  "editorRevision": "…",          // 已核对与路由一致
  "routeSupported": true,
  "routeRevision": "…",
  "cli": { "version": "1.0.0-beta.2", "path": "…\\cache\\cli\\1.0.0-beta.2\\unity.exe", "state": "valid" },
  "pipeline": {
    "version": "0.5.0-exp.1",
    "patchVersion": 2,
    "sourceReady": true,
    "present": true,
    "installed": true,
    "state": "current",
    "installedPatchVersion": 2,
    "verification": { "ok": true, "mismatches": [], "fileCount": 385, "lineEndingDifferences": [], "error": null }
  },
  "unityProcesses": [],           // ★ 空 = 探测带了 --allow-running-editor（该选项整体跳过进程查询，数组保持空）
                                   //   不带该选项时：查询成功 → ["PID <n>", ...]；查询失败 → ["<query failed: …>"]（可见、非静默）
                                   //   来源 u-cli-mod/src/commands/doctor.ts L75-84
  "supportedVersions": [ "2022.3.59f1c1", "2022.3.62f3c1" ]
}
```

## 3. 源码核对的协议事实（未实测、来源标注）

| 事实 | 来源（P.Cell 内 com.unity.pipeline 0.5.0-exp.1 patch 2） |
| --- | --- |
| `run_tests --async_tests` 响应：`{Success, Command:"run_tests", Result:"running", StatusPath:"Temp/pipeline_test_status.json", Mode, FilterApplied, Message, ExecutedAt}`，**无 runId** | `Editor/Testing/PipelineTestRunner.cs` ExecuteAsyncMode（L249-297） |
| `test_status`：状态文件存在→原文返回；请求文件存在→`{"status":"running"}`；均无→`{"status":"no_tests"}` | TestCommands.cs GetTestStatus + PipelineTestRunner.GetTestStatus（L765-772） |
| `cancel_tests`：无参数；无活动运行且无文件→`{status:"no_tests"}`；否则取消当前、**覆写状态文件为 `{status:"cancelled"}`**、删请求文件；PlayMode 时额外 ExitPlaymode | PipelineTestRunner.CancelTests（L777-805） |
| 新 `run_tests` 先 `InvalidatePreviousRun()`（取消旧运行+注销收集器），async 启动前**删除旧状态文件** | ExecuteTestsAsync（L53-55）/ ExecuteAsyncMode（L269-271） |
| 编译槽位 `Temp/pipeline_recompile_status.json` 被 CompilationPipeline 三事件（started/assemblyFinished/finished）覆写——**引擎级任何编译都会覆写** | Editor/Commands/RecompileCommand.cs（L39-98） |
| domain reload 后：测试请求文件触发收集器重挂（不重启运行）；编译状态文件在 reload 前写好存活 | PipelineTestRunner.TestReloader / RecompileCommand 注释 |
| exec 等待预算耗尽：包装器写 `Library/editor-pipeline-cli/exec-logs/<ISO时间戳>-<命令>.log`，stderr 打印让出说明 + 日志路径，exit 0、stdout 空 | u-cli-mod/src/commands/exec.ts runWithWaitBudget（L205-240）；v-cli 判定函数 detectWaitBudgetHandoff 已对齐 |
| PlayMode 同步运行被 fail-fast 拒绝（domain reload 掉请求）；"all" 模式不支持 async | PipelineTestRunner（L65-77, L97-100） |
| HTTP 层 job 协议：`POST /api/exec` 携带 `job:true` → `{jobId, state:"queued"}`（队列满 429）；`GET /api/job?id=` 按身份查（404 文案"jobs do not survive domain reloads and are pruned after retention"）；`POST /api/job/cancel` 按 id 定向取消。**内存态**：不跨 domain reload，保留 1 小时/最近 100 个 | Runtime/Common/BasePipelineServer.cs（路由 L503-513、提交 L1479-1494、查询 L1257-1280、执行 L1148-1206）+ PipelineJobs.cs + Documentation~/connectivity.md L202-215 |
| 路由 unity.exe CLI `command` 子命令选项仅 `--project-path/--runtime/--runtime-path/--timeout`，**无 job 提交选项** → job 协议经当前 CLI 不可达 | 2026-10-10 实测 `unity command --help` 与 `unity pipeline --help`（后者仅 install/upgrade/list/list-versions） |

## 4. Figma contract 样本（2026-10-10 隔离验证，托管配置路线）

环境：临时工程（staging=fixture `figma-to-uprefab/tests/fixtures/contract/`，Panel 含 source+ir 完整正例）；
`FIGMA_TO_UPREFAB_CONFIG` 指向 v-cli 生成的临时配置（仅 `uiSystem:"UGUI"` + `staging.root`，无令牌字段）。

```text
# 正例（exit 0）
$ figma-to-uprefab contract --project <临时工程>
[figma-to-uprefab] Contract valid: 1 root(s).

# 反例：index 非法 JSON（exit 1）
[figma-to-uprefab] contract: CON_INDEX_JSON @ Assets/Temp/_Staging/figma-roots.index.json: SyntaxError: …

# 反例：index 越界（exit 1）
[figma-to-uprefab] contract: CON_PATH_TRAVERSAL @ ../Other/evil.index.json: Error: PAT_TRAVERSAL: '..' segment rejected: …

# 无用户配置（exit 1，fail-closed）
[figma-to-uprefab] CFG_USER_FILE_MISSING: User config file was not found: …/config.json. Run 'figma-to-uprefab config init --project <path>' …

# 工程段缺失（exit 1）
[figma-to-uprefab] CFG_PROJECT_CONFIG_MISSING: projects['<规范化工程键>'] section missing in …
```

结构化返回（`src/commands/contract.ts`，供 provider 消费；CLI 文本为其渲染）：

```ts
{ valid: boolean; rootsChecked: number; issues: Array<{ code: string; message: string; path?: string }> }
```

已核对 CON_*/CFG_* 码表来源：`src/contract/contract.ts`（全部 CON_ 不变式）+ `src/core/config.ts`（CFG_*）+ AGENTS.md §4 码族总表。路径读取范围：工程根内（assertInsideBase）、index 须在 `_Staging/` 下、资产须在 staging `Assets/` 内且 exportMode=node。

## 5. 样本使用规则

- 运行期协议解释沿用 `src/providers/unity/protocol.ts` 原则：**只认本文档与包内权威文档出现过的字段名/取值**；缺失与未知值一律不通过并把实读值写进证据，不编造字段。
- 本文档随协议演进同步更新；后端协议变更（阶段 D）须附新样本与本文件的 diff。
