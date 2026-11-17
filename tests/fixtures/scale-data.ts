import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
export const scaleSeed=160052;
export function scaleAssistant(text:string,timestamp:number){return {role:'assistant',content:[{type:'text',text}],timestamp,api:'openai-completions',provider:'owned-fixture',model:'offline-fixture',stopReason:'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};}
/** Fixed distribution, no external input/history. All normal files have user and assistant messages. */
export async function generateScaleData(root:string,count=10000){
 const sizes:number[]=[];let messages=0;const digest=createHash('sha256');const projects=Array.from({length:50},(_,i)=>join(root,'projects',`项目-${String(i).padStart(2,'0')}`));
 const sessions=join(root,'sessions'),folder=join(sessions,'seed');await mkdir(folder,{recursive:true});for(const p of projects)await mkdir(p,{recursive:true});
 let state=scaleSeed;const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state;};
 for(let i=0;i<count;i++){
  const rounds=i===count-1?2048:i%100===0?64:1+random()%8;const width=i===count-1?8192:80+random()%900;
  const entries:unknown[]=[{type:'session',version:3,id:`seed-${i}`,cwd:projects[i%50],timestamp:'2026-01-01T00:00:00.000Z'}];
  for(let j=0;j<rounds*2;j++)entries.push({type:'message',id:`m-${j}`,parentId:j?`m-${j-1}`:null,timestamp:'2026-01-01T00:00:00.000Z',message:j%2?scaleAssistant(`种子 ${scaleSeed} 会话 ${i} 消息 ${j} `+'x'.repeat(width),1767225600000+j):{role:'user',content:`种子 ${scaleSeed} 会话 ${i} 消息 ${j} `+'x'.repeat(width),timestamp:1767225600000+j}});
  messages+=rounds*2;const text=entries.map(e=>JSON.stringify(e)).join('\n')+'\n';sizes.push(Buffer.byteLength(text));digest.update(text);await writeFile(join(folder,`${String(i).padStart(5,'0')}.jsonl`),text);
 }
 const bad=join(folder,'bad.jsonl'),badText=JSON.stringify({type:'session',version:3,id:'bad',cwd:projects[0]})+'\n{bad complete record}\n';await writeFile(bad,badText);digest.update(badText);
 const ordered=[...sizes].sort((a,b)=>a-b);return {seed:scaleSeed,fixtureVersion:2,sourceDigest:digest.digest('hex'),count,projects,sessions,folder,messages,normalBytes:sizes.reduce((a,b)=>a+b,0),badBytes:Buffer.byteLength(badText),totalBytes:sizes.reduce((a,b)=>a+b,0)+Buffer.byteLength(badText),sizes:{min:ordered[0],p50:ordered[Math.ceil(count*.5)-1],p95:ordered[Math.ceil(count*.95)-1],max:ordered.at(-1)},bad};
}
