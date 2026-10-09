<div align="center">

<img src="https://raw.githubusercontent.com/kevlns/v-cli/main/logo.png" alt="v-cli logo" width="320" />

# v-cli

**kevlns 的个人工具箱 CLI：插件化架构，内置命令随版本发布，本地插件放目录即生效。**

[![npm version](https://img.shields.io/npm/v/%40kevlns%2Fv-cli?style=flat-square&color=cb3837)](https://www.npmjs.com/package/@kevlns/v-cli)
[![npm downloads](https://img.shields.io/npm/dm/%40kevlns%2Fv-cli?style=flat-square&color=4c8bf5)](https://www.npmjs.com/package/@kevlns/v-cli)
[![CI](https://img.shields.io/github/actions/workflow/status/kevlns/v-cli/test.yml?branch=main&style=flat-square&label=CI)](https://github.com/kevlns/v-cli/actions/workflows/test.yml)
[![license](https://img.shields.io/github/license/kevlns/v-cli?style=flat-square&color=2e8b57)](./LICENSE)

[Getting started](#getting-started) · [Examples](#examples) · [API](#api) · [Package family](#package-family)

</div>

---

## Why v-cli?

v-cli 让你**用一个命令沉淀所有个人小工具**，而不用为每个工具建仓库、发包、记命令。
它被设计为**依赖极少、秒级启动、写个文件就能扩展**。

- **插件化架构** - 内置命令走注册表随版本发布；本地插件放进 `~/.v-cli/commands/` 立即生效，无需发版
- **官方插件白名单** - `@kevlns/xlmerge`（`xlmerge`）、`@kevlns/u-cli-mod`（`unity`）、`@kevlns/figma-to-uprefab`（`figma`）、`@kevlns/ship-cli`（`ship`）和 `@kevlns/art-workshop`（`art`），随包安装并在子进程中运行
- **容错加载** - 单个插件语法错误、契约不符或注册异常只会被跳过并报告，绝不阻断其他命令
- **双通道输出** - 结果走 stdout（可管道、可脚本化），诊断走 stderr
- **agent 友好** - `agent docs`/`agent init` 让 AI Agent 自举读取引导文档；`agent index/describe` 输出统一索引与完整元数据；仓库内 AGENTS.md 自动生成并有漂移检查
- **TypeScript-first** - 严格类型编写，tsup 将核心逻辑打包为单文件 ESM，仅保留 `commander` 运行依赖

## Getting started

### Install

```bash
# 正式版直接安装
npm install -g @kevlns/v-cli

# 或从 GitHub 仓库安装开发版本
npm install -g git+https://github.com/kevlns/v-cli.git
```

需要 Node.js **>= 20**。

### Quick start

```bash
v-cli doctor          # 环境体检：node/版本、主目录、配置、官方/本地插件状态
v-cli plugin list     # 列出内置命令、本地插件与官方插件状态
v-cli ts 1710000000   # 时间戳互转
```

### AI Agent 快速开始

v-cli 内置 AGENTS.md 随包发布，AI Agent 可自行发现读取：

```bash
v-cli agent docs                    # 内置 AGENTS.md 原文（--json 拿 package/version/sha256/content）
v-cli agent index --json            # 全部命令 + 元数据（builtin/local/official，live 发现）
v-cli agent describe <name> --json  # 单命令：用法/参数/选项/输出/退出码/安全标签
v-cli agent init .                  # （可选）把 AGENTS.md 写入工作区并装配 skill
```

`agent init [directory]`（默认当前目录）：已存在 AGENTS.md 时默认拒绝退出 1（`--force` 原子覆盖）；
`--dry-run` 只报告不写入；符号链接目标 fail-closed 拒绝；`--json` 输出稳定结果。

### 官方插件命令

官方插件随 v-cli 一起安装（精确固定依赖），装完即可路由：

```bash
v-cli xlmerge --repo <repo> detect            # 路由到 xlmerge 子进程
v-cli xlmerge --repo <repo> resolve

# Unity 工具链（仅 Windows 主机可用；其他平台 v-cli 会拒绝路由并说明原因）
v-cli unity doctor <project>

# Figma -> Unity UGUI staging Prefab（仅 Windows，依赖 Vant Framework）
v-cli agent docs figma                         # 首调必读
v-cli figma --help
v-cli figma config init --project C:/path/to/UnityProject
v-cli figma export <fileKey> --project C:/path/to/UnityProject
v-cli figma contract --project C:/path/to/UnityProject --allow-missing-ir   # 构建前（允许缺 IR）
v-cli figma unity install --project C:/path/to/UnityProject
v-cli figma build --project C:/path/to/UnityProject
v-cli figma contract --project C:/path/to/UnityProject                     # 构建后（完整校验）
```

`v-cli <插件命令> …` 的执行语义：插件在**子进程**中运行（stdio 继承），
`--json`/`--help`/`--`/插件自有选项一律**原样转发**给插件，v-cli 不解析、不改写插件输出。

## Examples

### 写一个本地插件

```js
// ~/.v-cli/commands/hello.mjs
export default {
  name: "hello",
  description: "示例插件",
  apiVersion: 1, // 插件契约版本（要求 v-cli >= 0.2），必填
  register(program, ctx) {
    program.action(() => ctx.log.result("hello world"));
  },
};
```

保存后立即生效：

```bash
v-cli hello           # hello world
v-cli plugin list     # [local] hello 已出现
```

> 缺少 `apiVersion: 1` 的插件会被拒绝并给出解释性错误，补上字段后重载即可。
> 本地插件不能占用内置命令名（`doctor`/`plugin`/`ts`/`agent`/`help`）或官方命令名（`xlmerge`/`unity`/`figma`/`ship`/`art`）。

### 在脚本中消费输出

```bash
v-cli ts 1710000000 --json | jq .seconds
v-cli --json ts 1710000000 | jq .seconds   # 前置全局 --json 同样生效
```

## `--json` 语义

- **前置全局**：`v-cli --json <cmd> …` —— `--json` 出现在首个命令词之前时被 v-cli 消费，`ctx.json` 为真
- **命令自有**：`<cmd> --json …` —— 属于该命令：内置命令（`ts`、`doctor`、`plugin list`、`agent index`、`agent describe`、`agent docs`、`agent init`）各自声明 `--json` 并消费；官方插件命令则**原样转发**给插件
- 其他中间位置（如 `v-cli plugin --json list`）不承诺 JSON 输出
- 插件转发示例：`v-cli xlmerge detect --json` 会把 `--json` 转给 xlmerge；`v-cli --json xlmerge detect` 则消费掉全局 `--json`、只转发 `detect`

## API

### 内置命令

| 命令 | 说明 |
| --- | --- |
| `v-cli doctor` | 环境体检：node/v-cli 版本、主目录、config 可写性、本地插件与官方插件状态 |
| `v-cli plugin list` | 列出全部命令（builtin/local/official 来源与状态） |
| `v-cli plugin path` | 打印本地插件目录 |
| `v-cli ts [value]` | 无参=当前时间；数字（秒/毫秒自动识别）=转可读时间；日期串=转时间戳 |
| `v-cli agent index [--json]` | 全部命令的 agent 索引（builtin/local/official，含元数据状态） |
| `v-cli agent describe <name> [--json]` | 单个命令的完整记录；未找到时 stderr 报错并退出 1 |
| `v-cli agent docs [--json]` | 输出当前包内置 AGENTS.md 原文；`--json` 输出 `{ package, version, sha256, content }`；缺失时退出 1 |
| `v-cli agent init [directory] [--force] [--dry-run] [--json]` | 把内置 AGENTS.md 写入目录（默认 cwd）；已存在默认拒绝退出 1，`--force` 原子覆盖，`--dry-run` 只报告 |

### 插件契约 `CliCommand`（apiVersion 1）

```ts
interface CliCommand {
  name: string;                                    // 子命令名
  description: string;
  apiVersion: 1;                                   // 插件契约版本，必填（要求 v-cli >= 0.2）
  hidden?: boolean;
  agent?: {                                        // agent 索引元数据（可选）
    whenToUse?: string;                            // 什么场景该调用
    globalOptions?: { flags: string; description: string }[];
    commands?: { path: string[]; description: string; usage?: string }[];
  };
  register(program: Command, ctx: CliContext): void;
}

interface CliContext {
  log: Logger;        // result() 走 stdout，info/warn/error 走 stderr
  config: ConfigStore; // <home>/config.json 惰性读写
  json: boolean;      // 全局 --json 开关（来自前置段扫描），命令必须尊重
  homeDir: string;    // 主目录（默认 ~/.v-cli）
}
```

#### 官方插件注入的环境变量

| 变量 | 值 | 说明 |
| --- | --- | --- |
| `V_CLI_HOST_VERSION` | v-cli 版本 | 插件可据此判断宿主能力 |
| `V_CLI_PLUGIN_API` | `1` | 插件契约版本 |
| `V_CLI_INVOKED_BY` | `v-cli` | 标识本次调用来自 v-cli |

#### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `V_CLI_HOME` | `~/.v-cli` | 覆盖主目录（配置、本地插件都从这里找） |
| `V_CLI_PLUGIN_RESOLVE_FROM` | — | 测试/开发钩子：官方插件从 `<值>/node_modules/{包}` 解析 |

## 官方插件清单契约

- 每个官方插件包内包含 `v-cli.plugin.json`（`package.json` 的 `vCli.manifest` 可指向其他文件名）
- 清单 schema 见 `schemas/v-cli-plugin.schema.json`（`schemaVersion: 1`）；v-cli 内置等价校验器
- 身份校验：清单 `package`/`bin` 必须与包的 `package.json` 一致；`bin` 目标必须是字符串、解析后位于包目录内、且文件存在，否则视为 `invalid`/`missing` 并拒绝路由
- 平台门禁：`platforms` 不含当前平台时拒绝路由（如 `unity` 仅 `win32`）

## 仓库工具脚本

```bash
npm run generate:agents   # 默认从【已安装的官方依赖】确定性生成 AGENTS.md
npm run check:agents      # AGENTS.md 漂移检查（默认与已安装依赖比对；不一致时非零退出）
npm run pack:guard        # 发布内容护栏：身份/必需文件/禁止内容/依赖精确固定/engines
npm run test:package      # 发布后安装冒烟：npm pack → 隔离 prefix 全局安装 → 运行 bin wrapper 断言
npm run check             # build + typecheck + test + check:agents + pack:guard
```

> 发版除 `npm version` 外，还需同步全仓版本断言（`grep -rn 旧版本号 tests/ scripts/ src/` 应为零，含 pack-guard 依赖精确固定与 smoke 的插件版本期望），再打 tag。

> `@kevlns/xlmerge@2.0.1` / `@kevlns/u-cli-mod@0.2.4` / `@kevlns/figma-to-uprefab@0.1.2` 随 `npm install` 装入仓库
> node_modules，`check:agents` 的 installed-deps 检查即为最终形态；预发布阶段需要以本地
> 清单 bootstrap 时显式传 `--manifest <path>`。

## Package family

kevlns 工具家族共享同一套发布约定（tag 驱动、CI 护栏、MIT）。

| Package | Purpose | Version |
| --- | --- | --- |
| [`v-cli`](https://github.com/kevlns/v-cli) | 个人工具箱 CLI（本仓库） | v0.2.16 |
| [`xlmerge`](https://github.com/kevlns/xlmerge) | Git 中 .xlsx/.xlsm 冲突可视化解决工具 | v2.0.1 |
| [`u-cli-mod`](https://github.com/kevlns/u-cli-mod) | Unity 精确版本路由 + CLI + pipeline 包（Windows-first） | v0.2.4 |
| [`figma-to-uprefab`](https://github.com/kevlns/figma-to-uprefab) | Figma 导出、契约校验与 Unity UGUI staging Prefab 构建 | v0.1.2 |

## Compatibility

| Runtime | Supported versions |
| --- | --- |
| Node.js | `20` and later |
| TypeScript | `5.6` and later（仅开发时） |

CLI 核心逻辑以单文件 ESM（`dist/cli.mjs`）分发，运行时依赖 `commander` 与五个官方插件包
（`@kevlns/xlmerge`、`@kevlns/u-cli-mod`、`@kevlns/figma-to-uprefab`，均为精确固定版本；安装 v-cli 时一起安装，
未装时 `plugin list`/`doctor`/`agent index` 会如实报告 `missing` 状态）。

## Contributing

```bash
git clone https://github.com/kevlns/v-cli.git
cd v-cli
npm install
npm run check
```

For bugs and feature requests, use
[GitHub Issues](https://github.com/kevlns/v-cli/issues).

## License

Released under the [MIT License](./LICENSE).

<div align="center">

Part of the **kevlns** tool family.

</div>
# ship 官方插件

`ship` 已加入官方插件白名单，`@kevlns/ship-cli@0.1.1` 为随包官方依赖。将 ship-cli 安装到与 v-cli 相同的 npm prefix 后自动发现；发布后随 v-cli 安装，不需要本地插件注册。

```bash
v-cli plugin list --json
v-cli agent docs ship
v-cli agent describe ship --json
v-cli ship doctor --json
v-cli ship wx validate --json
v-cli ship wx push --version 1.0.0 --json
```

缺失时会显示 missing。完整 Steam / 微信小游戏流程以 ship 的随包规范为准。隔离接入验证：`npm run test:package`，覆盖五个官方依赖的安装、发现、清单、规范哈希与真实子进程路由。

# 美术工坊官方插件 art

`@kevlns/art-workshop@0.1.2` 随 v-cli 安装，自动发现为 `art`。先读 `v-cli agent docs art`，用 `v-cli agent describe art --json` 查看完整参数，再用 `v-cli art config show` 与 `v-cli art agent index` 选择正确工程。风格分析与冻结用 `v-cli art style`，文生图用 `v-cli art generate`，图编辑用 `v-cli art edit`。参数与独立工具一致；本地配置、冻结核心及全部外部资源路径一致。`v-cli art --help` 与 `v-cli art agent docs` 提供入口和完整规范。
