# 注册与执行基座（第一阶段）规范

> 定位：v-cli 是**注册和执行基座**（capability 注册表 + 执行内核 + 结果契约）。
> Vant 组织层拥有任务调度、持久化任务与资源租约；本阶段不设计模型编排与 workflow 调度。
> 本文只描述已实现内容与明确的剩余事项，不含未来阶段的规划。

## 1. 架构边界

```
commander CLI（src/commands/capability.ts / project.ts）
        │  只做参数解析、输出格式化、退出码映射
        ▼
SDK / 执行内核（src/sdk.ts → dist/sdk.mjs）
   ├─ CapabilityRegistry          注册期校验、list/describe（只读，不执行工具）
   ├─ runCapability               运行期：输入校验 → 授权 → 前置条件 → 执行 → 输出校验 → 结果
   ├─ NodeProcessExecutor         受控 argv、shell:false、超时/取消即杀、输出捕获
   ├─ 工程层（src/core/project/） 工程根锚定、.vant/config/v-cli.json（通用外壳+绑定强核对）、.vant/state/operations
   └─ 默认注册表（src/default-registry.ts，阶段 B 迁出 core；src/core 不 import providers）
        │
        ▼
Provider（src/providers/unity/）：把已安装的 @kevlns/u-cli-mod 包装成结构化 capability
```

- CLI 与内核分离：内核不 import commander；`dist/sdk.mjs` + `dist/sdk.d.ts` 可被后续 MCP/Agent/Vant 直接 import（`package.json` 的 `exports["."]`）。
- 本阶段**不实现**：任务队列、资源锁、SQLite、守护进程、模型编排、workflow 调度。
- 资源需求只做**声明**；授权校验由组织层通过 `runCapability({ authorize })` 注入。

## 2. 契约

### 2.1 描述（descriptor，注册期校验）

`id`（稳定、带 provider 命名空间前缀，如 `unity.compile`）、`version`（语义化版本）、`description`、
`inputSchema`/`outputSchema`（JSON Schema 子集，顶层必须 object）、`preconditions`（声明）、
`sideEffects`（声明，含 kind 与是否可逆）、`resources`（kind/mode/scope）、`retry`（safe/maxAttempts/strategy/description）、
可选 `timeoutMs`/`tags`。

注册拒绝：重复 provider id / 重复 capability id、非命名空间 id、非法 schema、非法元数据、
`preconditions` 与实现提供的检查器不一一对应。注册失败不产生部分注册（`CapabilityRegistrationError.errors` 列出全部问题）。

支持的关键字：`type`（object/array/string/number/integer/boolean/null）、`properties`、`required`、
`additionalProperties`（false 时拒绝未声明字段）、`minProperties`/`maxProperties`、`items`、`minItems`/`maxItems`、
`enum`、`minLength`/`maxLength`、`pattern`、`minimum`/`maximum`、`nullable`。

### 2.2 执行（`runCapability`）

```
锚定工程根 → 读 .vant/config/v-cli.json → 校验真实输入 → 资源授权（可注入）
  → 前置条件（violated/unknown 一律 fail-closed）→ 实现执行
  → 校验真实输出与副作用声明 → 组装结果 → 落盘记录
```

- **请求级失败**抛 `CapabilityError`（CLI 输出稀疏错误对象，退出码 2）：未注册 capability、
  工程根缺失/非目录、配置缺失/非法/绑定越界、operationId 非法或已存在。
- 运行上下文：`projectRoot`、`operationId`、可选 `taskId`/`runId`、`AbortSignal`、`bindingDirs`、`log`、`persist`。
- 实现上报未声明的副作用类型、输出不符合 `outputSchema`（含成功后不给输出）→ 执行状态降级为 `unknown`
  （错误分类 `output`），验收一律 `not-run`。
- 实现自称 `acceptance=passed` 但执行未成功或缺证据时，内核降级为 `not-run` 并记录原因。

### 2.3 结果（`CapabilityRunResult`，稳定 JSON）

