# vcli

kevlns 的个人工具箱 CLI。TypeScript + Node，插件化架构：内置命令随版本发布，本地插件放目录即生效。

## 安装

```bash
npm install -g git+https://github.com/kevlns/vcli.git
# 发布 npm 后
npm install -g vcli
```

要求：Node.js >= 18。无其他运行时依赖（commander 已打包进单文件产物）。

## 使用

```bash
# 环境体检
vcli doctor

# 列出所有命令（内置 + 本地插件）
vcli plugin list

# 时间戳工具：当前时间 / 时间戳转可读 / 日期串转时间戳
vcli ts
vcli ts 1710000000
vcli ts "2024-03-09 16:00:00"

# 全局 --json 开关（任意位置），输出机器可读 JSON
vcli doctor --json
vcli ts 1710000000 --json
```

## 架构

```
src/
├── cli.ts            # 入口：组装 context -> 加载命令 -> commander 分发
├── core/
│   ├── command.ts    # CliCommand 契约（插件接口）
│   ├── context.ts    # CliContext：log/config/json/homeDir
│   ├── logger.ts     # 双通道：结果 stdout（可管道），诊断 stderr
│   ├── config.ts     # 用户配置 <home>/config.json 惰性读写
│   └── loader.ts     # 命令加载：内置注册表 + 本地插件扫描
├── commands/         # 内置命令（index.ts 为注册表）
└── version.ts
```

- 命令主目录默认 `~/.vcli`，环境变量 `VCLI_HOME` 可覆盖
- 所有命令通过 `ctx` 获得 logger/config，行为全局一致；`--json` 由契约保证

## 本地插件

把 `.mjs` 文件放入 `~/.vcli/commands/` 立即生效，无需发版：

```js
// ~/.vcli/commands/hello.mjs
export default {
  name: "hello",
  description: "示例插件",
  register(program, ctx) {
    program.action(() => ctx.log.result("hello world"));
  },
};
```

形状校验：默认导出需含 `name`（字符串）、`description`（字符串）、`register`（函数）；不合规或语法错误的插件只会被跳过并在 `doctor` / `plugin list` 中报告，不影响其他命令。

## 开发

```bash
npm run build        # tsup 打包 dist/cli.mjs（ESM 单文件）
npm run typecheck    # tsc --noEmit
npm test             # vitest：单元 + 集成（自动先 build）
npm pack             # 本地打包验证
```

> 集成测试通过子进程运行真实 CLI，覆盖本地插件的动态 import 与坏插件降级。

## License

[MIT](LICENSE)
