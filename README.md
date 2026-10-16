# Vant 工具命令入口

`@kevlns/v-cli`

## 功能

提供工具发现、插件路由、工程绑定、结构化能力执行和操作证据管理。

## 环境要求

Node.js 20 及以上；各工具的系统要求由插件清单和实际检测结果提供。

## 安装

```sh
npm install -g @kevlns/v-cli
```

## 快速开始

```sh
v-cli doctor
v-cli plugin list --json
v-cli agent index --json
v-cli agent docs
```

## 使用说明

### 两种执行入口

| 入口 | 职责 |
| --- | --- |
| v-cli art / unity / figma / ship / xlmerge | 插件子进程路由；参数和输出属于原工具 |
| v-cli capability list / describe / run | 结构化契约、绑定、前置条件、授权、证据和退出码 |

插件路由不会解析或改写插件输出；插件自己的 --help/--json 原样传入。结构化 provider 当前为 unity、figma、art；ship 和 xlmerge 有官方命令入口，不代表它们已注册 capability。完整集合以 live describe 为准。

### 工程与结构化执行

```sh
v-cli project init --project .
v-cli project inspect --project . --json
v-cli capability list --json
v-cli capability describe unity.test-start --json
v-cli capability run unity.doctor --project . --json
v-cli capability run unity.test-start --project . --set mode=EditMode --json
```

project init 写入工程 `.vant/config/v-cli.json`，只保存 schemaVersion 和 provider bindings。已有配置只补缺失且有默认值的段，不覆盖已有值；显式 --binding 指向已有段时拒绝并提示 --reset。--reset 先备份再替换；--dry-run 不写配置或备份。art 需要显式 workspace/output/cache/projectId 绑定，不能猜当前工程 ID。

Vant 的角色、workflow 和项目组织属于 `.vant/config/project.json`，v-cli 不读取或写入。绑定路径限定工程内，拒绝穿越和链接越界；具体字段见 capability describe 的 provider.binding。

run 接受 --input JSON、--input-file FILE 和 --set k=v，按文件 → 内联 JSON → set 顺序合并，后者覆盖同名值。输入文件适合较大句柄或复杂结构，其路径以调用进程当前目录解析。目标由 --project 和绑定决定，不接受输入覆盖 projectPath。

默认每次调用记录到 `.vant/state/operations/<operationId>`，包含脱敏输入、事件、stdout/stderr 和结果。显式 --operation-id 必须唯一，不能覆盖；--no-persist 会失去原操作证据，不适合后续按句柄控制的生产启动。

### 生命周期与结果

| 字段 | 含义 |
| --- | --- |
| execution.status | 本次调用 succeeded/failed/cancelled/unknown |
| execution.lifecycle | 后端任务 accepted/running/completed/failed/cancelled/unknown |
| acceptance.status | 业务结论 passed/failed/not-run |
| handle | 原启动操作与真实后端身份，后续查询/取消/恢复按契约传入 |
| followUp | 尚需执行的查询或后续动作 |

退出码：0=验收 passed，1=执行或验收失败，2=未执行，3=已执行但未验收，4=已确认取消，5=结果未知。工具子进程 exit 0 不等于业务成功。异步 accepted 不是 completed；pending 时按 followUp 查询。

Unity 编译和测试触发返回真实 runId 句柄。跟踪同一次执行使用 unity.compile-query、unity.test-query、unity.test-cancel-run，把原结果 handle 放入输入文件：

```sh
v-cli capability describe unity.test-query --json
v-cli capability run unity.test-query --project . --input-file query.json --json
```

query.json 应包含完整的 handle 字段；不要手工伪造。每次查询使用新的 operationId。无参 compile-status/test-status 只是最近一次或当前状态观察，不能用来证明某个启动任务完成。unknown_run、缺少证据或身份失配不得回退最近任务。Unity runId 支持要求实际工具和工程适配包就绪；doctor 前置检查不可跳过。

### 美术工坊

先读取 `v-cli agent docs art`。art 工具拥有工程风格/任务、模型登记、生成策略、后台运行、停止证据及候选定版；v-cli art provider 负责结构化路由和句柄关联，不维护第二份型号目录。

```sh
v-cli art config show
v-cli art agent index
v-cli art config validate
v-cli capability list --provider art --json
v-cli capability describe art.run-status --json
v-cli capability describe art.run-resume --json
```

原运行查询、取消、恢复通过 art.run-status/run-cancel/run-resume 传入原 handle。丢失启动回执用 art.run-recover 查唯一原登记；恢复不是重新生成。动态参考先分析，配置/引用变化重新预演；产品只有生成与定版两阶段。