`schemaVersion`、`operationId`、`capability`、`provider`（含工具版本/路径与绑定契约）、`project`（root/configFile/bindingDirs）、
`invocation`（taskId/runId/受控 argv/时间）、`execution`（status/lifecycle/exitCode/signal/attempts/error）、
`handle`（异步触发句柄，见 §8.1；其余为 null）、
`acceptance`（status/reason/pending/evidence）、`preconditions`、`resources`（declared/authorization/grantId/denials）、
`sideEffects`、`artifacts`、`logs`（stdout/stderr 的字节数、sha256、截断标记、落盘文件名、尾部片段）、
`output`（已通过 `outputSchema`）、`followUp`、`notes`、`warnings`、`persisted`。

**执行状态**（本次调用本身）：`succeeded` | `failed` | `cancelled` | `unknown`；
**生命周期**（任务级六态，阶段 C 扩展）：`accepted` | `running` | `completed` | `failed` | `cancelled` | `unknown`；
**验收状态**（业务结论）：`passed` | `failed` | `not-run`。
`passed` 红线（阶段 C 定稿）：调用 succeeded 且 lifecycle ∉ {accepted, unknown} 且非 pending/aborted（survey §9 决策 6）。

硬性语义：

- 进程退出码 0 **不等于**业务通过；退出码 0 只在验收 `passed` 时出现。
- 取消只有在观察到子进程终止（`killConfirmed`）时才是 `cancelled`；否则 `unknown`。
- 超时 → `unknown`（业务结论不可知），不冒充失败或取消。
- `acceptance.pending=true` 表示"尚无结论，应按 `followUp` 轮询"。

退出码：`0` 验收 passed；`1` 执行或验收失败；`2` 未执行（入参/配置/前置条件/资源授权）；
`3` 已执行但验收 not-run；`4` 已确认取消；`5` 结果未知。

## 3. 命令用法

```bash
v-cli project init  [--project <dir>] [--binding <providerId>=<JSON>]... [--json]
v-cli project inspect [--project <dir>] [--json]
v-cli capability list [--provider unity] [--json]
v-cli capability describe <id> [--json]
v-cli capability run <id> [--project <dir>] [--input <json> | --input-file <path>] [--set k=v]... \
                      [--operation-id <id>] [--task-id <id>] [--run-id <id>] [--no-persist] [--json]
```

- `list`/`describe` 只读描述（provider 状态只做包发现，不执行被包装工具）。
- `run` 的输入合并在 `--input` / `--input-file` / `--set`（后者覆盖前者；`--set` 点号建嵌套、值按 JSON 字面量解析）。
- 工程根默认当前目录，但**必须存在** `.vant/config/v-cli.json`；缺失时报错并给出 `v-cli project init` 指引。
- 配置外壳与绑定契约的通用化（Provider 自包含、`--binding`、强核对）见 §7；本节其余行为不变。

### 3.1 Unity 能力（首个 provider）

| capability | 形态 | 验收判据 |
| --- | --- | --- |
| `unity.doctor` | 只读诊断 | `routeSupported=true` 且 `cli.state=valid` 且 `pipeline.installed=true` 且 `pipeline.state=current`；**退出码 0 只表示诊断完成** |
| `unity.editor-status` | 只读状态 | `status="ready"`（其余取值/缺字段 → failed） |
| `unity.compile` | 异步触发 | `not-run`（接受/未确认时 `pending`，轮询 `unity.compile-status`；后端明确拒绝时不 pending） |
| `unity.compile-status` | 状态 | `completed`/`up_to_date` 且无编译错误报告 → passed；`triggered`/`compiling` → not-run(pending)；`idle` → not-run；`failed`/未知 → failed |
| `unity.test-start` | 异步触发（固定 `--async_tests`） | 一律 `not-run`（`pending`），轮询 `unity.test-status` |
| `unity.test-status` | 状态 | `completed` **且**非零有效报告中全部用例通过 → passed；有失败/缺失败数/缺报告/未知取值/缺字段 → failed；运行中 → not-run(pending)；`idle` → not-run；`cancelled` → failed |
| `unity.test-cancel` | 请求+确认 | 响应显式确认或 `test_status` 探测为 `cancelled` → passed；仍运行 → not-run(pending)；其余 → not-run（**未确认不得报告已取消**） |

