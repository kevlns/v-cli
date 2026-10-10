# 阶段 A：契约设计与后端勘验（勘验报告与契约设计说明）

> 状态：已完成（2026-10-10），经两轮独立审查收敛（记录见 §10）。
> 本文是《VCLI开发与验收计划》阶段 A 的交付物之一。
> 配套交付物：`phase-a-protocol-samples.md`（协议样本）、`phase-a-identity-matrix.md`（身份能力矩阵与缺口清单）。
> 本文所有结论均标注来源：仓库文件路径（含提交）、或 2026-10-10 真实探测（只读命令）。

## 1. 勘验范围与方法

| 对象 | 版本/提交 | 方法 |
| --- | --- | --- |
| v-cli | `1b1f78d`（refactor/main，无已跟踪文件改动；本三份交付物为未跟踪新文件） | 通读 src 全部核心模块 |
| @kevlns/u-cli-mod | `8f1ba28`（main，工作区干净） | 通读 exec/doctor/路由/清单 + AGENTS.md |
| com.unity.pipeline（适配版） | 0.5.0-exp.1 patch 2（P.Cell 已安装，doctor state=current） | 通读 Editor 侧 C#（测试/编译命令 + Runtime/Common 的 BasePipelineServer/PipelineJobs job 协议）+ Documentation~/connectivity.md |
| @kevlns/figma-to-uprefab | `f3e9a33`（main，工作区干净） | 通读 contract/config/cli + AGENTS.md + 隔离实证 |
| P.Cell | `8bd27afb`（master，工作区干净） | 只读探测（doctor / editor_status / test_status / recompile_status / 未知命令信封 / CLI help 可达性） |

P.Cell 探测时 Editor 在运行（Client 工程，2022.3.59f1c1）。全部探测为只读命令；**未执行** cancel_tests（它会改写 `Temp/pipeline_test_status.json`、破坏既有测试报告）、未触发编译/测试、未做任何写操作。

## 2. v-cli 现状盘点（与通用化目标的差距清单）

第一阶段实现（详见 `registration-execution.md`）：注册表（注册即校验）、执行内核（输入/输出/副作用/验收全链路）、受控进程执行器、工程配置与路径安全、操作记录与脱敏、Unity provider 七能力、SDK 出口。

**Unity 专属逻辑的硬编码位置**（阶段 B 要移除/通用化的全部点，逐文件核对）：

| 位置 | 硬编码内容 |
| --- | --- |
| `src/core/project/config.ts` | `ProjectCliConfig.bindings.unity`（类型）、`validateProjectCliConfig` 内联 Unity 字段校验与"当前仅支持 unity"分支、`loadProjectConfig` 内联 `bindings.unity.projectDir` 路径解析、`renderDefaultConfig`/`initProjectConfig` 的 Unity 专属参数与警告 |
| `src/core/execution/runtime.ts` | 无 Unity 专属分支（已是通用内核）✅；但 `CapabilityExecutionContext.bindingDirs` 的键（`unity`）由 provider 约定，核心未定义键语义 |
| `src/core/execution/default-registry.ts` | 直接 import 并装配 `createUnityProvider`，无法注入第三方 provider 集合；且位于 `src/core/**` 内却 import `src/providers/**`，违反方向约束（阶段 B 迁出，见 §3.2） |
| `src/core/official.ts` | `OFFICIAL_PLUGINS` 白名单内含 unity/figma 等条目的命令与描述元数据——core 层的 provider 专属数据（通用化时改为纯注册表驱动或下沉到装配层，阶段 B 处理） |
| `src/providers/unity/index.ts` | `findUnityDir` 读 `ctx.bindingDirs.unity`、`pipelineReadyCheck` 读 `ctx.config.bindings.unity?.editorVersion`、`testStartExecute` 读 `?.testMode`（index.ts:564, 1019）——provider 内读原始 config 对象（通用化后应只消费 provider 自己的已校验绑定结果） |
| `src/sdk.ts` / `src/commands/project.ts` | 导出面与 CLI 参数含 Unity 专属类型/选项（`--unity-project` 等） |

