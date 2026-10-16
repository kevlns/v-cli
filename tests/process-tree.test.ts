import { it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeProcessExecutor } from "../src/core/execution/executor";

it("取消确认覆盖受控进程树，不留下孙进程", async () => {
  const root = mkdtempSync(join(tmpdir(), "vcli-tree-"));
  const pidFile = join(root, "child.pid");
  const controller = new AbortController();
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    const code = `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});writeFileSync(${JSON.stringify(pidFile)},String(p.pid));setInterval(()=>{},1000);`;
    timer = setInterval(() => {
      if (existsSync(pidFile)) controller.abort();
    }, 25);
    const result = await new NodeProcessExecutor().run({
      file: process.execPath,
      args: ["-e", code],
      signal: controller.signal,
      timeoutMs: 10000,
    });
    expect(result.aborted).toBe(true);
    expect(result.killConfirmed).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    if (timer) clearInterval(timer);
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