- 目标工程由配置绑定：`bindings.unity.projectDir`（相对工程根；`"."` 表示工程根自身）。
  能力输入 **不含** `projectPath` 一类字段，`additionalProperties: false` 使其直接失败；argv 由 v-cli 构造，无 shell 拼接。
- exec 类能力默认自动跑一次 doctor 核对就绪判据（不得跳过）。
- 配置可钉扎 `editorVersion` 与默认 `testMode`；doctor 版本不一致即前置条件不满足。
- 协议解读见 `src/providers/unity/protocol.ts`：只认文档/包内证据出现过的字段路径，
  已知协议字段缺失一律不通过，并把实际读到的字段与取值写进 `evidence`。

## 4. 工程 `.vant` 目录职责

```
<工程根>/.vant/
├── config/
│   ├── v-cli.json     ← v-cli 专属：仅 CLI 能力/适配器绑定（schemaVersion/bindings）
│   └── project.json   ← Vant 组织层：角色/workflow/项目组织；v-cli 既不读也不写
├── state/
│   └── operations/<operationId>/
│       ├── input.json    输入摘要（脱敏后的入参 + 被脱敏的键路径）
│       ├── events.jsonl  事件流（预留目录、配置加载、进程起止、前置条件、结果）
│       ├── stdout.log    主进程 stdout 原文（超 8 MiB 截断并标记）
│       ├── stderr.log    主进程 stderr 原文（同上）
│       └── result.json   完整结果证据（与 CLI/SDK 返回对象一致）
└── docs/spec/registration-execution.md  ← 本文档
```

约束：

- `v-cli.json` 中出现 `roles`/`workflow`/`project`/`stages` 等 Vant 职责字段 → 明确拒绝（单一真源，不做双份配置）。
- `project init` 不覆盖已有配置（无 `--force`），**绝不修改** `project.json`（只做只读提示）。
- `operationId` 必须匹配 `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`、非保留设备名；已存在的 operation 目录一律拒绝覆盖
  （目录创建为非递归 `mkdir`，写入用 `wx` 标志双保险）。
- 越界与链接防护：绝对路径 / `..` / `.` / 空段 / NUL 一律拒绝；对"最深已存在祖先"取 realpath 核对包含关系；
  目标是符号链接/联接时 fail-closed。`--project` 显式锚定工程根。

## 5. 第一阶段的实际实现与取舍

已实现：

- 注册表（含全部拒绝规则）、执行内核、SDK 出口（`exports["."]` + `d.ts`）、进程执行器（可注入）、
  工程配置读写与路径安全、操作记录与脱敏、`capability`/`project` 两组 CLI、Unity provider 七个能力、
  内置命令保留名与 agent 元数据、AGENTS.md 生成器与 README/skill 同步、pack 护栏（要求 `dist/sdk.mjs` 与 `dist/sdk.d.ts` 且校验 exports）。

取舍与已知限制：

1. **落盘 vs 不落盘**：默认落盘（本地证据链，便于主代理与人工复核）；`--no-persist` 供测试/SDK 探测，
   代价是没有任何本地证据记录、不占 operation 目录。内核不做日志轮转与清理（属组织层职责）。
2. **脱敏范围**：对入参做键名 + argv 形态的保守脱敏；工具自身 stdout/stderr 属证据原文，按原样保存。
3. **不自动重试**：`retry` 语义仅按契约声明（`safe`/`maxAttempts`/`strategy`），内核单次尝试；
   触发类能力通过状态能力轮询而不是自动重放。
4. **不假装资源锁**：未注入 `authorize` 时结果为 `authorization: "not-enforced"`；内核不创建租约、不跨进程协调。
5. **doctor 前置检查是额外进程调用**：exec 前强制核对就绪判据，不提供跳过选项。
6. **真实 Unity 协议**：已在 P.Cell / Unity 2022.3.59f1c1 核对。状态命令的 `data.result`
   可为 JSON 对象或序列化 JSON 字符串。编译终态必须 `failed=false` 且 `errors=[]`；
   测试终态必须 `summary.total>0`、`summary.passed=total`、`summary.failed=0`，计数均为非负整数。
   状态未知、报告缺失、零用例与未全部通过均不验收通过。