结论：内核（registry/runtime/executor/operation-store/paths）无 Unity 分支；**通用化的工作集中在配置层与装配层**，与计划预期一致。

## 3. Provider 通用契约设计（阶段 B 实施依据）

### 3.1 接口（在现有 `CapabilityProvider` 上扩展）

```ts
interface CapabilityProvider {
  id: string;                       // ^[a-z][a-z0-9-]*$（不变）
  version: string;
  description: string;
  status(): ProviderStatus | Promise<ProviderStatus>;   // 不变：只做包发现，禁止执行被包装工具
  capabilities(): CapabilityRegistration[];             // 不变：注册即校验

  // ---- 新增：绑定契约（Provider 自包含） ----
  binding: ProviderBindingContract;
}

interface ProviderBindingContract {
  /** bindings.<providerId> 段的 schema（顶层 object；additionalProperties:false 由核心强制） */
  schema: JsonSchema;
  /** 声明哪些字段是"相对工程根的路径"：核心据此统一做越界/符号链接检查，避免把普通字符串误当路径 */
  pathFields: { field: string; kind: "dir" | "file"; required: boolean }[];
  /**
   * 语义校验与解析（Provider 自己的字段自己校验）。
   * 路径解析必须走核心提供的 resolveInsideProject，Provider 不得自行 realpath/拼接。
   */
  resolve(input: {
    project: ProjectRoot;
    raw: unknown;                   // bindings.<providerId> 原始对象
    resolveInsideProject: typeof resolveInsideProject;
  }): ProviderBindingResolution;
}

type ProviderBindingResolution =
  | { ok: true; dirs: Record<string, string>; files: Record<string, string>; warnings: string[] }
  | { ok: false; errors: string[] };   // 错误信息须含字段路径与修复指引
```

设计依据（对应计划 §5 逐条）：

- **核心只定义配置外壳**：`{ schemaVersion: 1, bindings: Record<string, unknown> }`。核心只校验：schemaVersion、bindings 是对象、每个键是**已注册 provider id**（未知 provider 的绑定段 → 配置无效）。字段级校验全部委托 `binding.resolve`。
- **路径统一入口**：`pathFields` 声明 + 核心统一 `resolveInsideProject`。Provider 的 `resolve` 只做语义校验（如 Unity 的 projectDir 是否含 ProjectSettings/ProjectVersion.txt 属于前置条件而非绑定校验——见 3.3）。绑定解析与配置验证同一入口，CLI 与 SDK 共用（现有 `loadProjectConfig` 已是共用入口，保持）。
- **失败语义**（计划 §5 验收条款的落地）：
  - 绑定段**缺失**的 provider：配置整体有效；该 provider 的能力在运行期由前置条件明确失败（现状即如此）。
  - 绑定段**已声明但无效**：配置整体无效（fail-closed），错误逐条列出（含 provider id 与字段路径）。理由：计划只豁免"缺失"，声明的无效必须显式报错；且混装"部分有效"配置会让错误提示与实际注册集合不一致。
- **危险键**：现有 `VANT_OWNED_KEYS` 检查保留在核心外壳层；`__proto__`/`constructor`/`prototype` 键在 JSON.parse 后于核心外壳层直接拒绝（原型污染回归测试覆盖）。
- **pathFields 与 resolution 的强核对**（安全规则，形式定稿）：核心**不信任** `resolve()` 返回的路径字符串——对每个已声明 pathField，核心自行从 `raw[field]` 调用 `resolveInsideProject` 重解析，并与 `resolution.dirs/files[field]` 做字符串比对（比对基准取返回值的 `.path`；`realPath=null` 即目标尚不存在时允许通过，把存在性留给前置条件）。规则细节：
  - `required: true` 的 pathField：`raw` 中缺失、或重解析结果与 resolution 不一致 → 绑定无效；
  - 非 required 的 pathField：`raw` 中缺失为合法（键不出现在 dirs/files）；**出现**则同样强制重解析比对；
  - `dirs`/`files` 中出现任何**未声明**的键 → 绑定无效（不允许 Provider 借 resolution 夹带未声明路径）；
  - `kind`（dir/file）校验属 I/O 探测（lstat），归**前置条件**（与 ProjectVersion.txt 检查同类），绑定期只做语法与路径安全校验——与 §3.3 的边界一致。

