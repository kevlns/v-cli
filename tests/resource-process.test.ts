import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { acquireResources } from "../src/core/execution/resource-locks";
import { makeTempProject } from "./helpers/unity-fixtures";

it("独立 SDK 进程之间互斥，持有进程退出后可回收", async () => {
  const project = makeTempProject({
    config: { schemaVersion: 1, bindings: { ship: { projectDir: "." } } },
    withProjectVersion: false,
  });
  const code = `import {createDefaultRegistry,runCapability} from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "dist/sdk.mjs")).href)};
    const executor={async run(){process.send('held');await new Promise(r=>process.once('message',r));return {exitCode:0,signal:null,stdout:JSON.stringify({projectRoot:process.env.TARGET}),stderr:'',stdoutTruncated:false,stderrTruncated:false,timedOut:false,aborted:false,killConfirmed:false,durationMs:1,startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),error:null};}};
    await runCapability(createDefaultRegistry({executor,shipDiscoverBackend:()=>({source:'official',package:'@kevlns/ship-cli',name:'ship',description:'fixture',status:'available',platform:process.platform,bin:'mock.js'})}),{capabilityId:'ship.config-show',projectRoot:process.env.TARGET});process.disconnect();`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, TARGET: project.root },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  const exited = once(child, "exit");
  try {
    await Promise.race([
      once(child, "message"),
      exited.then(() => {
        throw Error("子进程未取得租约");
      }),
    ]);
    const resource = {
      kind: "project-workspace",
      mode: "exclusive",
      scope: "project",
      description: "write",
    } as const;
    await expect(acquireResources(project.root, [resource])).rejects.toThrow(
      "资源正被",
    );
    child.kill();
    await exited;
    const release = await acquireResources(project.root, [resource]);
    await release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited;
    }
    project.cleanup();
  }
}, 15000);
