---
name: v-cli
description: 发现项目工具及技能，读取能力契约并执行结构化操作。
---

# Vant 工具入口

在 Vant 会话的 shell 中，示例里的 `v-cli` 代表插件入口：PowerShell 写作 `node "$env:DSH_VANT_CLI"`，sh 写作 `node "$DSH_VANT_CLI"`。

已明确目标时直接选择 `art`、`unity`、`figma`、`ship` 或 `xlmerge`。操作和参数对照[随包命令](references/project.md)。需要结构化的操作证据时用 `capability run`，单项契约用 `capability describe <id>`。

项目初始化使用 `project init`，它按各工具清单将技能、参考资料和脚本同步到 Vant 的全局受管目录。按技能 ID 用 `agent docs` 读取单份指南。默认安装不扫描或改写外部 Agent。失败保留明确状态，不循环重试；未知写入仅查询原执行身份，不能换 ID 重投。

美术制作通过 `art image`、`art video` 和 `art spine` 选择通道。`art spine describe` 提供拆件、骨架编译与取帧的输入示例；相同操作也可使用 `capability run art.spine-<操作>`。
