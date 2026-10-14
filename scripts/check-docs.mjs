import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const walk=directory=>readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(join(directory,entry.name)):entry.name.endsWith('.md')?[join(directory,entry.name)]:[]);
const files=['README.md','AGENTS.md',...walk(join(root,'skills')),...walk(join(root,'docs'))].map(file=>resolve(root,file));
if(!existsSync(join(root,'dist/sdk.mjs')))throw new Error('先运行 npm run build，再校验文档中的公开 capability');
const {createDefaultRegistry}=await import(new URL('../dist/sdk.mjs',import.meta.url));
const registry=createDefaultRegistry();
let links=0,capabilities=0;
for(const file of files){
  const text=readFileSync(file,'utf8');
  for(const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)){
    const target=match[1];if(/^[a-z]+:|^#|^\//i.test(target))continue;
    if(!existsSync(resolve(dirname(file),target.split('#')[0])))throw new Error(file+' 链接不存在：'+target);
    links++;
  }
  for(const match of text.matchAll(/v-cli capability (?:describe|run) ([a-z][a-z0-9-]*\.[a-z][a-z0-9-]*)/g)){
    if(!registry.has(match[1]))throw new Error(file+' 使用未注册能力：'+match[1]);
    capabilities++;
  }
  if(/phase-a-(?:survey|identity-matrix|protocol-samples)\.md/.test(text))throw new Error(file+' 引用已移除阶段文档');
}
const generated=spawnSync(process.execPath,[join(root,'scripts/generate-agents.mjs'),'--check'],{cwd:root,encoding:'utf8'});
if(generated.status!==0)throw new Error(generated.stderr||generated.stdout||'AGENTS 漂移');
console.log(JSON.stringify({ok:true,files:files.length,links,capabilities,agents:'current'}));
