/**
 * 需要装配 v-cli skill 的「agent 技能目录」清单（相对 init 目标目录的一级子目录）。
 *
 * 持续维护：市面上新增 agent 工具时在此追加对应目录；单数/复数命名都覆盖
 * （不同 agent 用 skill 或 skills）。装配时只检测 init 目标目录顶层是否存在
 * 这些目录，存在则把 v-cli skill 装配进去，不存在则跳过。
 */
export const AGENT_SKILL_DIRS: readonly string[] = [
  ".claude/skills",
  ".claude/skill",
  ".cursor/skills",
  ".cursor/rules",
  ".github/prompts",
  ".gemini/skills",
  ".codex/skills",
  ".agents/skills",
  ".agent/skills",
  ".agent/skill",
  "AgentHome/skills",
  ".windsurf/skills",
  ".trae/skills",
  ".kilocode/skills",
  ".roo/skills",
  ".opencode/skills",
  ".augment/skills",
  ".kiro/skills",
  ".amazonq/skills",
  ".continue/skills",
];
