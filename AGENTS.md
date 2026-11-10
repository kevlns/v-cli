# Vant 工具入口开发规范

## 定位

维护 v-cli 的发现、路由、能力契约和操作证据。业务实现归各独立插件。

## 调用流程

先阅读相关源文件，使用 package.json 中的 build、typecheck、test 和 check 检查。

## 调用规范

运行时入口为 skills/v-cli/SKILL.md，工具机器声明为 v-cli.plugin.json。scripts/generate-agents.mjs 生成 references/project.md，不从开发规范生成模型指令。项目设置、状态与外部宿主导出分别管理，不在安装或默认初始化时扫描外部 Agent 目录。

## 结果验证

区分源码、模拟、真实工具与发布证据。保留其他工作区改动。

## 参考资料

[使用说明](README.md) · [运行技能](skills/v-cli/SKILL.md)

## 许可与版权

MIT。Copyright © 2026 Vant。