7. `unity.test-start` 固定追加 `--async_tests`；小范围同步测试（`--filter` 同步等待）仍走现有
   `v-cli unity exec …` 插件入口，不在 capability 中伪装成同步。

剩余事项（未做，需后续阶段）：

- 组织层任务调度/持久化任务/资源租约与 `authorize` 钩子的对接（内核已留接口）。
- 更多 provider（figma/ship 等）按同一 contract 接入。
- 共享逻辑抽取为独立模块时再评估 model 编排（本阶段不设计）。

## 6. 工程验证

2026-10-10：P.Cell（Unity 2022.3.59f1c1）真实验证了 Editor 状态、编译触发与无错误终态、异步测试触发与报告轮询。FrameworkModuleBaseTests 3 项全部通过，结果和日志保存在工程 .vant/state/operations（不入库）。零用例报告与未确认取消按失败或未验收处理。SDK 包的隔离安装与导入由 test:package 检查。

## 7. 阶段 B：通用 Provider 与工程配置（已实现）

> 依据：`.vant/docs/spec/phase-a-survey.md` §3（契约设计）。2026-10-10 实施完成。

### 7.1 Provider 绑定契约（自包含）

`CapabilityProvider` 新增两个成员（注册期校验，缺失/非法整体拒绝）：

- `binding: ProviderBindingContract` —— `{ schema（bindings.<id> 段的 JSON Schema 子集，顶层 object）、pathFields（路径字段声明：field/kind:dir|file/required）、resolve({project, raw, resolveInsideProject}) }`。
- `defaultBinding?(project)` —— 可选：project init 的默认绑定段生成器（`{section, warnings}`）；未实现则 init 不为该 Provider 生成段。
- 注册期校验追加：schema 合法且顶层 object；pathFields 字段名合法、不重复、**必须**在 schema.properties 声明；kind/required 类型正确；resolve 是函数。

核心强核对（不信任 Provider 的解析结果）：`resolveBindings`（core/project/config.ts）对每个已声明 pathField 从 `raw[field]` 自行调用 `resolveInsideProject` 重解析并与 `resolve` 返回的 `dirs/files[field]` 字符串比对（基准 `.path`）；resolve 夹带未声明的 dirs/files 键、或声明字段缺解析结果 → 绑定无效；非 required 字段缺失合法（不得出现在结果中）；`kind` 的存在性校验属前置条件（绑定期不做 I/O 探测）。路径违规（PathSafetyError）从 resolve 与强核对**穿透**，配置归类 `unsafe-binding`；其余绑定错误归 `invalid`。

### 7.2 配置外壳（核心只管结构）

`{ schemaVersion: 1, bindings: Record<providerId, unknown> }`。外壳校验：schemaVersion、顶层键白名单、Vant 职责键拒绝、`__proto__/constructor/prototype` 危险键拒绝、bindings 键必须是 provider id 形态且值为对象。字段级校验全部委托对应 Provider。

失败语义（计划 §5）：

- 绑定段**缺失**：配置整体有效（`unbound` 列出）；该 Provider 的能力运行期由前置条件明确失败。
- 绑定段**已声明但无效**（未知 Provider / schema 不符 / 路径越界 / 强核对不一致）：整个配置 fail-closed。
- 绑定值 `"."` 表示工程根本身（`resolveInsideProject` 支持）。

### 7.3 执行上下文与结果

- `CapabilityExecutionContext` 新增 `binding`（本 Provider 的已校验绑定段；Provider 消费它而不是重读 `ctx.config`）；`bindingDirs` 语义变更为**本 Provider 的** pathField→绝对路径。
- `CapabilityRunResult.project.bindingDirs` 变更为嵌套结构 `{ [providerId]: { [field]: 绝对路径 } }`（全部已声明绑定）。
- unity provider 不再读 `ctx.config.bindings.unity`；`UnityBinding/UnityTestMode` 类型与 `unityBindingContract` 移至 provider（SDK 出口不变）；provider 版本升 0.2.0。