### 3.2 默认组合与 SDK 装配

- `createDefaultRegistry(options)`：`providers?: CapabilityProvider[]`——调用方可提供完整集合；缺省显式装配内置 provider（unity、阶段 E 后含 figma）。核心不隐式扫描。
- 方向约束（消除现行矛盾）：`src/core/**` **不得** import `src/providers/**`。现状 `default-registry.ts` 位于 `src/core/execution/` 且 import unity provider，违反该约束——阶段 B 将其迁出至 `src/default-registry.ts`（SDK 出口与 dist 产物名不变），使方向约束成为绝对规则、测试直接覆盖。

### 3.3 绑定校验 vs 前置条件的边界

- 绑定校验（静态、不执行工具）：字段类型/值域、路径在工程内、必需字段存在。
- 前置条件（运行期、可能执行只读探测）：目录是否真的是 Unity 工程（ProjectVersion.txt）、后端包是否安装、Editor 是否就绪。
- 依据：现状 `unity.project-version-file` 已是前置条件；保持该归属，绑定校验不做 I/O 探测（除路径安全检查的 realpath）。

### 3.4 project init / inspect 通用化（计划 §5 显式任务项）

**init（生成与注册集合一致）**：

- 核心外壳只渲染 `schemaVersion` + `bindings`；每个绑定段由对应 Provider 提供可选的 `defaultBinding(project: ProjectRoot): { section: unknown; warnings: string[] }`——仅对**已注册且实现了该方法**的 Provider 生成默认段；未实现者不生成空段（用户按该 Provider 的 binding.schema 手写），inspect 与 describe 的提示指路。
- 已存在配置文件一律拒绝（不提供 `--force`，沿用现行保证）；不触碰 `.vant/config/project.json`。
- Unity 专属 CLI 选项（`--unity-project`/`--editor-version`/`--test-mode`）在阶段 B 替换为通用 `--binding <providerId>=<JSON>`（可多次，覆盖该 Provider 的 defaultBinding 结果）；旧选项**移除**（不保留双轨别名），错误提示给出新形式。计划 §5"不保留两套并行格式"同时约束 CLI 参数面。
- 默认值的工程适配警告（如 projectDir 不存在）由 Provider 的 defaultBinding.warnings 供给，核心原样透出。

**inspect（检查与注册集合一致）**：

- 对配置内每个绑定段：该 Provider 已注册 → 走 `binding.resolve` 报有效/无效（逐字段错误）；未注册 → 明确报"未知 Provider 绑定"（与运行期拒绝一致）。
- 注册集合中无绑定段的 Provider 单列"缺失绑定"状态（不阻断其他 Provider 的有效性报告；运行期才 fail）。
- 输出的 bindings/bindingDirs/错误提示结构与运行期 `loadProjectConfig` 同源（同一入口，不另实现一套）。

### 3.5 Provider 依赖声明（计划 §4 契约项归属）

Provider 对被包装工具的依赖声明挂在 Provider 上（不新增独立机制）：`status().tool`（名称/版本/路径）+ Provider 描述内的后端包标识（如 `@kevlns/u-cli-mod`，发现方式：官方插件白名单）。capability 级依赖继续用现有 `resources`/`preconditions` 表达。阶段 B 不为依赖图建新契约面。

## 4. 身份模型：四个 ID 的定义与关系

计划 §4 要求明确"执行调用 ID、原始启动操作 ID、底层任务 ID、目标工程身份"之间的关系。定义如下（阶段 C 实施依据）：

