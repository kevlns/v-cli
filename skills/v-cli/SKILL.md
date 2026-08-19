---
name: v-cli
description: >
  使用 kevlns 的个人工具箱 CLI（v-cli）处理配置表冲突与 Unity 工程精确版本工具链。当任务提到 v-cli、xlmerge、
  unity 命令、配置表 .xlsx/.xlsm Git 冲突处理、Unity CLI 安装、Unity 工程诊断/体检（doctor）、
  com.unity.pipeline 适配包安装时使用本 skill。
---

# v-cli 使用规范

## 工具概述

- `@kevlns/v-cli` 是 npm 全局安装的个人工具箱 CLI（当前 0.2.0-beta.x），插件化架构。
- 命令分三类：
  - **builtin**（内置）：`doctor`（环境体检）、`plugin list/path`（插件管理）、`ts`（时间戳互转）、`agent index/describe/docs/init`（agent 引导）。
  - **local**：`~/.v-cli/commands/` 下的本地插件（本项目未使用）。
  - **official**（官方插件，经 v-cli 路由）：`xlmerge`、`unity`。
- 环境要求：Node.js >= 20（仅 Windows 主机可使用 `unity` 插件，其他平台 v-cli 拒绝路由）。

## 能力发现协议（核心规则，必须遵守）

**一切能力、参数、用法以 v-cli 自己的 agent 命令输出为准，严禁无头搜索 npm 安装目录、源码或 README 猜测用法。**

- `v-cli agent docs` — 输出 v-cli 内置 AGENTS.md（宿主规范全文；`--json` 含 sha256/content）。
- `v-cli agent index --json` — 枚举全部命令（builtin/local/official）与 agent 元数据，获取最新命令集合。
- `v-cli agent describe <命令名> --json` — 单个命令的完整记录：用法、参数、选项、输出格式、退出码、安全标签。
- `v-cli agent docs <命令名>` — 输出官方插件包内 AGENTS.md（该插件的使用规范正本）。
- `v-cli agent init .` — 可选：把内置 AGENTS.md 写入工作区（已存在默认拒绝，`--force` 覆盖，`--dry-run` 预览）。
- live 命令集合以实际发现为准：先 `agent index --json`，再对目标命令 `agent describe <命令> --json`。

## 首调规范

**首次调用任何 official 插件命令（`v-cli xlmerge …`、`v-cli unity …`）前，必须先运行 `v-cli agent docs <命令名>` 读取该插件包内的 AGENTS.md 规范正本。** 使用规范、快速流程与禁止事项以插件自身 AGENTS.md 为准。

官方插件命令在子进程中运行（stdio 继承）：v-cli 只做路由，不解析、不改写插件输出；插件 `--help`/`--json` 等参数由插件自己消费。插件对 worktree 的写入/提交行为以插件清单的安全标签为准；**未经显式 flag 不得 push**。

## 官方插件一：xlmerge（跨平台）

Git 中 `.xlsx` / `.xlsm` 策划表/配置表冲突的可视化解决工具。

- 流程：
  1. `v-cli xlmerge --repo <仓库路径> detect` — 检测冲突。
  2. 冲突数 > 0 时运行 `launch`，**把返回的 URL 交给用户在本地 UI 处理**。
- **agent 不得自行检查工作簿单元格、不得自己总结 diff**：resolver 拥有 diff、选择、写回与提交。
- 用户要求「解决配置表冲突」时：先 detect；count > 0 时 launch 并给出 URL。

## 官方插件二：unity（仅 win32）

Unity 2022 工程**精确版本路由**（版本号 + revision 双重匹配）+ 下载经验证的 Unity CLI（SHA-256 + Authenticode）+ 事务式安装适配版 `com.unity.pipeline` 包。

### 核心命令

| 命令 | 说明 |
|---|---|
| `v-cli unity doctor <project>` | 只读体检：路由匹配 / CLI 状态 / Pipeline 状态 / 运行中的 Unity 进程 / 支持版本列表 |
| `v-cli unity setup <project>` | CLI + 适配包一键就绪（**推荐首次入口**，等价 cli install + pipeline install；`--dry-run` 预览、`--skip-cli` 跳过下载） |
| `v-cli unity pipeline install <project>` | 事务式安装适配包（staging → 校验 → 备份 → 替换 → 再校验 → receipt，失败自动回滚；`--dry-run` 只预览不写入） |
| `v-cli unity cli install` | 下载并校验固定版本 Unity CLI（`--editor <版本>` 限定、`--force` 重下） |
| `v-cli unity exec <project> -- <unity-cli-args>` | 调用路由 CLI 执行 Unity Pipeline 命令 |
| `v-cli unity routes` | 列出所有已配置的 Editor 精确路由（`-e <版本>` 过滤） |
| `v-cli unity cache clean` | 清理下载缓存与生成的适配包（`--all` 连 CLI 缓存一起清） |

### 关键规则（违反即报错或导致损坏，必须遵守）

1. **exec 前必须 doctor 通过且适配包已安装**（setup 或 pipeline install 已完成）；未就绪时先跑 setup，不要直接 exec。
2. **禁止在 exec 参数中传入任何 `--project-path` 变体**（`-projectPath`、`--project_path`、大小写混合、`=` 形式等）：目标工程由工具统一绑定，exec 会拒绝所有变体并把解析后的 `--project-path` 作为最后一个参数附加；`--` 分隔符被包装器消费，不转发给 Unity CLI。
3. **运行中的 Unity Editor 是 fail-closed**：安装被阻止时引导用户先关闭目标工程的 Editor；**除非用户显式要求，不得使用 `--allow-running-editor` 绕过**。
4. **安装是事务式的**：不要手动清理工程内 `Packages/com.unity.pipeline` 或 `Library/editor-pipeline-cli`；失败会自动回滚，人为清理会破坏回滚与 receipt 校验。
5. **版本路由是精确匹配**（`m_EditorVersion` + revision 同时一致），无"就近版本"回退；工程版本不在路由表内时如实报告支持列表（`doctor` 输出的 `supportedVersions`），不得猜测、不得改写 `ProjectVersion.txt`。
6. **exec 每次调用前都会重新校验 CLI 哈希**（防篡改，属正常行为）；校验失败按提示 `v-cli unity cli install --force` 修复即可。

## 典型流程

```bash
v-cli agent docs unity                                    # 首调前必读插件规范正本
v-cli unity doctor <project>                              # 1. 体检（只读）
v-cli unity setup <project> --dry-run                     # 2.（可选）先预览
v-cli unity setup <project>                               # 3. 就绪（CLI + 适配包）
v-cli unity exec <project> -- command editor_status       # 4. 执行 Pipeline 命令
```