# Vant 执行身份与生命周期

## 定位

执行身份与生命周期，适用于当前随包实现。

## 前置条件

先按包的环境要求准备工程与工具，使用实际配置和命令帮助核对目标。

## 字段与示例

### 三种状态

| 维度 | 取值 | 含义 |
| --- | --- | --- |
| execution.status | succeeded/failed/cancelled/unknown | 本次工具调用 |
| execution.lifecycle | accepted/running/completed/failed/cancelled/unknown | 后端业务任务 |
| acceptance.status | passed/failed/not-run | 业务判定 |

accepted 和 unknown 不能伪装业务通过。调用退出、任务终态与副作用已停止三者分别核实；取消工具进程不等于云端取消。退出码由最终结果统一映射，详见 README。

### 身份矩阵

| 能力 | 身份 | 控制入口及限制 |
| --- | --- | --- |
| Unity compile | Pipeline 返回的 runId | compile-query 关联原 runId；无身份拒绝，不回退当前槽位 |
| Unity test-start | Pipeline 返回的 runId | test-query/test-cancel-run 关联；unknown_run 表示关联失效 |
| Unity compile-status/test-status/test-cancel | 当前或最近槽位 | 观察或全局取消语义，不用于证明原句柄完成 |
| art 分析/生图 | 工具 taskId，启动 operationId 可查原登记 | run-status/run-cancel/run-resume 输入原 handle；run-recover 找唯一原登记 |
| art 部署 | deploymentId 与稳定 operation | deployment-status/cancel/recover 查询原身份，禁止重复安装 |
| Figma doctor/contract | 本次同步调用 operationId | 无后台句柄，不编造任务身份 |

operationId 是 v-cli 调用身份，不是后端 taskId；配置对象 ID 也不是执行 ID。显示标题、时间戳和文件路径不能替代后端身份。

### 句柄验证

内核从启动结果生成可序列化 handle，Provider 只提供真实 backendTaskId 种子。查询、取消和恢复前验证句柄版本、形状、工程/绑定、provider/能力关系、完整性摘要以及原 operation/result.json 中的证据一致性。

摘要用于发现截断或误改，不是签名。无证据、错误工程、未知键、原记录不符或 backendTaskId 缺失不能退化为最近任务。每次控制调用是新的 operationId，只读原启动证据。

Unity runId 要求匹配实际路由及工程适配包。命令层单槽位仍可能被新任务或引擎编译顶替；旧句柄收到 unknown_run，不采信新报告。HTTP 内存 jobId 不能替代跨 domain reload 的命令层 runId。

### art 停止与恢复

art 的 queued/running/cancelling 占用对象；failed/cancelled 只有停止证据完整才释放。unknown、unsettled、promptId、remoteCancellation 或 dispatching/accepted 远程回执都阻止判为空闲。

远程回执先持久化 dispatching 再提交，先 accepted+taskId 再查询，先 completed+urls 再下载。task resume 只恢复 accepted/completed 的原身份，不发生成 POST、不补发未提交项；无上游 ID 的 dispatching 保持未知。

恢复原运行、重试明确失败项、重新编辑配置产生的新批次是三种不同操作。成功项不重跑，上游完成待下载项走原结果取回；配置变化需重新预演。准确行为由 art 随包规范和当前实现负责。

### 关联与业务结论

测试只有 completed、非零有效报告且全过才通过。编译终态还需无错误证据。已关联只能证明属于原任务，不能取代业务验收；业务通过也不证明其他后台资源已停止。

应用退出是组织层生命周期：关闭其所有权下的后台任务及服务，并验证端口释放；v-cli 调用层不具备跨应用进程清理语义。

## 执行边界

字段、路径与权限以当前 schema、运行时校验和明确授权为准；配置有效不等于外部服务已执行成功。

## 结果验证

结合原始错误、结构化结果和实际产物核验；测试与真实平台执行分别记录。

## 参考资料

[使用说明](../README.md)