远程图片用 art 协议适配器，当前为 DashScope；视觉分析连接独立。模型可发现不等于已启用、已适配或账号有权调用。认证只从受控连接注入，不放入工程、输入文件、argv 或日志。详细限制由 art 的随包指南负责。

### 其他官方插件

| 命令 | 使用范围与边界 |
| --- | --- |
| unity | 精确 Editor 版本路由、CLI 校验、适配包安装和 Pipeline 调用；连接目标工程的运行中 Editor |
| figma | Figma 导出和 staging Prefab 工具；结构化 provider 仅离线 doctor/contract，不含联网导出或转换 |
| ship | 已构建游戏的 Steam/微信校验和开发渠道交付；不自动向玩家发布 |
| xlmerge | .xlsx/.xlsm Git 冲突可视化解决；先 detect，有人工项时 launch 并交用户决策 |

每个插件首调先读 agent docs，再 describe。不要将插件执行成功当作引擎运行、平台发布或美术产物已完成。

### Agent 文档与技能

```sh
v-cli agent init . --dry-run --json
v-cli agent init .
```

agent init 将随包 AGENTS.md 和技能装配到目标目录下已有的匹配 Agent 技能根。AGENTS.md 已存在时默认整体拒绝；--force 覆盖并完全同步随包技能，先核对目标。默认保留随包没有的项目扩展；同名随包技能文件以随包版本为准。组织层任务历史与资源租约不由此命令管理。

### 本地插件与 SDK

本地插件是可信本地代码，不是沙箱。最小模块示例：

```js
export default {
  name: "hello",
  description: "示例",
  apiVersion: 1,
  register(program, ctx) {
    program.action(() => ctx.log.result("hello"));
  }
};
```

保存为用户插件目录 hello.mjs 后可执行 v-cli hello。不能占用内置或官方保留命令名。插件清单契约见 [schema](schemas/v-cli-plugin.schema.json)。

```ts
import {
  createDefaultRegistry, createArtProvider, createFigmaProvider,
  createUnityProvider, runCapability, exitCodeForResult,
  CapabilityRegistry, NodeProcessExecutor, verifyExecutionHandle
} from "@kevlns/v-cli";
```

公开出口是 dist/sdk.mjs 与 dist/sdk.d.ts，对应 src/sdk.ts；核心不 import providers，默认装配在 src/default-registry.ts。传入完整 providers 集合会替换默认集合。资源声明不等于锁；SDK authorize 由组织层注入，未注入时报告 not-enforced。内核不自动重试生成或触发。

### 环境与开发

| 变量 | 用途 |
| --- | --- |
| VANT_HOME | 应用数据根，默认 ~/.vant |
| V_CLI_HOME | v-cli 独立主目录，优先于统一根 |
| V_CLI_PLUGIN_RESOLVE_FROM | 开发/测试解析官方包的根 |
| V_CLI_HOST_VERSION / V_CLI_PLUGIN_API / V_CLI_INVOKED_BY | 路由时注入宿主版本、契约和来源 |

前置 `v-cli --json CMD` 的 --json 由宿主消费；命令后的 --json 属于命令，官方插件原样转发。不能假设全局 JSON 开关会改写插件结果。

```sh
npm install
npm run generate:agents
npm run docs:check
npm run check
npm run test:package
```

AGENTS.md 从生成源和实际解析的插件清单生成，禁止手改。优先已安装依赖；完全无法解析时才使用 sibling 清单 bootstrap。发布前应以实际依赖检查，不把本地联接当作已发布版本。test:package 检查隔离安装、发现与真实路由，不证明 Unity、付费模型或平台端到端业务成功。

[架构规范](docs/registration-execution.md) · [身份矩阵](docs/execution-identities.md) · [协议解释](docs/provider-protocols.md) · [扩展与验证](docs/provider-development.md)

MIT，见 [LICENSE](LICENSE)。问题反馈：[GitHub Issues](https://github.com/kevlns/v-cli/issues)。

## 开发与验证

```sh
npm ci
npm run check
npm run test:package
```

命令返回、结构校验、模拟测试与外部平台实际运行分别核验。发布版本和依赖以随包 `package.json` 为准。

## 文档

[Agent 调用规范](AGENTS.md) · [文档规范](docs/documentation.md) · [执行身份与生命周期](docs/execution-identities.md) · [Provider 扩展与维护](docs/provider-development.md) · [Provider 协议解释](docs/provider-protocols.md) · [注册与执行架构](docs/registration-execution.md)

## 许可与版权

本工具采用 [MIT 许可](LICENSE)。Copyright © 2026 Vant。Vant 为工具集品牌；Figma、Unity、Steam、微信及其组件归各自权利人所有，第三方组件适用各自许可。
