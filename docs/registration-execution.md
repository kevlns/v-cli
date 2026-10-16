# Vant 注册与执行架构

## 定位

注册与执行架构，适用于当前随包实现。

## 前置条件

先按包的环境要求准备工程与工具，使用实际配置和命令帮助核对目标。

## 字段与示例

本规范描述当前实现，不维护阶段计划、审查轮次或旧测试数量。公开使用入口见 [README](../README.md)；能力、字段和版本以 live describe 与 src/sdk.ts 为准。

### 分层

| 层 | 实现与职责 |
| --- | --- |
| CLI | src/commands/capability.ts、project.ts：参数、输出、退出码 |
| SDK/内核 | src/sdk.ts、src/core/execution：注册、输入/输出验证、授权、前置条件、句柄和结果 |
| 工程层 | src/core/project：工程根、bindings、路径安全、操作证据与脱敏 |
| 装配 | src/default-registry.ts：装配 Unity、Figma、art；core 不 import providers |
| Provider | src/providers：绑定解析、受控工具调用、协议解释与证据 |

v-cli 是注册与执行基座，不提供任务队列、数据库、守护调度或跨进程资源租约。组织层通过 authorize 注入授权；没有钩子时明确 not-enforced。工具可自行拥有业务生命周期，例如 art 的后台任务与停止确认，不能据此声称 v-cli 内核统一调度这些任务。

### 注册与绑定

Capability 描述包含稳定命名空间 ID、版本、输入/输出 JSON Schema、前置条件、副作用、资源、重试语义及可选超时和标签。注册期拒绝重复 ID、非法 schema、描述不完整和前置条件实现缺失，不能部分注册。

Provider 自包含 binding.schema、pathFields、resolve 及可选 defaultBinding。核心重算声明路径并强核对 provider 返回值，拒绝夹带、遗漏和不一致路径。提供 providers 集合时完全替换默认装配，不隐式追加。

工程 .vant/config/v-cli.json 仅为 schemaVersion=1 和 bindings。缺失某 provider 段可以保留 unbound，已声明但非法或未知 provider 段使配置拒绝。角色、workflow 等组织字段不允许混入；Vant 项目配置不归 v-cli。

project init 不存在时创建，存在时仅补缺失默认段。已有段的键、值与键序保留，手写非规范格式可能被规范化；不是任意文件逐字节不动。显式 --binding 指向已有段拒绝；--reset 先备份再替换。dry-run 无写入。配置文件链接、绑定穿越和链接越界拒绝。

### 执行与证据

执行顺序：锚定工程 → 读取并验证绑定 → 校验输入 → 资源授权 → 前置条件 → 实现调用 → 校验输出与副作用 → 结果与记录。

进程调用使用受控 argv 和 shell:false。超时不能推断后端业务停止。内核单次尝试，retry 元数据不意味着自动重试；异步操作用原句柄查询，不重放启动。

默认操作证据在 .vant/state/operations/<operationId>：input.json、events.jsonl、stdout.log、stderr.log、result.json。operationId 已存在拒绝，--no-persist 无原证据可供后续回读。输入和 argv 做保守脱敏；工具 stdout/stderr 保留原文，工具必须自行避免输出密钥，不能声称日志得到全量秘密识别。

结果分开表达 execution.status、execution.lifecycle 与 acceptance.status。输出非法、无法解释或副作用违约不得验收通过。具体六态和句柄核对见 [身份规范](execution-identities.md)。

### Provider 边界

Unity 强制 doctor 就绪核对，使用绑定目标和真实 Pipeline 协议；观察状态与按 runId 关联控制分开。Figma 仅离线 doctor/contract，临时托管配置无凭据；art 复用工具自己的对象、预案、部署和执行状态，不复制模型目录或生成策略。

ship/xlmerge 属官方命令路由，当前不是结构化 provider。官方命令透传与结构化结果封装两条链路不能混同。

### 限制与验证

本地证据一致性不是签名或权限系统。组织层负责可信文件访问、授权和资源租约。配置补全不提供跨进程编辑事务；日志轮转和业务证据清理不由内核自动完成。

单元测试、真实插件离线测试、包隔离安装、Unity Editor、收费模型和平台发布是不同证据。每次改动使用适合的检查，不沿用历史成功次数冒充本轮验证。[协议解释](provider-protocols.md) · [扩展指南](provider-development.md)

## 执行边界

字段、路径与权限以当前 schema、运行时校验和明确授权为准；配置有效不等于外部服务已执行成功。

## 结果验证

结合原始错误、结构化结果和实际产物核验；测试与真实平台执行分别记录。

## 参考资料

[使用说明](../README.md)
