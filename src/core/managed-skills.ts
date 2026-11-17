import fs from "node:fs";
import path from "node:path";
import { retryFile } from "./retry-file";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defaultResolvePackage } from "./official";
import { discoverToolSkills, skillFileHashes, type ToolSkill } from "./skills";

interface IndexedTool {
  id: string; package: string; version: string; path: string; contentHash: string;
  skills: {id: string; path: string}[];
}

const digest = (data: unknown) => createHash("sha256").update(JSON.stringify(data)).digest("hex");

// Check every existing component, including a dangling symlink at the destination.
function owned(home: string, relative: string) {
  let current = home;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if (fs.lstatSync(current, {throwIfNoEntry:false})?.isSymbolicLink())
      throw new Error("受管技能路径包含链接：" + current);
  }
  return current;
}

async function projectTool(home: string, skills: ToolSkill[], dryRun: boolean): Promise<IndexedTool> {
  const first = skills[0];
  const files = skills.flatMap(skill => skillFileHashes(path.dirname(skill.path))
    .map(file => [skill.id + "/" + file.path, file.hash]));
  files.sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0);
  const hash = digest(files);
  const relative = "managed/" + first.tool + "/" + hash;
  const target = owned(home, "skills/" + relative);
  function verify(directory: string) {
    if (digest(skillFileHashes(directory).map(file => [file.path, file.hash])) !== hash)
      throw new Error("受管技能内容校验失败：" + directory);
  }
  if (fs.existsSync(target)) verify(target);
  else if (!dryRun) {
    fs.mkdirSync(path.dirname(target), {recursive:true});
    const staging = fs.mkdtempSync(path.join(path.dirname(target), ".stage-"));
    try {
      for (const skill of skills) fs.cpSync(path.dirname(skill.path), path.join(staging,skill.id), {
        recursive:true, filter: source => path.basename(source)!=="__pycache__" && !source.endsWith(".pyc"),
      });
      verify(staging);
      try { await retryFile(() => fs.renameSync(staging,target)); }
      catch (error) { if (!fs.existsSync(target)) throw error; verify(target); }
    } finally { fs.rmSync(staging,{recursive:true,force:true}); }
  }
  return {id:first.tool,package:first.package,version:first.version,contentHash:hash,path:relative,
    skills:skills.map(({id}) => ({id,path:id+"/SKILL.md"}))};
}

export async function syncManagedSkills({dryRun=false, home=process.env.VANT_HOME || path.join(os.homedir(),".vant"),
  resolvePackage}: {dryRun?:boolean; home?:string; resolvePackage?:(pkg:string)=>string|undefined} = {}) {
  // Project dependencies must never become global instructions by virtue of cwd.
  const installed = path.dirname(fileURLToPath(import.meta.url));
  const {skills} = discoverToolSkills({resolvePackage:resolvePackage ?? (pkg => defaultResolvePackage(pkg,{
    cwd:installed,resolveFrom:process.env.V_CLI_PLUGIN_RESOLVE_FROM && path.resolve(process.env.V_CLI_PLUGIN_RESOLVE_FROM),
  }))});
  const groups = new Map<string, ToolSkill[]>();
  for (const skill of skills) {
    const group = groups.get(skill.tool) ?? [];
    group.push(skill); groups.set(skill.tool,group);
  }
  const file = owned(home,"state/tool-skills/index.json");
  const tools: IndexedTool[] = [];
  for (const group of groups.values()) tools.push(await projectTool(home,group,dryRun));
  const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,"utf8")) : {schemaVersion:1,tools:[]};
  if (previous.schemaVersion!==1 || !Array.isArray(previous.tools)) throw new Error("受管技能索引无效。");
  // Retain projections owned by other installed tools. Only switch the index once every new bundle is complete.
  const next = {schemaVersion:1,tools:[...tools,...previous.tools.filter((tool:IndexedTool)=>!groups.has(tool.id))]};
  if (!dryRun && JSON.stringify(previous)!==JSON.stringify(next)) {
    fs.mkdirSync(path.dirname(file),{recursive:true});
    const temporary=file+"."+randomUUID();
    try {
      fs.writeFileSync(temporary,JSON.stringify(next,null,2)+"\n",{flag:"wx"});
      await retryFile(() => fs.renameSync(temporary,file));
    } finally { fs.rmSync(temporary,{force:true}); }
  }
  return {dryRun,names:skills.map(skill=>skill.id)};
}
