import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createDefaultRegistry } from "../src/default-registry";
import { capabilityCoverage } from "../src/capability-coverage";
import { PIPELINE_COMMANDS } from "../src/providers/unity/catalog";

describe("官方工具覆盖护栏", () => {
  it("所有公开命令均明确关联 capability", () => {
    const report = capabilityCoverage(createDefaultRegistry());
    expect(report.providers).toHaveLength(5);
    for (const provider of report.providers)
      expect(provider.missing, provider.provider).toEqual([]);
    expect(report.ok).toBe(true);
  });
  it("Unity 通用工具目录与固定 npm 后端完全一致，专用编译和测试入口不被绕过", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(
          process.cwd(),
          "node_modules/@kevlns/u-cli-mod/v-cli.plugin.json",
        ),
        "utf8",
      ),
    );
    const tools = Object.fromEntries(
      manifest.agent.pipelineCommands.flatMap(
        (group: { tools: Record<string, string> }) =>
          Object.entries(group.tools),
      ),
    );
    expect(PIPELINE_COMMANDS).toEqual(tools);
    const descriptor = createDefaultRegistry().describe("unity.command")!;
    const names = (
      descriptor.inputSchema as unknown as {
        properties: { command: { enum: string[] } };
      }
    ).properties.command.enum;
    expect(names).not.toContain("run_tests");
    expect(names).not.toContain("recompile");
    expect(names.length + 6).toBe(Object.keys(tools).length);
  });
});
