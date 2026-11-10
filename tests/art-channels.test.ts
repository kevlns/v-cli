import {writeFileSync,mkdirSync} from "node:fs";
import {join} from "node:path";
import {describe,it,expect} from "vitest";
import {CapabilityRegistry} from "../src/core/execution/registry";
import {runCapability} from "../src/core/execution/runtime";
import {createArtProvider} from "../src/providers/art";
import {FakeExecutor} from "./helpers/fake-executor";
import {fakeBackend,makeTempProject} from "./helpers/unity-fixtures";
const config={schemaVersion:1,bindings:{art:{workspace:".vant/art",output:".vant/art/output",cache:".vant/art/cache",projectId:"project"}}};
function registryFor(executor:FakeExecutor){const registry=new CapabilityRegistry();registry.registerProvider(createArtProvider({executor,discoverBackend:()=>fakeBackend({package:"@kevlns/art-workshop",name:"art"})}));return registry;}
describe("art image/video channel contracts",()=>{
 it("retains original art identities and exposes independent image aliases and video capabilities",()=>{
  const registry=registryFor(new FakeExecutor(()=>({stdout:"{}"})));
  for(const id of ["art.style-read","art.generate-start","art.run-status","art.image-style-read","art.image-generate-start","art.image-run-status","art.video-describe","art.video-settings-save","art.video-operation-run","art.video-film-compose","art.video-execution-status"])expect(registry.describe(id),id).toBeDefined();
  expect(registry.describe("art.image-style-read")!.commands).toEqual([["image","style","read"]]);
  expect(registry.describe("art.video-operation-run")!.commands).toEqual([["video","operation","run"]]);
  expect(registry.describe("art.video-task-list")!.sideEffects.some(effect=>effect.kind==="fs-write")).toBe(false);
  expect(registry.describe("art.video-operation-run")!.sideEffects.some(effect=>effect.kind==="network")).toBe(true);
  expect(registry.describe("art.video-film-compose")!.sideEffects.some(effect=>effect.kind==="fs-write")).toBe(true);
  for(const id of ["art.video-settings-get","art.video-settings-save","art.video-runtime-status"])expect(registry.describe(id)!.sideEffects.some(effect=>effect.kind==="network"),id).toBe(true);
 });
 it("routes image generation aliases through the explicit image prefix without changing frozen plan identity",async()=>{
  const project=makeTempProject({config,withProjectVersion:false}),executor=new FakeExecutor(()=>({stdout:JSON.stringify({taskId:"image-task",lifecycle:"accepted"})})),registry=registryFor(executor);
  try{
   mkdirSync(join(project.root,".vant/art"),{recursive:true});writeFileSync(join(project.root,".vant/art/plan.json"),JSON.stringify({project:"project",module:"generate"}));
   const result=await runCapability(registry,{projectRoot:project.root,capabilityId:"art.image-generate-start",input:{plan:".vant/art/plan.json"}});
   expect(result.execution.status).toBe("succeeded");expect(result.execution.lifecycle).toBe("accepted");const args=executor.calls[0].args;
   expect(args.slice(1,4)).toEqual(["image","generate","run"]);expect(args).toContain("--background");expect(args).not.toContain("--project");
  }finally{project.cleanup();}
 });
 it("binds video to the engineering root and passes the runner identity to the durable CLI admission",async()=>{
  const project=makeTempProject({config,withProjectVersion:false}),executor=new FakeExecutor(()=>({stdout:JSON.stringify({id:"created-task",revision:1,operations:[]})})),registry=registryFor(executor);
  try{
   writeFileSync(join(project.root,"create.json"),JSON.stringify({name:"new video"}));
   const result=await runCapability(registry,{projectRoot:project.root,capabilityId:"art.video-task-create",operationId:"video-create-authorized",input:{input:"create.json"}});
   expect(result.execution.status).toBe("succeeded");expect(result.acceptance.status).toBe("not-run");
   const args=executor.calls[0].args;expect(args.slice(1,4)).toEqual(["video","task","create"]);expect(args[args.indexOf("--workspace")+1]).toBe(project.root);expect(args[args.indexOf("--input")+1]).toBe(join(project.root,"create.json"));expect(args[args.indexOf("--operation")+1]).toBe("video-create-authorized");expect(args).not.toContain("--output-dir");expect(args).not.toContain("--config");
   await expect(runCapability(registry,{projectRoot:project.root,capabilityId:"art.video-task-create",operationId:"video-create-authorized",input:{input:"create.json"}})).rejects.toMatchObject({structured:{code:"operation-exists"}});expect(executor.calls).toHaveLength(1);
  }finally{project.cleanup();}
 });
 it("rejects missing, malformed, escaped and guessed video inputs before process dispatch",async()=>{
  const project=makeTempProject({config,withProjectVersion:false}),executor=new FakeExecutor(()=>({stdout:"{}"})),registry=registryFor(executor);
  try{
   writeFileSync(join(project.root,"array.json"),"[]");
   for(const input of [{},{input:"../outside.json"},{input:"array.json"},{input:"create.json",settings:{}}]){
    const result=await runCapability(registry,{projectRoot:project.root,capabilityId:"art.video-settings-save",input});expect(result.execution.status).toBe("failed");expect(executor.calls).toHaveLength(0);
   }
  }finally{project.cleanup();}
 });
 it("keeps submitted and unknown video runs separate from successful production",async()=>{
  const project=makeTempProject({config,withProjectVersion:false});let status="running";
  const executor=new FakeExecutor(()=>({stdout:JSON.stringify({id:"task",operations:[{id:"op",runs:[{id:"run",requestId:"authorized-generation",status}]}]})})),registry=registryFor(executor);
  try{
   writeFileSync(join(project.root,"run.json"),JSON.stringify({taskId:"task",operationId:"op",revision:1,requestId:"authorized-generation"}));
   const accepted=await runCapability(registry,{projectRoot:project.root,capabilityId:"art.video-operation-run",input:{input:"run.json"}});expect(accepted.execution.lifecycle).toBe("accepted");expect(accepted.acceptance.status).toBe("not-run");expect(accepted.artifacts.some(artifact=>artifact.kind!=="log")).toBe(false);
   status="unknown";const unknown=await runCapability(registry,{projectRoot:project.root,capabilityId:"art.video-operation-run",input:{input:"run.json"}});expect(unknown.execution.lifecycle).toBe("unknown");expect(unknown.acceptance.status).toBe("not-run");
  }finally{project.cleanup();}
 });
 it("records malformed write responses and explicit video unknown failures without replay or successful acceptance",async()=>{
  const project=makeTempProject({config,withProjectVersion:false}),executor=new FakeExecutor((_call,index)=>index===0?{stdout:"partial JSON"}:{stdout:JSON.stringify({ok:false,error:"receipt lost",unknown:true,operationId:"video-00000000-0000-5000-a000-000000000000"}),exitCode:1}),registry=registryFor(executor);
  try{
   writeFileSync(join(project.root,"create.json"),JSON.stringify({name:"video"}));
   for(let index=0;index<2;index++){const result=await runCapability(registry,{projectRoot:project.root,capabilityId:"art.video-task-create",input:{input:"create.json"}});expect(result.execution.status).toBe("failed");expect(result.execution.lifecycle).toBe("unknown");expect(result.acceptance.status).toBe("not-run");}
   expect(executor.calls).toHaveLength(2);
  }finally{project.cleanup();}
 });
 it("resumes the matching operation's original run without requiring an extra runId and preserves submitted receipt status",async()=>{
  const project=makeTempProject({config,withProjectVersion:false});let observed="submitted";
  const executor=new FakeExecutor(call=>call.args.includes("resume")?{stdout:JSON.stringify({id:"task",operations:[{id:"other",runs:[{id:"wrong",requestId:"wrong",status:"succeeded"}]},{id:"op",runs:[{id:"original-run",requestId:"original-request",status:"running"}]}]})}:{stdout:JSON.stringify({version:1,operationId:"video-00000000-0000-5000-a000-000000000000",status:observed,unknown:observed==="unknown"})}),registry=registryFor(executor);
  try{
   writeFileSync(join(project.root,"resume.json"),JSON.stringify({taskId:"task",operationId:"op"}));
   const resumed=await runCapability(registry,{projectRoot:project.root,capabilityId:"art.video-operation-resume",input:{input:"resume.json"}});expect(resumed.execution.lifecycle).toBe("accepted");expect(resumed.acceptance.status).toBe("not-run");
   for(const state of ["submitted","unknown"]){observed=state;const receipt=await runCapability(registry,{projectRoot:project.root,capabilityId:"art.video-execution-status",input:{operation:"video-00000000-0000-5000-a000-000000000000"}});expect(receipt.execution.lifecycle).toBe(state==="submitted"?"accepted":"unknown");expect(receipt.acceptance.status).toBe("not-run");}
  }finally{project.cleanup();}
 });
});