| 身份 | 名称 | 产生方 | 生命周期 | 存储 |
| --- | --- | --- | --- | --- |
| 执行调用 ID | `operationId` | v-cli 内核（每次 capability 调用，含查询/取消） | 单次调用 | `.vant/state/operations/<id>/`（已实现） |
| 原始启动操作 ID | `originOperationId` | v-cli（异步触发调用） | 句柄生命周期 | 句柄 + 启动 operation 的 result.json |
| 底层任务 ID | `backendTaskId` | **后端执行侧**（Editor/Pipeline 内产生） | 到后端终态 | 后端状态存储；v-cli 侧只引用（见身份矩阵） |
| 目标工程身份 | `projectIdentity` | v-cli 解析 + 后端回显核对 | 句柄生命周期 | 句柄 + 每次 exec 响应的 `data.target.projectPath` |

关系与规则：

1. 一次异步触发生成 `operationId`（本次调用）；其结果中产出**可序列化句柄**（`ExecutionHandle`）。
2. 查询/取消是**新的 operationId**（独立证据目录，计划 §6"不得复用启动目录"），句柄携带 `originOperationId` 建立关联。
3. `backendTaskId` 由后端产生并在响应中**显式报告**；v-cli 只透传与核对，**禁止生成或推测**（计划 §4 验收门槛）。当前 Unity 后端无此协议 → 句柄中 `backendTaskId: null`，关联查询/取消能力在 Unity 侧不提供（见身份矩阵）。
4. `projectIdentity` 双重校验：(a) v-cli 侧绑定解析的 realpath；(b) 后端响应回显核对——Unity 信封的 `data.target.projectPath`（2026-10-10 实测存在，见协议样本 §2.1）。**改进点**：现有 unity provider 未核对回显；阶段 D/C 实施时统一加核对（回显与绑定不一致 → protocol 错误，不采信该响应）。
5. 句柄不是信任凭据：查询/取消时按 `originOperationId` 读回落盘 result.json，核对句柄内 provider/capability/project/backendTaskId 与落盘证据一致；不一致 → 拒绝。落盘证据是**一致性真源**而非密码学签名（同机威胁模型，如实声明）。跨 CLI 进程恢复 = 按句柄读回落盘证据；`--no-persist` 模式启动的操作 → 句柄标记 `recoverable: false`，恢复时明确报错。

`ExecutionHandle` 契约草案（字段级定稿在阶段 C）：

```ts
{
  schemaVersion: 1,
  providerId: string,
  capabilityId: string,            // 触发能力（如 unity.test-start）
  originOperationId: string,
  backendTaskId: string | null,    // null = 后端无身份协议（现状 Unity）
  project: { root: string; configFile: string },   // 绝对 realpath
  startedAt: string,               // ISO
  recoverable: boolean,            // persist=false 启动时为 false
  recordDir: string,               // ".vant/state/operations/<originOperationId>"（工程内相对）
  integrity: { algo: "sha256"; digest: string }    // 句柄自摘要：仅防手滑改动/截断，不防恶意篡改（同机同用户威胁模型下无密钥即无防篡改能力）；定位为完整性提示字段，见 §9.5
}
```

## 5. 状态归一（阶段 C）

计划 §6：状态覆盖 `accepted、running、completed、failed、cancelled、unknown`；业务验收 `passed、failed、not-run` 独立。

三轴分工定稿（任务级六状态以 lifecycle 轴承载；现行 lifecycle 值域 `completed|accepted|running|unknown` 缺 `failed`/`cancelled`，属阶段 C 实施变更——同步 `runtime.ts LIFECYCLES`、结果 schema 描述与既有行为基线）：

- `execution.status`（**调用级**，值域不变：succeeded | failed | cancelled | unknown）——本次 CLI/SDK 调用本身的结果。
- `execution.lifecycle`（**任务级**，值域扩展为六态：accepted | running | completed | failed | cancelled | unknown）——底层引擎工作的生命周期。计划 §6 的六个状态即此轴；"后端明确确认任务取消 → cancelled" 由此轴一等表达（不再由 acceptance 理由间接表达）。
- `acceptance.status`（**业务验收级**，值域不变：passed | failed | not-run）。

任务级映射（后端观察 → 三轴；"现状差异"列对照当前 unity provider 行为，阶段 C 按此迁移）：

