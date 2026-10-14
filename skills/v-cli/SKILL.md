---
name: v-cli
description: 使用 v-cli 发现和执行工程能力，路由 Unity、Figma、配置表冲突、游戏交付与美术工坊工具。
---

# v-cli 调用规范

## 发现与职责

先 v-cli doctor、v-cli agent index --json，再对目标执行 agent describe。官方插件首调必须先 v-cli agent docs 命令名；当前版本、参数和平台以实时输出为准，不凭旧版本表猜测。

命令分 builtin/local/official。官方入口为 art、unity、figma、ship、xlmerge；结构化 provider 当前为 unity、figma、art。插件入口与 capability 不等价，不能假设所有插件都有结构化能力。插件原样消费参数和输出，v-cli 不改写业务 JSON。

用户的已有授权和偏好持续有效。描述、发现、校验与预演不自动授权生成、上传、定版、安装或发布；按实际任务授权执行，不重复询问已获授权的步骤。

## 工程绑定与执行

工程根用 --project 明确锚定；缺配置先 project init，操作前 describe 目标契约。配置 .vant/config/v-cli.json 只包含 CLI bindings；Vant 角色/workflow 属 .vant/config/project.json，v-cli 不读写。art 需显式 workspace/output/cache/projectId，不能猜 ID。

project init 默认只补有默认值的缺失段，保留已有值。--binding 修改已有段会被拒绝；有重置意图才用 --reset，旧配置先备份。--dry-run 不写入。绑定路径拒绝穿越、绝对覆盖和链接越界。

capability run 按 --input-file、--input、--set 顺序合并，后者覆盖同名值；输入文件路径以当前目录解析。不得在输入、文件、argv 和日志中传密钥。实际 Provider 凭据通过受控环境或凭据存储提供。

每次调用使用唯一 operationId，记录在工程 .vant/state/operations。查询也是新操作，不覆盖启动记录。--no-persist 只用于不依赖后续证据的探测，不应用于需要句柄恢复的生产启动。

## 生命周期与恢复

execution.status 是调用状态；execution.lifecycle 是后端六态 accepted/running/completed/failed/cancelled/unknown；acceptance.status 是 passed/failed/not-run。退出码 0/1/2/3/4/5 分别表示验收通过、失败、未执行、未验收、确认取消、未知。

异步 accepted 不是完成。按 followUp 和完整原 handle 查询；不能因超时或丢失回执重复提交。句柄通过原操作证据验证，完整性摘要不是签名，不能替代访问控制。缺证据、身份不符或 unknown_run 都不得回退最近任务。

Unity 关联能力为 compile-query、test-query、test-cancel-run；无参 compile-status/test-status 只是当前/最近观察。测试必须 completed、有非零有效报告且全部通过；缺报告、零用例、未知字段都不能报通过。

art.run-status/run-cancel/run-resume 使用原 handle。run-recover 仅按原 operation 找登记；run-resume 仅继续查询/下载，不补发生成。任务终态与停止证据独立，unknown/停止未确认保留占用；重试明确失败项也必须先确认原执行已停止。

## 各工具边界

| 工具 | 必须遵守 |
| --- | --- |
| art | 读取原对象和 revision；先 plan/dry，动态参考先分析；配置或引用变更重编译。模型登记归 art。只有生成和定版阶段，check 核验完整性；定版不自动集成或提交 |
| unity | 先 doctor，CLI valid、pipeline installed/current 才 exec；精确 Editor 路由，不改 ProjectVersion。只连接已打开的目标工程；目标 Editor 运行时安装限制不能擅自绕过 |
| figma | 结构化 doctor/contract 离线；托管配置不含 token。contract roots>0 才通过，空 staging 不算成功。输出限 staging，不自动迁正式资源或写 UIConfig |
| ship | 先读插件规范并核对平台；上传与发布分开，Steam 默认分支生效、微信审核/玩家发布不自动执行 |
| xlmerge | detect 后按整批 launch；有人工项给用户 URL，停止分析单元格或代选 ours/theirs。无人工项可按既有过滤规则处理；新增 autoTheirs 需用户明确要求，禁止擅自 push |

Unity exec 不传任何 --project-path 变体，目标由绑定决定。安装为事务操作，不手删 Packages/com.unity.pipeline 或 Library/editor-pipeline-cli。异步全量测试触发后轮询，不重复启动；编译/Console/测试以真实目标 Editor 为准。

xlmerge 正常交互不使用阻塞式 resolve；无头 prepare/apply 仅限自动测试或明确决策 JSON。只处理单文件时才限制 --path；多文件不逐个循环。未经明确请求不 push。

## 文档与技能同步

随包 AGENTS.md 和技能为调用规范源。需要装配时先在目标工程根运行 agent init --dry-run --json；已有 AGENTS.md 默认整体拒绝，不擅自 force。--force 覆盖 AGENTS 并完全同步技能，项目扩展写独立文件，不能修改随包技能求持久保留。

源码维护任务应核对实现、生成源与测试；日常调用以 live 元数据为准。模型请求合法、mock 通过、工具包可导入、引擎实际运行和已安装版本是不同证据，报告时分别说明。
