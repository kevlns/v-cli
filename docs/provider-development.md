# Vant Provider 扩展与维护

## 定位

Provider 扩展与维护，适用于当前随包实现。

## 前置条件

先按包的环境要求准备工程与工具，使用实际配置和命令帮助核对目标。

## 操作流程

### 新增结构化 Provider

1. 在 src/providers 下实现独立模块，声明稳定 provider ID、版本、binding schema/pathFields/resolve，可按需提供 defaultBinding。
2. 声明 capability 输入输出 schema、前置条件、副作用、资源和重试策略。核心不导入业务 provider；只在 src/default-registry.ts 装配。
3. 用受控 ProcessExecutor 调工具，协议解析保持纯函数；无法解释的状态显式 unknown。不要通过解析展示文案猜身份。
4. 异步启动只使用真实后端 taskId；查询/取消校验完整原 handle。后端不提供身份时明确受限，不伪造 ID。
5. 若需公开 SDK，更新 src/sdk.ts 出口；不要求调用方访问内部模块。
6. 更新 README、随包 skill、AGENTS 生成源及相关测试，最后重新生成 AGENTS。

资源声明不是租约；授权通过 authorize 注入。新增 provider 不可修改核心来硬编码其绑定字段或任务模式。提供自定义 providers 数组时默认装配完全替换，测试不得假设隐式存在其他 provider。

### 新增官方命令插件

官方路由和结构化 provider 分开接入。路由需白名单、依赖/lock、合法 v-cli.plugin.json、包 bin 与平台校验，元数据与实际工具一致。修改清单后 generate:agents，再 check:agents 检查实际解析结果。

官方子进程继承 stdio，v-cli 不改写业务输出。插件缺失明确 missing，不在执行时自动安装。结构化协议需要独立包装，不能把增加路由当作 capability 已实现。

### 文档职责

README 提供用户路径，AGENTS/skill 给调用规范，当前四份规范解释架构、身份、协议与扩展。命令清单不抄进多份手工参数表；实际版本以包与 live 发现为准。

art 的型号目录、参数与限制只由 art 工具维护；v-cli 仅说明路由、绑定和句柄边界。不能以模型名硬编码筛选或请求，也不能把 Token Plan 渠道当作协议。

### 验证门槛

运行 npm run docs:check、npm run check；改包内容或依赖后再运行 npm run test:package。测试覆盖注册拒绝、配置/路径安全、缺绑定、协议未知、句柄伪造和错工程、旧任务误取消、operation 唯一性及原证据保留。

包验证应覆盖发现、manifest/AGENTS 哈希、真实子进程路由与 SDK 导入。真实引擎、联网导出、付费模型和平台发布只在明确授权范围执行，报告区分单元、mock、离线插件、包安装与业务验证。

测试数量、开发联接和一次性审查记录不写成长期接口保证。版本升级后使用实际安装依赖生成文档；源码修改和本地构建不代表 npm 或桌面版已更新。

## 结果验证

结合原始错误、结构化结果和实际产物核验；测试与真实平台执行分别记录。

## 参考资料

[使用说明](../README.md)