| 后端观察 | execution.status（调用级） | lifecycle（任务级，目标） | acceptance | 与现状的差异（阶段 C 迁移基线） |
| --- | --- | --- | --- | --- |
| 触发被接受（信封 success=true；run_tests async → Result="running"） | succeeded | accepted | not-run, pending | 一致（触发类现行显式 lifecycle=accepted） |
| 状态查询=运行中（triggered/compiling/running/baking 等） | succeeded | running | not-run, pending | **delta**：现状 lifecycle=completed（状态类能力全部返回 `executionFromProcess` 结果，exit 0 恒为 completed；provider 全文件无 `lifecycle:"running"` 赋值），需迁移 |
| 状态查询=终态成功（completed/up_to_date 且证据齐） | succeeded | completed | passed（须证据链） | 一致 |
| 状态查询=终态失败（failed/error/编译错误） | succeeded | **failed** | failed | **delta**：现状 lifecycle=completed（成败同值）；扩展后任务终态一等可辨 |
| **后端确认任务取消**（取消确认字段 / 状态=cancelled） | succeeded | **cancelled** | failed（被取消的运行无通过结论），取消依据入 evidence | **delta**：现状 lifecycle=completed、acceptance=failed（test-status cancelled 分支），无任务级承载位；计划 §6 验收矩阵第 6 行由此行满足 |
| 超时/进程退出/连接断（domain reload 期间） | unknown | unknown | not-run, pending（不推断底层停止） | **delta（部分）**：超时/未确认取消现行即 unknown/unknown（runtime.ts executionFromProcess），但 pending=false 且无 followUp；非零退出现行为 failed/completed 而非 unknown——pending=true 与 followUp 属阶段 C 新增 |
| 信封缺失/整体不可解析（stdout 非 JSON） | unknown | unknown | not-run, pending（应重查） | **delta（部分）**：三轴现状即 unknown/unknown/not-run（unparseable 路径），但 pending=false、无 followUp——pending 属阶段 C 新增 |
| 信封 OK 但 result 载荷不可解析 | succeeded | unknown | not-run | **delta**：现状**不是** unknown——`interpretToolOutput` 对不可二次解析的 result 字符串保留原文且 parseError=null，走 `extractStatus`→status=null 的 default 分支，与"值域外"行合并为 succeeded/completed/failed；目标拆开：调用成功（succeeded）但任务状态不可解释（unknown） |
| 状态值在已知值域外/关键字段缺失 | succeeded | unknown | failed（不通过，实读值写进证据） | **delta**：现状 acceptance=failed 一致，但 lifecycle=completed；目标改 unknown 以区分"调用成败"与"任务状态可否解释" |
| 裁决（阶段 C 一审补充）：测试 completed 但有用例失败/计数无效/缺报告 | succeeded | **completed**（运行本身正常结束） | failed | 与终态失败区分：编译错误的运行生命周期未正常走完（failed），测试运行正常完成但业务验收失败（completed+failed）——各 Provider 按此裁决，不各自解释 |

- 取消的两个表示（计划 §6）分轴记录、互不覆写：**调用级**——运行时信号取消（`signal` → `killConfirmed` → `execution.status=cancelled`，现行逻辑）；**任务级**——后端任务取消（取消响应确认或按身份查询到 cancelled → `lifecycle=cancelled`）。
- 语义澄清（避免与调用级验收混淆）：`unity.test-cancel` 的 `acceptance=passed` 表示"取消请求已确认生效"（该调用的验收目标就是取消本身）；被取消的**测试运行**业务结论仍是 failed/not-run。两类能力的描述须各自写明。
- `unknown` 是一等状态：连接断（domain reload 期间）、协议不可解释、超时均落入，绝不升级为 completed/cancelled；"假取消"（未确认）只可能是 unknown，永远到不了 cancelled。

## 6. Unity 适配结论（阶段 D 依据）

**勘验结论（审查修正 P1-1，详见身份矩阵）：Pipeline 命令层不支持任务身份；HTTP 层存在内存态 job 协议但经当前 CLI 不可达、且不跨 domain reload。**

命令层（`command <name>` 路径）：

