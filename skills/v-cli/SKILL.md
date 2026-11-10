---
name: v-cli
description: 发现项目工具及技能，读取能力契约并执行结构化操作。
---

# Vant 工具入口

先用 agent index、agent skills 和 capability describe 了解当前可用工具；操作约束按需读取 references/project.md 及目标工具的声明技能。命令参数以 describe 为准，不把仓库 AGENTS.md 当运行时规范。

项目初始化使用 project init；skill 随受管包发布，由 Vant 统一分发。默认安装不扫描或改写外部 Agent。失败保留明确状态，不循环重试；未知写入仅查询原执行身份，不能换 ID 重投。
