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
   ├─ 工程层（src/core/project/） 工程根锚定、.vant/config/v-cli.json、.vant/state/operations
   └─ 默认注册表（src/core/execution/default-registry.ts）
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

`schemaVersion`、`operationId`、`capability`、`provider`（含工具版本/路径）、`project`（root/configFile/bindingDirs）、
`invocation`（taskId/runId/受控 argv/时间）、`execution`（status/lifecycle/exitCode/signal/attempts/error）、
`acceptance`（status/reason/pending/evidence）、`preconditions`、`resources`（declared/authorization/grantId/denials）、
`sideEffects`、`artifacts`、`logs`（stdout/stderr 的字节数、sha256、截断标记、落盘文件名、尾部片段）、
`output`（已通过 `outputSchema`）、`followUp`、`notes`、`warnings`、`persisted`。

**执行状态**（本次调用本身）：`succeeded` | `failed` | `cancelled` | `unknown`；
**生命周期**（底层引擎工作）：`completed` | `accepted` | `running` | `unknown`；
**验收状态**（业务结论）：`passed` | `failed` | `not-run`。

硬性语义：

- 进程退出码 0 **不等于**业务通过；退出码 0 只在验收 `passed` 时出现。
- 取消只有在观察到子进程终止（`killConfirmed`）时才是 `cancelled`；否则 `unknown`。
- 超时 → `unknown`（业务结论不可知），不冒充失败或取消。
- `acceptance.pending=true` 表示"尚无结论，应按 `followUp` 轮询"。

退出码：`0` 验收 passed；`1` 执行或验收失败；`2` 未执行（入参/配置/前置条件/资源授权）；
`3` 已执行但验收 not-run；`4` 已确认取消；`5` 结果未知。

## 3. 命令用法

```bash
v-cli project init  [--project <dir>] [--unity-project Client] [--editor-version <v>] [--test-mode EditMode] [--json]
v-cli project inspect [--project <dir>] [--json]
v-cli capability list [--provider unity] [--json]
v-cli capability describe <id> [--json]
v-cli capability run <id> [--project <dir>] [--input <json> | --input-file <path>] [--set k=v]... \
                      [--operation-id <id>] [--task-id <id>] [--run-id <id>] [--no-persist] [--json]
```

- `list`/`describe` 只读描述（provider 状态只做包发现，不执行被包装工具）。
- `run` 的输入合并在 `--input` / `--input-file` / `--set`（后者覆盖前者；`--set` 点号建嵌套、值按 JSON 字面量解析）。
- 工程根默认当前目录，但**必须存在** `.vant/config/v-cli.json`；缺失时报错并给出 `v-cli project init` 指引。

### 3.1 Unity 能力（首个 provider）

| capability | 形态 | 验收判据 |
| --- | --- | --- |
| `unity.doctor` | 只读诊断 | `routeSupported=true` 且 `cli.state=valid` 且 `pipeline.installed=true` 且 `pipeline.state=current`；**退出码 0 只表示诊断完成** |
| `unity.editor-status` | 只读状态 | `status="ready"`（其余取值/缺字段 → failed） |
| `unity.compile` | 异步触发 | 一律 `not-run`（`pending`），轮询 `unity.compile-status` |
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