- `run_tests`（async）响应无 runId；`test_status`/`recompile_status` 无参数，读单槽位文件（`Temp/pipeline_test_status.json`、`Temp/pipeline_recompile_status.json`）；`cancel_tests` 无目标参数，取消"当前"运行。
- 新 `run_tests` 会 `InvalidatePreviousRun()`：取消旧运行并删除旧状态文件（`PipelineTestRunner.cs:53-55, 626-634`）→ 连续任务必然顶替。
- `recompile_status` 是**引擎级**"最近一次编译"观察：任何编译（资产导入、包变更等）都经 CompilationPipeline 事件覆写同一槽位（`RecompileCommand.cs:80-98`）→ 即使时间戳关联也不可靠。
- 状态文件跨 Editor 会话残留：2026-10-10 实测 `test_status` 返回的是**此前会话**的 FrameworkModuleBaseTests 报告（见协议样本 §2.2）。

HTTP 层：

- Pipeline HTTP 服务已有按任务身份的 job 机制：`POST /api/exec` 携带 `job:true` → 立即返回 `{jobId, state:"queued"}`；`GET /api/job?id=` 按身份读取状态/进度/结果；`POST /api/job/cancel` 按 id 定向取消（排队直接取消、运行中协作式取消）。证据：`Runtime/Common/BasePipelineServer.cs`（路由 L503-513、提交 L1479-1494、查询 L1257-1280）与包内 `Documentation~/connectivity.md` L202-215。
- 硬限制：job 注册表为**内存态**——"jobs do not survive domain reloads and are pruned after retention"（404 文案原文，保留 1 小时/最近 100 个）。编译/测试的终态恰需跨 domain reload，job 协议单独不可用。
- **可达性（2026-10-10 实测）**：路由 unity.exe CLI 的 `command` 子命令仅暴露 `--project-path/--runtime/--runtime-path/--timeout`，**无 job 提交选项**；u-cli-mod exec 亦无 → 当前 v-cli/u-cli-mod 调用路径触达不了 job 协议。

阶段 D 的后端补齐须**先评估 job 协议复用**，候选路线：

1. **组合方案（倾向）**：u-cli-mod 直连 Pipeline HTTP（工程 `InstanceDescriptor` 已含端口）实现 job 提交/查询/取消透传，解决"启动可验证身份 + 定向取消"；跨 reload 的终态归属仍需命令层 runId 写入状态文件（job 协议与 runId 互补：job 管运行中身份，runId 管终态归属）。
2. **纯命令层 runId**（matrix §3 现有方案）：不动 HTTP 层，runId 全程走请求/状态文件。
3. 纯 job 协议：不可行（跨 reload 硬限制）。

**v-cli 侧边界（阶段 D 后端补齐前）**：

1. 现有 `unity.compile-status`/`unity.test-status` 保留，但描述与输出契约**明确标注观察语义**："最近一次/引擎当前状态，不证明属于哪次触发"。
2. **不提供**基于句柄的查询/取消能力（计划 §7"关联查询/取消须明确报告不支持"）——以能力不存在的方式表达，而不是提供后报错。
3. 验收证据中，观察结果与启动操作的关联标注为 `correlation: "unverified"`；不接受"启动→轮询到 completed"作为同一任务的终态证明（P.Cell 真实验证规程第 4 步在阶段 D 后端补齐前按此降级执行，见缺口 GAP-U1）。

**后端任务标识协议要求**（u-cli-mod / com.unity.pipeline 侧变更，独立提交审查；计划 §7）：

- 执行端产生 runId（如 GUID），写入请求/状态文件；跨 domain reload 存活（文件持久化，同现有模式）；
- 终态报告携带 runId；`test_status`/`recompile_status` 支持按 runId 查询（无参调用保持向后兼容=最近一次）；`cancel_tests` 接受 runId（校验目标存在且匹配，否则明确拒绝）；
- 编译与测试生命周期不同（编译槽位被引擎级事件覆写；测试槽位由命令管理），**分别设计**，不共用假设。

## 7. Figma Provider 结论（阶段 E 依据）

