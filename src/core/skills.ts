import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { defaultResolvePackage, OFFICIAL_PLUGINS } from "./official";

export interface ToolSkill {
  id: string; package: string; tool: string; version: string;
  path: string; contentHash: string;
}
export function discoverToolSkills(options: {resolvePackage?: (name: string) => string | undefined} = {}) {
  const resolvePackage = options.resolvePackage ?? defaultResolvePackage;
  const skills: ToolSkill[] = [], diagnostics: string[] = [];
  for (const spec of [{package:"@kevlns/v-cli",command:"v-cli"}, ...OFFICIAL_PLUGINS]) {
    const pkgFile = resolvePackage(spec.package);
    if (!pkgFile) continue;
    const root = path.dirname(pkgFile), file = path.join(root,"v-cli.plugin.json");
    if (!fs.existsSync(file)) continue;
    const pkg = JSON.parse(fs.readFileSync(pkgFile,"utf8"));
    const manifest = JSON.parse(fs.readFileSync(file,"utf8"));
    if (pkg.name !== spec.package || manifest.package !== spec.package || manifest.command !== spec.command)
      throw new Error("工具技能声明身份不一致："+spec.package);
    if(manifest.skills!==undefined && !Array.isArray(manifest.skills)) throw new Error("技能声明无效");
    for (const item of manifest.skills ?? []) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(item.id) || item.path!==`skills/${item.id}/SKILL.md`)
        throw new Error("技能声明无效");
      const entry = path.resolve(root,item.path), actual = fs.realpathSync(entry), realRoot=fs.realpathSync(root);
      const relative = path.relative(realRoot,actual);
      if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(".."+path.sep)) throw new Error("技能声明越界");
      if (skills.some(s=>s.id===item.id)) throw new Error("技能标识重复："+item.id);
      skills.push({id:item.id,package:pkg.name,tool:spec.command,version:pkg.version,path:actual,
        contentHash:skillBundleHash(path.dirname(actual))});
    }
    if (manifest.skills === undefined) diagnostics.push(spec.command+" 未声明技能");
  }
  return {schemaVersion:1,skills,diagnostics};
}

export function readRuntimeSkill(command?: string, options: {resolvePackage?: (name:string)=>string|undefined} = {}) {
  const tool = command ?? "v-cli";
  const result=discoverToolSkills(options), skill=result.skills.find(s=>s.tool===tool);
  if (!skill) throw new Error("工具未声明运行技能："+tool);
  return {...skill,file:skill.path,content:fs.readFileSync(skill.path,"utf8"),sha256:createHash("sha256").update(fs.readFileSync(skill.path)).digest("hex")};
}

function skillBundleHash(root:string) {
 const files:{path:string;hash:string}[]=[];
 const walk=(directory:string,prefix="")=>{
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
   if(entry.name==="__pycache__" || entry.name.endsWith(".pyc"))continue;
   if(entry.isSymbolicLink())throw new Error("技能资源不能包含链接");
   const relative=prefix+entry.name, full=path.join(directory,entry.name);
   if(entry.isDirectory())walk(full,relative+"/");
   else if(entry.isFile())files.push({path:relative,hash:createHash("sha256").update(fs.readFileSync(full)).digest("hex")});
  }
 };
 walk(root);files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 return createHash("sha256").update(JSON.stringify(files)).digest("hex");
}

/** 外部宿主导出必须显式选择宿主和目录；不探测用户目录。 */
export function exportToolSkill(command: string | undefined, options: {
  host: string; directory: string; dryRun?: boolean;
  resolvePackage?: (name: string) => string | undefined;
}) {
  if (!["codex", "claude"].includes(options.host) || !options.directory)
    throw new Error("导出必须显式选择 host 和 directory");
  const skill = readRuntimeSkill(command, options);
  const base = path.resolve(options.directory);
  if (!fs.lstatSync(base).isDirectory() || fs.lstatSync(base).isSymbolicLink())
    throw new Error("导出目录必须是已有普通目录");
  const root = path.resolve(path.dirname(skill.path), "../.."), target = path.join(base,skill.id);
  const planned: {path:string;bytes:Buffer}[] = [];
  const check = (file: string, directory: boolean) => {
    let stat; try { stat=fs.lstatSync(file); } catch(e) { if ((e as NodeJS.ErrnoException).code!=="ENOENT") throw e; }
    if (stat && (stat.isSymbolicLink() || stat.isDirectory()!==directory)) throw new Error("导出目标类型冲突");
  };
  check(target,true);
  const walk = (source:string,dest:string) => {
    for (const entry of fs.readdirSync(source,{withFileTypes:true})) {
      if (entry.name==="__pycache__" || entry.name.endsWith(".pyc")) continue;
      if (entry.isSymbolicLink()) throw new Error("技能导出不能包含链接");
      const from=path.join(source,entry.name), to=path.join(dest,entry.name);
      check(to,entry.isDirectory());
      if (entry.isDirectory()) walk(from,to);
      else if (entry.isFile()) planned.push({path:to,bytes:fs.readFileSync(from)});
      else throw new Error("技能资源类型不受支持");
    }
  };
  walk(path.dirname(skill.path),target);
  const adapter=path.join(root,"adapters",options.host);
  if (fs.existsSync(adapter)) walk(adapter,target);
  if (!options.dryRun) for (const file of planned) {
    fs.mkdirSync(path.dirname(file.path),{recursive:true}); fs.writeFileSync(file.path,file.bytes);
  }
  return {skill:skill.id,host:options.host,target,dryRun:!!options.dryRun,files:planned.length};
}
