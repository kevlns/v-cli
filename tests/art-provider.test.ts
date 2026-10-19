import {mkdirSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import { describe, it, expect } from "vitest";
import { CapabilityRegistry } from "../src/core/execution/registry";
import { runCapability } from "../src/core/execution/runtime";
import { createArtProvider } from "../src/providers/art";
import { FakeExecutor } from "./helpers/fake-executor";
import { fakeBackend, makeTempProject } from "./helpers/unity-fixtures";
const config = {
  schemaVersion: 1,
  bindings: {
    art: {
      workspace: ".vant/art",
      output: ".vant/art/output",
      cache: ".vant/art/cache",
      projectId: "project",
    },
  },
};
describe("art controlled execution and lifecycle", () => {
  it("routes environment inspection without a project object and validates directory before dispatch",async()=>{
    const project=makeTempProject({config,withProjectVersion:false}),executor=new FakeExecutor(()=>({stdout:JSON.stringify({ok:true,root:"C:/AI/test"})})),registry=new CapabilityRegistry();
    registry.registerProvider(createArtProvider({executor,discoverBackend:()=>fakeBackend({package:"@kevlns/art-workshop",name:"art"})}));
    try{
      const invalid=await runCapability(registry,{projectRoot:project.root,capabilityId:"art.environment-inspect",input:{endpoint:"http://127.0.0.1:8188/"}});
      expect(invalid.execution.status).toBe("failed");expect(executor.calls).toHaveLength(0);
      const result=await runCapability(registry,{projectRoot:project.root,capabilityId:"art.environment-inspect",input:{directory:"C:/AI/test",endpoint:"http://127.0.0.1:8188/"}});
      expect(result.execution.status).toBe("succeeded");expect(executor.calls).toHaveLength(1);
      const argv=JSON.stringify(executor.calls[0]);expect(argv).toContain("environment");expect(argv).not.toContain('"--project"');
      expect(registry.list().some(c=>c.id.startsWith("art.deployment-"))).toBe(false);
    }finally{project.cleanup();}
  });
  it("routes a style decision through the same controlled project and revision boundary",async()=>{
    const project=makeTempProject({config,withProjectVersion:false}),executor=new FakeExecutor(()=>({stdout:JSON.stringify({id:"style-a",revision:2,review:{ready:true}})})),registry=new CapabilityRegistry();
    registry.registerProvider(createArtProvider({executor,discoverBackend:()=>fakeBackend({package:"@kevlns/art-workshop",name:"art"})}));
    try{
      writeFileSync(join(project.root,"decision.json"),JSON.stringify({issueId:"shadow",optionId:"flexible",note:"用户确认"}));
      const result=await runCapability(registry,{projectRoot:project.root,capabilityId:"art.style-resolve",input:{id:"style-a",revision:1,input:"decision.json"}});
      expect(result.execution.status).toBe("succeeded");expect(executor.calls).toHaveLength(1);
      expect(JSON.stringify(executor.calls[0])).toContain("resolve");
      const invalid=await runCapability(registry,{projectRoot:project.root,capabilityId:"art.style-resolve",input:{id:"style-a",input:"decision.json"}});
      expect(invalid.execution.status).toBe("failed");expect(executor.calls).toHaveLength(1);
    }finally{project.cleanup();}
  });
  it("publishes only drawing reference categories and rejects removed shape classification before execution", async () => {
    const project=makeTempProject({config,withProjectVersion:false}),executor=new FakeExecutor(()=>({stdout:"{}"})),registry=new CapabilityRegistry();
    registry.registerProvider(createArtProvider({executor,discoverBackend:()=>fakeBackend()}));
    try {
      const result=await runCapability(registry,{projectRoot:project.root,capabilityId:"art.reference-import",input:{kind:"style",id:"style-a",revision:1,source:"image.png",category:"shape-language"}});
      expect(result.execution.status).toBe("failed");
      expect(executor.calls).toHaveLength(0);
    } finally {project.cleanup();}
  });
  it("settles malformed synchronous responses but retains uncertain background ownership",async()=>{
    const project=makeTempProject({config,withProjectVersion:false});
    const registry=new CapabilityRegistry();
    registry.registerProvider(createArtProvider({executor:new FakeExecutor(()=>({exitCode:0,stdout:"not-json"})),discoverBackend:()=>fakeBackend()}));
    try{
      const sync=await runCapability(registry,{projectRoot:project.root,capabilityId:"art.job-create",input:{input:"input.json"}});
      expect(sync.execution.status).toBe("failed");expect(sync.execution.lifecycle).not.toBe("unknown");
      mkdirSync(join(project.root,".vant/art"),{recursive:true});writeFileSync(join(project.root,".vant/art/plan.json"),JSON.stringify({project:"project",module:"generate"}));
      const background=await runCapability(registry,{projectRoot:project.root,capabilityId:"art.generate-start",input:{plan:".vant/art/plan.json"}});
      expect(background.execution.status).toBe("failed");expect(background.execution.lifecycle,JSON.stringify(background)).toBe("unknown");
    }finally{project.cleanup();}
  });
  it("preserves structured tool rejection without inventing an uncertain background run",async()=>{
    const project=makeTempProject({config,withProjectVersion:false});
    const registry=new CapabilityRegistry();
    registry.registerProvider(createArtProvider({executor:new FakeExecutor(()=>({exitCode:1,stdout:JSON.stringify({ok:false,error:"对象名称不能为空"})})),discoverBackend:()=>fakeBackend({package:"@kevlns/art-workshop",name:"art"})}));
    try{
      const result=await runCapability(registry,{projectRoot:project.root,capabilityId:"art.job-create",input:{input:"input.json"}});
      expect(result.execution.status).toBe("failed");
      expect(result.execution.lifecycle).not.toBe("unknown");
      expect(result.execution.error?.message).toBe("对象名称不能为空");
      expect(result.handle).toBeNull();
    }finally{project.cleanup();}
  });
  it("issues an execution handle, validates it on cancel, and retains upstream uncertainty", async () => {
    const project = makeTempProject({ config, withProjectVersion: false });
    const executor = new FakeExecutor((_call, index) => ({
      stdout: JSON.stringify(
        index === 0
          ? { taskId: "task-one", status: "queued" }
          : {
              taskId: "task-one",
              status: "cancelled",
              lifecycle: "unknown",
              stopConfirmed: false,
              remoteCancellation: "unconfirmed",
            },
      ),
    }));
    const registry = new CapabilityRegistry();
    registry.registerProvider(
      createArtProvider({
        executor,
        discoverBackend: () =>
          fakeBackend({ package: "@kevlns/art-workshop", name: "art" }),
      }),
    );
    try {
      mkdirSync(join(project.root,".vant/art"),{recursive:true});writeFileSync(join(project.root,".vant/art/plan.json"),JSON.stringify({project:"project",module:"generate"}));
      const started = await runCapability(registry, {
        projectRoot: project.root,
        capabilityId: "art.generate-start",
        input: { plan: ".vant/art/plan.json" },
      });
      expect(started.execution.lifecycle).toBe("accepted");
      expect(started.handle?.backendTaskId).toBe("task-one");
      expect(executor.calls[0].args).toContain("--background");
      expect(executor.calls[0].args).not.toContain("--project");
      const stopped = await runCapability(registry, {
        projectRoot: project.root,
        capabilityId: "art.run-cancel",
        input: { handle: started.handle },
      });
      expect(stopped.execution.lifecycle).toBe("unknown");
      expect(executor.calls[1].args.slice(1, 4)).toEqual([
        "task",
        "cancel",
        "task-one",
      ]);
      const altered = { ...started.handle, backendTaskId: "task-other" };
      const rejected = await runCapability(registry, {
        projectRoot: project.root,
        capabilityId: "art.run-cancel",
        input: { handle: altered },
      });
      expect(rejected.execution.status).toBe("failed");
      expect(executor.calls).toHaveLength(2);
      const resumed=await runCapability(registry,{projectRoot:project.root,capabilityId:"art.run-resume",input:{handle:started.handle}});
      expect(resumed.execution.status).toBe("succeeded");
      expect(executor.calls[2].args.slice(1,4)).toEqual(["task","resume","task-one"]);
      expect(executor.calls[2].args).not.toContain("--operation");
    } finally {
      project.cleanup();
    }
  });
  it("rejects injected paths before starting a tool process", async () => {
    const project = makeTempProject({ config, withProjectVersion: false }),
      executor = new FakeExecutor(() => ({ stdout: "{}" })),
      registry = new CapabilityRegistry();
    registry.registerProvider(
      createArtProvider({ executor, discoverBackend: () => fakeBackend() }),
    );
    try {
      const result = await runCapability(registry, {
        projectRoot: project.root,
        capabilityId: "art.job-create",
        input: { input: "../outside.json" },
      });
      expect(result.execution.status).toBe("failed");
      expect(executor.calls).toHaveLength(0);
    } finally {
      project.cleanup();
    }
  });
 it("rejects a foreign plan and changed execution binding before invoking the backend",async()=>{
  const project=makeTempProject({config,withProjectVersion:false}),executor=new FakeExecutor(()=>({stdout:JSON.stringify({taskId:"task-one",status:"queued"})})),registry=new CapabilityRegistry();registry.registerProvider(createArtProvider({executor,discoverBackend:()=>fakeBackend()}));
  try{
    mkdirSync(join(project.root,".vant/art"),{recursive:true});const file=join(project.root,".vant/art/plan.json");writeFileSync(file,JSON.stringify({project:"foreign",module:"generate"}));
    const rejected=await runCapability(registry,{projectRoot:project.root,capabilityId:"art.generate-start",input:{plan:".vant/art/plan.json"}});expect(rejected.execution.error?.code).toBe("art-plan-scope-mismatch");expect(executor.calls).toHaveLength(0);
    writeFileSync(file,JSON.stringify({project:"project",module:"generate"}));const original=await runCapability(registry,{projectRoot:project.root,capabilityId:"art.generate-start",input:{plan:".vant/art/plan.json"}});
    writeFileSync(project.configFile,JSON.stringify({schemaVersion:1,bindings:{art:{...config.bindings.art,projectId:"foreign"}}}));
    const cancelled=await runCapability(registry,{projectRoot:project.root,capabilityId:"art.run-cancel",input:{handle:original.handle}});expect(cancelled.execution.error?.code).toBe("art-handle-binding-changed");expect(executor.calls).toHaveLength(1);
  }finally{project.cleanup();}
 });

});
