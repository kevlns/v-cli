<div align="center">

<img src="https://raw.githubusercontent.com/kevlns/v-cli/main/logo.png" alt="v-cli logo" width="320" />

# v-cli

**kevlns 的个人工具箱 CLI：插件化架构，内置命令随版本发布，本地插件放目录即生效。**

[![npm version](https://img.shields.io/npm/v/%40kevlns%2Fv-cli?style=flat-square&color=cb3837)](https://www.npmjs.com/package/@kevlns/v-cli)
[![npm downloads](https://img.shields.io/npm/dm/%40kevlns%2Fv-cli?style=flat-square&color=4c8bf5)](https://www.npmjs.com/package/@kevlns/v-cli)
[![CI](https://img.shields.io/github/actions/workflow/status/kevlns/v-cli/test.yml?branch=main&style=flat-square&label=CI)](https://github.com/kevlns/v-cli/actions/workflows/test.yml)
[![license](https://img.shields.io/github/license/kevlns/v-cli?style=flat-square&color=2e8b57)](./LICENSE)

[Getting started](#getting-started) · [API](#api) · [Examples](#examples) · [Package family](#package-family)

</div>

---

## Why v-cli?

v-cli 让你**用一个命令沉淀所有个人小工具**，而不用为每个工具建仓库、发包、记命令。
它被设计为**依赖极少、秒级启动、写个文件就能扩展**，与 kevlns 工具家族的其余部分可自由组合。

- **插件化架构** - 内置命令走注册表随版本发布；本地插件放进 `~/.v-cli/commands/` 立即生效，无需发版
- **官方插件白名单** - `@kevlns/xlmerge`（`xlmerge`）与 `@kevlns/u-cli-mod`（`unity`）是唯一被路由的官方插件，安装后在子进程中运行
- **容错加载** - 单个插件语法错误、契约不符或注册异常只会被跳过并报告，绝不阻断其他命令
- **双通道输出** - 结果走 stdout（可管道、可脚本化），诊断走 stderr
- **agent 友好** - `agent docs`/`agent init` 让 AI Agent 自举读取引导文档；`agent index/describe` 输出统一索引与完整元数据；仓库内 AGENTS.md 自动生成并有漂移检查
- **TypeScript-first** - 严格类型编写，tsup 将核心逻辑打包为单文件 ESM，仅保留 `commander` 运行依赖

## Getting started

### Install

```bash
# 正式版直接安装
npm install -g @kevlns/v-cli

# 或直接从 GitHub 仓库安装开发版本
npm install -g git+https://github.com/kevlns/v-cli.git
```

需要 Node.js **>= 20**。

### Quick start

```bash
v-cli doctor          # 环境体检：node/版本、主目录、配置、官方/本地插件状态
v-cli plugin list     # 列出内置命令、本地插件与官方插件状态
v-cli ts 1710000000   # 时间戳互转
v-cli agent docs      # 输出当前安装包内置 AGENTS.md 原文（AI Agent 引导文档）
v-cli agent index     # 命令 + agent 元数据索引（--json 输出机器可读）
v-cli agent describe xlmerge --json
v-cli agent init .    # （可选）把 AGENTS.md 初始化到当前目录
```

### AI Agent 快速开始

v-cli 内置 AGENTS.md 随包发布，AI Agent 可自行发现并读取引导文档，无需人工粘贴：

```bash
v-cli agent docs                    # 读当前包内置 AGENTS.md 原文（--json 拿 package/version/sha256/content）
v-cli agent index --json            # 枚举全部命令 + 元数据（builtin/local/official，live 发现）
v-cli agent describe <name> --json  # 单命令：用法/参数/选项/输出/退出码/安全标签
v-cli agent init .                  # （可选）把 AGENTS.md 写入工作区，AI Agent 自动读取
```

`agent docs` 文本模式逐字节输出内置 AGENTS.md，`--json` 输出稳定对象
`{ package, version, sha256, content }`。

`agent init [directory]`（默认当前目录；目录必须已存在且为目录）：

- 已存在 AGENTS.md 时**默认拒绝并退出 1，绝不改动现有文件**（`--force` 才原子覆盖）；
- `--dry-run` 只报告目标与将执行的动作，不写入任何文件；
- 符号链接目标一律 fail-closed 拒绝（不跟随、不覆盖链接目标）；
- `--json` 输出稳定结果（`ok/dryRun/action/directory/target/sha256/bytes/…`）。

### 控制器命令（官方插件）

```bash
npm install -g @kevlns/xlmerge@1.2.1   # 安装后即可
v-cli xlmerge --repo <repo> detect            # 路由到 xlmerge 子进程
v-cli xlmerge --repo <repo> resolve

# Unity 工具链（仅 Windows 主机可用；其他平台 v-cli 会拒绝路由并说明原因）
npm install -g @kevlns/u-cli-mod@0.1.3
v-cli unity doctor <project>
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
  apiVersion: 1, // v-cli 0.2 起的插件契约版本，必填
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

> 旧版插件（无 `apiVersion: 1`）会被拒绝并给出解释性错误，请补上字段后重载。
> 本地插件不能占用内置命令名（`doctor`/`plugin`/`ts`/`agent`/`help`）或官方命令名（`xlmerge`/`unity`）。

### 在脚本中消费输出

```bash
v-cli ts 1710000000 --json | jq .seconds
v-cli --json ts 1710000000 | jq .seconds   # 前置全局 --json 同样生效
```

## `--json` 语义（v-cli 0.2）

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
  apiVersion: 1;                                   // v-cli 0.2 起必填
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

> `@kevlns/xlmerge@1.2.1` / `@kevlns/u-cli-mod@0.1.3` 已发布并由 `npm install`
> 装入仓库 node_modules：`generate:agents`/`check:agents` 的默认（installed-deps）检查即为
> 最终形态，`npm run check` 因此才能全绿，CI 的 `check:agents` 步骤也随之总是生效
> （不依赖 sibling 仓库检出；若未来仍需要在预发布阶段以 sibling 清单 bootstrap，
> 可显式传 `--manifest <path>`）。

## Package family

kevlns 工具家族共享同一套发布约定（tag 驱动、CI 护栏、MIT）。

| Package | Purpose | Status |
| --- | --- | --- |
| [`v-cli`](https://github.com/kevlns/v-cli) | 个人工具箱 CLI（本仓库） | v0.2.2 |
| [`xlmerge`](https://github.com/kevlns/xlmerge) | Git 中 .xlsx/.xlsm 冲突可视化解决工具 | v1.2.2 |
| [`u-cli-mod`](https://github.com/kevlns/u-cli-mod) | Unity 精确版本路由 + CLI + pipeline 包（Windows-first） | v0.1.3 |

## Compatibility

| Runtime | Supported versions |
| --- | --- |
| Node.js | `20` and later |
| TypeScript | `5.6` and later（仅开发时） |

CLI 核心逻辑以单文件 ESM（`dist/cli.mjs`）分发，运行时依赖 `commander` 与两个官方插件包
（`@kevlns/xlmerge`、`@kevlns/u-cli-mod`，均为精确固定版本；安装 v-cli 时一起安装，
未装时 `plugin list`/`doctor`/`agent index` 会诚实报告 `missing` 状态）。

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
