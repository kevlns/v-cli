import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { CapabilityRegistry } from "../src/core/execution/registry";
import { runCapability } from "../src/core/execution/runtime";
import { createShipProvider } from "../src/providers/ship";
import { createXlmergeProvider } from "../src/providers/xlmerge";
import { acquireResources } from "../src/core/execution/resource-locks";
import { FakeExecutor } from "./helpers/fake-executor";
import { fakeBackend, makeTempProject } from "./helpers/unity-fixtures";

const config = {
  schemaVersion: 1,
  bindings: { ship: { projectDir: "." }, xlmerge: { projectDir: "." } },
};
function setup(stdout: unknown) {
  const project = makeTempProject({ config, withProjectVersion: false });
  const executor = new FakeExecutor(() => ({ stdout: JSON.stringify(stdout) }));
  const registry = new CapabilityRegistry();
  registry.registerProvider(
    createShipProvider({
      executor,
      discoverBackend: () => fakeBackend({ name: "ship" }),
    }),
  );
  registry.registerProvider(
    createXlmergeProvider({
      executor,
      discoverBackend: () => fakeBackend({ name: "xlmerge" }),
    }),
  );
  return { project, executor, registry };
}
describe("分发和表格统一执行", () => {
  it("拒绝未知参数、非法机器人和默认发布分支，不启动后端并保存拒绝记录", async () => {
    const s = setup({ ok: true });
    try {
      for (const [capabilityId, input] of [
        ["ship.wx-push", { version: "1", robot: 31 }],
        ["ship.steam-push", { "set-live": "default" }],
        ["xlmerge.apply", { manifest: "x", decisions: "y", shell: "evil" }],
      ] as const) {
        const result = await runCapability(s.registry, {
          projectRoot: s.project.root,
          capabilityId,
          input,
        });
        expect(result.execution.attempts).toBe(0);
        expect(result.persisted.status).toBe("saved");
      }
      expect(s.executor.calls).toHaveLength(0);
    } finally {
      s.project.cleanup();
    }
  });
  it("明确的上传回执才可通过，退出零但结果不完整不能通过", async () => {
    const s = setup({
      ok: true,
      mode: "build",
      appId: 123,
      buildId: "456",
      logPath: "log",
    });
    try {
      const good = await runCapability(s.registry, {
        projectRoot: s.project.root,
        capabilityId: "ship.steam-push",
        input: { desc: "hello; $(no-shell)" },
      });
      expect(good.acceptance.status, JSON.stringify(good)).toBe("passed");
      expect(s.executor.calls[0].args).toContain("hello; $(no-shell)");
      const bad = setup({ ok: true });
      try {
        const r = await runCapability(bad.registry, {
          projectRoot: bad.project.root,
          capabilityId: "ship.steam-push",
        });
        expect(r.acceptance.status).not.toBe("passed");
      } finally {
        bad.project.cleanup();
      }
    } finally {
      s.project.cleanup();
    }
  });
  it("拒绝其他仓库清单、路径越界，不产生写入", async () => {
    const s = setup({ success: true });
    try {
      fs.writeFileSync(
        path.join(s.project.root, "manifest.json"),
        JSON.stringify({ repoRoot: path.dirname(s.project.root) }),
      );
      for (const manifest of ["manifest.json", "../manifest.json"]) {
        const r = await runCapability(s.registry, {
          projectRoot: s.project.root,
          capabilityId: "xlmerge.apply",
          input: { manifest, decisions: "decisions.json" },
        });
        expect(r.execution.attempts).toBe(0);
      }
      expect(s.executor.calls).toHaveLength(0);
    } finally {
      s.project.cleanup();
    }
  });
  it("表格检测结构化返回并记录真实受控命令和日志", async () => {
    const s = setup({ ok: true, count: 0, conflicts: [] });
    try {
      const r = await runCapability(s.registry, {
        projectRoot: s.project.root,
        capabilityId: "xlmerge.detect",
      });
      expect(r.acceptance.status, JSON.stringify(r)).toBe("passed");
      expect(r.invocation.command?.args).toContain("--repo");
      expect(r.invocation.command?.args.at(-1)).toBe("detect");
      expect(r.persisted.files).toContain("result.json");
    } finally {
      s.project.cleanup();
    }
  });
  it("共享读取可并行，写入与读取互斥，释放后可继续", async () => {
    const s = setup({ ok: true });
    const read = {
      kind: "project-workspace",
      mode: "shared",
      scope: "project",
      description: "read",
    } as const;
    try {
      const a = await acquireResources(s.project.root, [read]);
      const b = await acquireResources(s.project.root, [read]);
      try {
        await expect(
          acquireResources(s.project.root, [{ ...read, mode: "exclusive" }]),
        ).rejects.toThrow("资源正被");
      } finally {
        await a();
        await b();
      }
      const c = await acquireResources(s.project.root, [
        { ...read, mode: "exclusive" },
      ]);
      await c();
    } finally {
      s.project.cleanup();
    }
  });
});