以离线 staging contract 校验为主（计划 §8）。勘验实证（来源：`figma-to-uprefab@f3e9a33` + 2026-10-10 隔离验证）：

- **入口命令**：`figma contract --project <p> [--config <c>] [--index <i>] [--allow-missing-ir]`（dist/cli.mjs；manifest `v-cli.plugin.json` 与 AGENTS.md 一致）。
- **输出**：CLI 文本 `Contract valid: N root(s).`（exit 0）或逐条 `contract: <CON_*> @ <path>: <message>`（exit 1）；结构化结果 `{valid, rootsChecked, issues[]}`（`src/commands/contract.ts` 返回值）。错误码族 `CFG_*/CON_*/PAT_*`。
- **配置依赖与托管配置方案（已实证）**：工具强制要求用户级配置存在且含工程段（`~/.config/figma-to-uprefab/config.json`，`FIGMA_TO_UPREFAB_CONFIG` 可覆盖；无配置 fail-closed `CFG_USER_FILE_MISSING`）。实证：用 `FIGMA_TO_UPREFAB_CONFIG` 指向 v-cli 生成的临时配置（仅 uiSystem+staging.root，**无令牌字段**）+ 隔离 staging，contract 正例 exit 0、坏 index `CON_INDEX_JSON` exit 1、越界 index `CON_PATH_TRAVERSAL` exit 1。→ **阶段 E 采用托管配置路线**：figma provider 运行时从 v-cli 绑定渲染临时用户配置（工程内 `.vant/state/figma/user-config.json`，运行时生成、不入 Git），不触碰真实用户配置、不要求令牌。
- **路径读取范围**：全部经 `assertInsideBase`（PAT_TRAVERSAL fail-closed）；index 必须位于 `_Staging/` 下（CON_STAGING_PATH）；资产必须在 staging `Assets/` 内（CON_ASSET_SCOPE）。
- **provider 绑定字段（草案）**：`{ projectDir（必填，dir）， stagingRoot（可选，dir，缺省取默认 Assets/Arts/Game/FigmaAssets/_Staging，project init 生成段时写入默认值）， allowMissingIr（可选，boolean） }`——以插件真实接口为准，阶段 E 定稿。
- **能力集（首批）**：`figma.contract`（staging 校验）+ `figma.doctor`（只读环境诊断）。边界遵守计划 §8：不做 source→IR 转换、不推广资产、不碰 UIConfig、不调收费接口、不读/输出凭据。
- **P.Cell 真实样本现状**：默认 staging 路径不存在、全工程无 `_Staging`、无用户配置、未安装 figma UPM 包 → **真实工程正例缺口登记（GAP-F1）**，阶段 E 先用隔离样本（`figma-to-uprefab/tests/fixtures/contract/`，完整正例：Panel 含 source+ir）完成离线集成。

## 8. 缺口与阻塞项登记

| 编号 | 缺口 | 影响阶段 | 状态 |
| --- | --- | --- | --- |
| GAP-U1 | Unity Pipeline **命令层**无任务身份：无 runId、状态/取消均"最近一次"语义、新任务顶替旧任务、编译槽位被引擎级事件覆写、状态文件跨会话残留。HTTP 层有内存态 job 协议但经 CLI 不可达且不跨 domain reload（§6） | D（阻塞异步闭环验收） | 已实锤；阶段 D 先评估 job 协议复用（§6 候选路线），u-cli-mod/pipeline 侧变更独立提交 |
| GAP-U2 | v-cli unity provider 未核对信封回显 `data.target.projectPath` 与绑定工程的一致性 | C（小改进） | **已闭合**（2026-10-10 阶段 C：invoke() 回显核对，不一致即 unity-target-mismatch 不采信） |
| GAP-F1 | P.Cell 无真实 Figma staging 样本与配置；真实正例未完成 | E（验收降级为隔离样本） | 登记；真实正例后补 |
| GAP-V1 | `unity.compile-status` 与 `unity.test-status` 描述虽写明"读取最近一次"，但未警示**归属不可证明**（不证明属于哪次触发、编译槽位会被引擎级事件覆写、状态跨会话残留） | B（描述/文档修订） | **已闭合**（2026-10-10 阶段 B：两能力描述补观察语义警示） |