### 7.4 装配与方向约束

- `default-registry.ts` 从 `src/core/execution/` 迁至 `src/` 根：**`src/core/**` 不得 import `src/providers/**`**（绝对规则，测试覆盖）。
- `createDefaultRegistry({ providers })`：提供完整集合即完全替代内置装配；缺省显式装配内置 Provider。

### 7.5 project init / inspect（与注册集合一致）

- init：外壳 + 有 `defaultBinding` 的 Provider 默认段；`--binding <providerId>=<JSON>`（可重复）完整替换该段；写入前全量校验（外壳 + 契约 + 强核对），失败拒绝且不写文件；已存在一律拒绝；不触碰 Vant 配置。旧 Unity 专属选项（`--unity-project/--editor-version/--test-mode`）**移除**（不留别名；等价形式为 `--binding unity='{"projectDir":…,"editorVersion":…}'`）。
- inspect：按当前注册集合逐 Provider 报告 `providerBindings`（bound / missing-binding / invalid，含 dirs/files/warnings/errors）；配置里的未知 Provider 绑定段明确点名；与运行期 `loadProjectConfig` 同一入口。

### 7.6 验收（对应计划 §5 验收标准）

- 第三方样本 Provider（`tests/helpers/sample-provider.ts`，含 dir/file、必填/可选路径字段）仅实现 Provider 模块即接入：注册、绑定解析、执行全链路由 `tests/provider-binding.test.ts` 覆盖（未修改任何核心源文件即完成接入）。
- 各 Provider 绑定分别校验；当前能力所需绑定缺失 → 前置条件 violated 明确失败（sample.binding）。
- 已声明的无效绑定 fail-closed；无关 Provider 缺失绑定不阻断（unity 能力照常执行，错误类别 precondition 而非 config）。
- 绝对路径 / 穿越 / 链接越界 / 危险键在执行前（配置加载层）被拒绝；`__proto__` 经 JSON.parse 的自有键也被外壳拒绝。
- 强核对负例：谎报路径、夹带未声明键、resolve 抛错/返回 errors/返回畸形全部拒绝。
- `npm run check` 与 `npm run test:package` 全绿（344 通过 / 5 条件跳过；隔离安装冒烟通过）。

### 7.7 阶段 B 明确不做（后续阶段）

- 句柄与异步执行身份（阶段 C）；Unity 后端协议（阶段 D）；Figma Provider（阶段 E）。
- `src/core/official.ts` 的插件路由白名单保持原状（属插件命令路由层，非 Provider 配置逻辑；figma 接入时复用）。

### 7.8 一审修复（2026-10-10，已直接合入正文）

一审结论：有条件通过（P0×0 / P1×3 / P2×4 / P3×4，全部处置）：

