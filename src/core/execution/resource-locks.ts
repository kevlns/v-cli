import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import type { ResourceRequirement } from "./types";
import { comparePathForm } from "../project/paths";

interface Claim {
  token: string;
  pid: number;
  project: string;
  paths?: string[];
  resources: ResourceRequirement[];
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
};
const root = () =>
  path.join(
    os.tmpdir(),
    "vant-capability-resources",
    createHash("sha256").update(os.homedir()).digest("hex"),
  );
const conflicts = (a: Claim, b: Claim) =>
  a.resources.some((x) =>
    b.resources.some(
      (y) =>
        x.kind === y.kind &&
        (x.key ?? "default") === (y.key ?? "default") &&
        (x.scope === "machine" ||
          y.scope === "machine" ||
          (a.paths ?? [a.project]).some((p) =>
            (b.paths ?? [b.project]).some(
              (q) => p === q || p.startsWith(q + "/") || q.startsWith(p + "/"),
            ),
          )) &&
        (x.mode === "exclusive" || y.mode === "exclusive"),
    ),
  );

/** 先原子登记自身，再检查冲突。并发登记可以相互拒绝，但不会同时进入冲突资源。 */
export type ResourceLease = (() => Promise<void>) & {
  transfer(pid: number): Promise<boolean>;
};
const pause = () => new Promise((resolve) => setTimeout(resolve, 10));
async function retryFile<T>(action: () => T): Promise<T> {
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      return action();
    } catch (error) {
      if (
        !["EPERM", "EBUSY", "EACCES"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        ) ||
        Date.now() >= deadline
      )
        throw error;
      await pause();
    }
  }
}
async function remove(file: string) {
  try {
    await retryFile(() => fs.unlinkSync(file));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
export async function acquireResources(
  project: string,
  resources: ResourceRequirement[],
  bindingPaths: string[] = [],
  options: { waitForLocal?: boolean; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ResourceLease> {
  if (!resources.length)
    return Object.assign(async () => {}, { transfer: async () => false });
  const dir = root();
  fs.mkdirSync(dir, { recursive: true });
  const paths = [project, ...bindingPaths].map((p) =>
    comparePathForm(fs.existsSync(p) ? fs.realpathSync.native(p) : path.resolve(p)),
  );
  const claim: Claim = {
    token: randomUUID(),
    pid: process.pid,
    project: comparePathForm(project),
    paths,
    resources,
  };
  const file = path.join(dir, claim.token + ".json");
  async function write() {
    const temp = file + "." + randomUUID() + ".pending";
    try {
      fs.writeFileSync(temp, JSON.stringify(claim), { flag: "wx" });
      await retryFile(() => fs.renameSync(temp, file));
    } finally {
      if (fs.existsSync(temp)) await remove(temp);
    }
  }
  const deadline = Date.now() + (options.timeoutMs ?? 90000);
  let transferred = false;
  for (;;) {
  options.signal?.throwIfAborted();
  await write();
  try {
    let localBusy = false;
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      const existing = path.join(dir, name);
      if (existing === file) continue;
      let other: Claim;
      try {
        other = JSON.parse(
          await retryFile(() => fs.readFileSync(existing, "utf8")),
        ) as Claim;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!alive(other.pid)) {
        await remove(existing);
        continue;
      }
      if (conflicts(claim, other)) {
        if (other.pid === process.pid && options.waitForLocal) localBusy = true;
        else throw Error(`资源正被进程 ${other.pid} 使用`);
      }
    }
    if (!localBusy) break;
    // Waiting claims must not block their owner or other waiting callers.
    await remove(file);
    if (Date.now() >= deadline) throw Error("等待当前服务的资源操作完成超时");
    await pause();
  } catch (error) {
    await remove(file);
    throw error;
  }
  }
  return Object.assign(
    async () => {
      if (transferred) return;
      try {
        const current = JSON.parse(
          await retryFile(() => fs.readFileSync(file, "utf8")),
        ) as Claim;
        // 后台工具已在启动时接管；宿主不能删除仍属后台进程的租约。
        if (current.pid !== process.pid) return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      await remove(file);
    },
    {
      async transfer(pid: number) {
        if (!Number.isInteger(pid) || pid <= 0) throw Error("后台进程身份无效");
        if (!alive(pid)) return false;
        claim.pid = pid;
        await write();
        transferred = true;
        return true;
      },
    },
  );
}