## 9. 决策记录与待定点（开工前确认）

**已决策（审查中定稿，实施按此执行）**：

1. 已声明但无效的 provider 绑定 → 整个配置 fail-closed（§3.1）。若实施中发现体验问题，可改为"该 provider 不可用 + 全局 warning"，但需同步调整计划 §5 验收条款。
2. lifecycle 轴承载任务级六状态（§5），阶段 C 扩展值域并按差异列迁移。
3. 计划 §7"关联查询/取消须明确报告不支持"的实现形式取**能力不存在**（不注册句柄查询/取消能力），而非注册后运行期报错——避免调用方发现性误导；这是对计划措辞的显式再诠释，在此登记。
4. pathFields 强核对：核心重解析比对，resolution 不得夹带未声明键（§3.1）。
5. 句柄 `integrity` 字段定位为**完整性提示**（防手滑改动/截断），不是防篡改机制；真正的校验依据是落盘证据一致性核对（§4）。若阶段 C 审查认为价值不足可删除。
6. 验收降级守卫（阶段 C 实施定稿）：`passed` 要求调用 succeeded 且 lifecycle ∉ {accepted, unknown} 且非 pending/aborted。这是对计划 §6"尚无终态不验收通过"的显式再诠释——区分**任务验收型**能力（触发类：任务 running 时自身也只应 not-run/pending）与**调用目标型**能力（观察/关联/取消类：其验收目标是调用自身目标达成，如 cancel 的 passed=取消已确认生效、query 的 passed=关联成立；被观察任务的业务结论仍由其状态能力独立给出）。红线不放宽：accepted（启动≠通过）与 unknown（不可解释≠通过）永远不得 passed。

**待定（对应阶段开工前确认）**：

1. （阶段 E）figma 托管配置的落点：`.vant/state/figma/user-config.json`（运行时生成，不入 Git）为推荐方案；备选是要求前置条件"用户已 config init"（依赖工程外机器状态，不推荐）。
2. （阶段 B）`unity.compile`（recompile 触发）在 GAP-U1 未补齐前是否保留：recompile 触发本身可用（触发≠关联验收），建议保留但验收证据标注 unverified；若审查认为误导，可先隐藏。
3. （阶段 D）后端身份路线：组合方案（u-cli-mod 直连 job HTTP + 命令层 runId 状态文件）为倾向项（§6），与纯命令层 runId 二选一；涉及 u-cli-mod 新增直连命令时按独立提交审查。

## 10. 审查记录（两轮独立审查，修正已直接合入正文）

| 轮次 | 结论 | 发现 | 处置 |
| --- | --- | --- | --- |
| 第一轮（2026-10-10） | 有条件通过 | P0×1：状态归一无任务级 cancelled 承载位；P1×4：漏勘 HTTP job 协议、doctor 空数组注解错误、缺 init/inspect 契约、映射表未标现状差异；P2×6：recompile 响应值域、GAP-V1 措辞、buildExecArgs 描述、pathFields 核对、映射表分轴、依赖声明归属 | 全部合入：§5 三轴定稿（lifecycle 扩六态）、§6/matrix §2b/samples §3 补 job 协议、§3.4/§3.5 新增、其余逐项修正 |
| 第二轮（2026-10-10，全新视角，独立复测 CLI 可达性与 P.Cell 现状） | 有条件通过 | P1×3：§5 差异列 3 处基线错误（row 8 解析路径混同——载荷不可解析现状实为 succeeded/completed/failed；rows 2/9 现状 lifecycle 恒为 completed 非"一致"）；P2×3：pathFields 核对强度不足、default-registry 方向约束自相矛盾、rows 6/7 pending 标注不精确；P3×6：勘验表/official.ts/testMode 读取点/figma 必填措辞/工作区表述/integrity 定位 | 全部合入：§5 差异列改为精确迁移基线、§3.1 强核对定稿、§3.2 迁出决策、§9 改为决策记录（5 决策 + 3 待定） |