- P1-1 `resolveBindings` 对「ok 但缺 dirs/files」的畸形返回新增防护（`dirs 必须是对象` 结构化错误，不再以 TypeError 击穿请求级契约）+ 负例测试。
- P1-2 随包 skill（skills/v-cli/SKILL.md）残留旧 init 选项 → 同步为 `--binding` 形式。
- P1-3 绑定契约可见性落地：`capability describe` 的 provider 块现暴露 `binding.schema + pathFields`（注册时冻结快照的克隆），CLI describe 文本输出绑定 schema 与路径字段行。
- P2-1 注册表对绑定契约做深拷贝 + 冻结快照（schema/pathFields；resolve 函数保留引用），注册后污染原始对象不影响校验规则；`pathFields` 类型改为 readonly + 回归测试。
- P2-2 GAP-V1 闭合：unity.compile-status / unity.test-status 描述补「观察语义：不证明归属 / 引擎级覆写（编译）/ 新启动顶替+跨会话残留（测试）」警示。
- P2-3 方向约束落地为静态扫描测试（tests/core-boundary.test.ts：src/core/** 不得 import providers）。
- P2-4 inspect 逐 Provider 归因精确化（完整段边界正则匹配；不可归因错误归全局并列出，不再误报 bound）。
- P3：validateValue 对象分支统一拒绝 `__proto__/prototype/constructor`（纵深防御）；删除 types.ts 死代码 ResolvedBinding；配置读取失败分类（ENOENT→missing，其余→invalid 带原因）；补 `createDefaultRegistry({providers})` 注入测试。

修复后：`npx tsc --noEmit` 0 错误；vitest 20 文件 350 通过 / 5 条件跳过。

### 7.9 二审修复（2026-10-10，已直接合入正文）

二审结论：有条件通过（P1×1 / P2×3 / P3×9，全部处置；其中 3 项 P3 为登记接受的限制）：

- P1-1 注册表存储的 Provider 包装对象整体冻结（`Object.freeze`）——查询路径（listProviders/getProvider）交出的对象不可整体改写 binding/defaultBinding/capabilities，闭合计划 §5"查询元数据不可污染"。
- P2-1 注册期对 pathField 条目做白名单键校验（只允许 field/kind/required）——消除 describe 对合法注册契约的 structuredClone DataCloneError 崩溃通道；同时拒绝危险字段名（`__proto__/prototype/constructor`）。
- P2-2 规范正本 §1 架构图与 §3 用法块同步至阶段 B 事实（default-registry 新路径、`--binding` 用法）。
- P2-3 inspect 归因补测试：段错误归因、前缀相近 id 不互串、全局错误不再误报 bound、未知 Provider 点名、配置缺失全量 missing-binding。
- P3 修复：validateBindingContract 死参数删除；输出 schema 的 status 字段描述补观察语义（GAP-V1 输出契约口径闭合）；路径违规改为 pathUnsafe 标志（不再丢弃同批其余错误，unsafe-binding 分类保留）；配置缺失时 inspect 按注册集合全量报告 missing-binding；`toProviderSet` 拒绝重复 id（不再 last-wins）；CLI 级 describe 断言 provider.binding。
- P3 登记接受（不修）：inspect 归因重读配置文件的只读 TOCTOU（展示用途，无执行面）；`bindingDirs` 命名含 files 的历史包袱（注释已写清，改名属破坏性变更留待阶段 C 结果契约统一评估）。

## 8. 阶段 C：异步执行身份与证据（已实现）

> 依据：`.vant/docs/spec/phase-a-survey.md` §4/§5（身份模型与状态归一）。2026-10-10 实施完成。

### 8.1 执行句柄（core/execution/handle.ts）

- 触发类能力的 `ImplementationOutcome.handle`（种子：`backendTaskId` + 来源说明）由**内核**补全为完整句柄
  （`ExecutionHandle`）：schemaVersion / providerId / capabilityId / originOperationId / backendTaskId /
  project{root,configFile} / startedAt / recoverable / recordDir / integrity{sha256}。身份字段一律以内核为准，
  Provider 无法伪造工程身份；`--no-persist` 启动 → `recoverable=false`。句柄随结果落盘（result.json.handle）。
  产出条件：Provider 提供种子且本次调用 `execution.status === "succeeded"`。
- `integrity` 为 canonical（递归键排序）sha256 摘要：**完整性提示**（防手滑改动/截断），非签名（survey §9 决策 5）。
- `verifyExecutionHandle({project, handle, expectProviderId, expectCapabilityId?})` 是查询/取消能力的**统一校验闸门**
  （Provider 不得自行实现一套）：形状与版本 → integrity 自洽 → Provider/能力匹配 → 工程 realpath 匹配 →
  recoverable → recordDir 形态 → 落盘 result.json 回读交叉核对（operationId/capabilityId/providerId/
  project.root/backendTaskId/startedAt 逐项）。失败码：handle-invalid / handle-version-unsupported /
  handle-integrity-mismatch / handle-provider-mismatch / handle-capability-mismatch / handle-project-mismatch /
  handle-not-recoverable / handle-evidence-unsafe / handle-evidence-missing / handle-evidence-unreadable /
  handle-evidence-unusable（记录非异步触发、无 handle 字段；与篡改并存时优先归类）/ handle-tampered。任何失败**明确拒绝，不回退最近任务**。校验只读启动目录，绝不复用/覆盖。
- 跨进程恢复 = 按句柄重读落盘证据（同一磁盘即同一事实源）；每次查询/取消是独立 operationId（计划 §6）。

### 8.2 六状态 lifecycle（阶段 A §5 迁移基线落地）

- `ExecutionLifecycle` 扩为 `accepted | running | completed | failed | cancelled | unknown`（runtime 校验同步）。
- unity provider 按 delta 表迁移：状态查询=运行中 → `running`；终态失败 → `failed`；`test_status=cancelled` →
  `cancelled`（后端确认取消一等表达）；idle/未知值/字段缺失 → `unknown`；新增**载荷级不可解析**分支
  （protocol.ts `payloadParseError`：信封 OK 但 data.result 字符串不可二次解析 → 调用 succeeded / 任务 unknown /
  not-run(pending)，与"值域外"分开）；超时/不可解析路径补 pending+followUp（超时只说明调用结束，不推断底层停止）。
- 验收降级守卫更新：`passed` 要求调用 succeeded 且 lifecycle ∉ {accepted, unknown} 且非 pending/aborted——
  红线不变（启动≠通过、不可解释≠通过）；任务级 running/failed/cancelled 允许能力自身 passed（观察/关联/取消类
  验收目标，如 cancel 的 passed=取消已确认生效，被取消任务的业务结论仍由其状态能力给出）。
- unity 触发类（compile/test-start）产出句柄：`backendTaskId=null`（后端无身份协议，GAP-U1）并在 notes 声明
  "终态关联 unverified，不可用于句柄关联查询"；Unity 不提供句柄查询/取消能力（survey §9 决策 3）。
- 样本 Provider（tests/helpers/sample-provider.ts）以 trigger/query/cancel 演示全链路（查询/取消的前置条件即
  内核校验——校验失败执行前拒绝、零后端副作用）。

### 8.3 GAP-U2 闭合：目标工程回显核对

unity `invoke()` 对 exec 信封回显的 `data.target.projectPath` 与绑定目录核对（大小写/分隔符归一比较）；
不一致 → `unity-target-mismatch`（protocol 类），响应整体不采信、不回退其他工程。doctor 非信封路径不受影响。

### 8.4 验收（计划 §6 矩阵，tests/execution-handle.test.ts 逐行覆盖）

| 矩阵行 | 结果 |
| --- | --- |
| 正确句柄查询同一任务 | passed + 关联字段（originOperationId/backendTaskId/correlation=verified）+ 落盘证据与身份核对项入 evidence |
| 另一工程句柄 | 前置条件 violated（handle-project-mismatch），执行前拒绝，无后端操作 |
| 句柄篡改/证据缺失/版本不支持 | integrity-mismatch / 高仿篡改（重算摘要）与证据不一致 → handle-tampered / evidence-missing / version-unsupported |
| CLI 重启后继续查询 | 新注册表实例按落盘证据恢复（④） |
| 启动但尚无终态 | 触发 not-run(pending)、lifecycle=accepted；查询观察为 running，不验收任务通过 |
| 后端确认取消 | lifecycle=cancelled + 取消依据（身份核对）保留 |
| 客户端退出/等待超时 | 超时路径 pending+followUp、不推断停止（unity 侧）；未落盘句柄 → handle-not-recoverable 明确错误（⑦） |
| 后端报告被其他任务替代 | backendTaskId 与证据不一致 → handle-tampered，不接受该报告（⑧） |

`npm run check` 与 `npm run test:package` 全绿（373 通过 / 5 条件跳过）。

### 8.5 已声明限制与明确不做

已声明限制（登记接受，非缺陷）：

- 落盘证据是一致性真源而非签名（同机威胁模型，survey §4）；result.json 的业务内容不在句柄摘要覆盖内。
- 证据核对对"记录缺 project 段 / 缺 startedAt 字段"静默放行（记录生成方是内核，字段缺失属内核违约，另有 result 契约约束）。
- Editor 若以设备命名空间前缀回显 projectPath，realpathSync 抛错 → 按不一致 fail-closed 拒绝（不崩溃）；真机出现再剥前缀。
- 路径词形归一（comparePathForm）仅 win32 小写（Linux 等大小写敏感平台保留区分）。

明确不做（后续阶段）：

- Unity 句柄关联查询/取消能力（GAP-U1：后端身份协议，阶段 D）。
- Figma Provider（阶段 E）；句柄 CLI 参数面（handle 经 capability 输入 JSON 传递，无专用选项）。

### 8.6 一审修复（2026-10-10，已直接合入正文）

一审结论：有条件通过（P0×0 / P1×3 / P2×4 / P3×5，全部处置）：

- P1-1 GAP-U2 比较基准升级：词法归一（分隔符/尾斜杠/平台感知大小写）未命中时按 realpath 最终路径比较（覆盖 8.3 短名/异形锚定）；补归一化正例（长路径/正斜杠/大写/尾斜杠）与真实异工程反例测试。
- P1-2 六态迁移补齐三分支：test-cancel 确认取消 → lifecycle=cancelled；compile-status 终态带编译错误 → failed；触发未确认（handoff/不可解析）→ unknown（与"无法确认已被接受"的错误消息一致）；并在 survey §5 登记裁决行（测试 completed 但用例失败/计数无效 → lifecycle completed + acceptance failed：运行正常结束、业务验收失败，与编译的 failed 区分）。
- P1-3 规范正本 §2.3 同步：结果契约补 `handle` 字段、lifecycle 改六态、passed 红线引用 survey §9 决策 6。
- P2-1 内核种子校验：`validateHandleSeed`（backendTaskId 必须 string|null）在 executionFinal 之前并入契约违约链（handle-seed-invalid → 结果降级 unknown、不发行句柄）；删除死契约面 `backendTaskIdSource`。
- P2-2 守卫再诠释登记：survey §9 决策 6（任务验收型 vs 调用目标型能力；红线 accepted/unknown 不放宽）。
- P2-3 CLI 文本模式补 handle 行（origin/backendTaskId/recoverable）；README capability run 行与 AGENTS 生成源核心约定补句柄与六态说明。
- P2-4 样本 query 的 accepted→running 映射明确为"在途观察"（依据落盘记录，evidence 含 origin lifecycle），终态原样传播。
- P3：normPath 平台感知（win32 才小写）；旧记录缺 handle 字段独立错误码 handle-evidence-unusable；句柄未知键拒绝；样本 retry 语义对齐 unity 约定；ctx 新增 projectAnchor（Provider 不再伪造 ProjectRoot）；test-cancel 探测消费 targetMismatch 入证据。

修复后：`npx tsc --noEmit` 0 错误；vitest 380 通过 / 5 条件跳过；`npm run check` 与 `npm run test:package` 全绿。

### 8.7 二审修复（2026-10-10，已直接合入正文）

二审结论：有条件通过（P0×0 / P1×2 / P2×0 / P3×6，全部处置）：

- P1-1 `backendTaskIdSource` 删除收尾：unity 两处触发种子残留键清除；`validateHandleSeed` 补未知键拒绝（类型防线对经索引访问 + 字面量 spread 的形态不设防，已实证——不变量固化为运行期校验）；补"种子夹带未知键 → handle-seed-invalid"回归测试。
- P1-2 §8.1 失败码枚举补 `handle-evidence-unusable`（含与篡改并存时优先归类的说明）。
- P3：删除一次性修复脚本残留；unusable/tampered 分流改结构化标记（missingHandleField 布尔，不再匹配错误消息文本）+ 混合场景测试；路径词形归一收敛为 core 单一实现 `comparePathForm`（paths.ts 导出，handle.ts 与 unity 复用）；§8.5 登记已声明限制（证据非签名/字段静默放行边界/命名空间前缀 fail-closed/归一平台边界）；样本 Provider 头注释更新；§3.1 compile 行 pending 措辞精确化。

修复后：`npx tsc --noEmit` 0 错误；vitest 382 通过 / 5 条件跳过；`npm run check` 与 `npm run test:package` 全绿。
