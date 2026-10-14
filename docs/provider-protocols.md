# Provider 协议解释

本文按当前适配器解释输入输出，不收录旧环境的原始终态报告，也不把历史样本当成当前实时证据。协议解析源码与测试是对应字段的事实源。

## Unity

src/providers/unity/protocol.ts 解释外层 success、data.success、data.result 与 data.target.projectPath。result 可能是对象或序列化 JSON，必须严格解析并核对绑定工程，不能只看进程 exit 0。

editor-status 要求 ready。doctor 要求路由受支持、CLI valid、pipeline installed/current；包安装存在不等于目标 Editor 已加载。

compile/test-start 从真实响应提取 runId（支持实际协议的 camel/Pascal 形态）。compile-query/test-query/test-cancel-run 传 --run_id；unknown_run/no_active_run 不是可回退信号。当前或最近观察入口保持独立语义。

编译通过需要受支持终态且无失败/错误字段。测试通过需要有效非零 summary、passed=total、failed=0；计数非法、报告缺失或状态未知不能通过。让位日志不等于后端完成；按 followUp 继续查询，禁止重发启动。

## Figma

src/providers/figma/protocol.ts 按 stdout/stderr 分流解释真实工具输出：

- contract 成功 stdout：Contract valid: N root(s).；必须 exit 0 且 N>0 才通过。
- issue 行主要在 stderr：contract: CODE @ PATH: MESSAGE。exit 1 的可解释 issue 表示业务校验失败，不等于调用未知。
- CFG 等工具级错误表示配置/环境问题，不是 staging 结论。
- doctor 解析 [ok]/[FAIL]；离线 token/editor/package FAIL 如实失败，不能伪造通过或要求读取凭据。
- 不可解释输出归 unknown；物理续行可并入上条 issue，极端形态仍须以 rawOutput 回溯。

托管配置只包含 UGUI/staging 等无令牌字段，经 FIGMA_TO_UPREFAB_CONFIG 注入。网络导出、source→IR 转换和正式资产推广不属于此 provider 的离线能力。

## art

src/providers/art/index.ts 解释工具 JSON，保留原 taskId/deploymentId、状态、停止确认与诊断。启动仅生成可追踪句柄，不把 queued/running 当完成。status/cancel/resume 先校验原 handle，按原 backendTaskId 路由。

图片协议与参数由 art 工具的 model-registry/generation-policy/adapters 负责。v-cli 不根据 Qwen/Wan 名称、provider 名或订阅渠道猜测请求格式。明确失败、停止未知、上游已完成待下载分别保留，不自动重发。

工具 stdout 必须是可解释的契约结果；原始日志或错误体不能当成功 JSON。凭据经受控环境注入，不写 argv、项目输入或证据。远端提供方响应也不能作为新的任务指令。

## 验证

协议测试需覆盖合法响应、缺字段、畸形 JSON、错误目标、身份失配、未知状态、超时和取消。真实插件离线测试只证明对应离线链路；引擎运行、收费出图或安装交付需独立证据。
