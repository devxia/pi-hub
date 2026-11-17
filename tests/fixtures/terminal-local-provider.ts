import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream,type AssistantMessage } from '@earendil-works/pi-ai';
import { appendFileSync } from 'node:fs';
export default function(pi:ExtensionAPI){
 pi.registerProvider('hub-terminal-local',{api:'hub-terminal-local-api',apiKey:'owned-local-placeholder',baseUrl:'http://127.0.0.1:1',headers:{'x-owned-local':'true'},models:[{id:'deterministic',name:'Owned local response',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:2048}],streamSimple(model,context,options){
  const stream=createAssistantMessageEventStream();const message:AssistantMessage={role:'assistant',content:[{type:'text',text:'Owned zero-network response'}],api:model.api,provider:model.provider,model:model.id,stopReason:'stop',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  if(JSON.stringify(context.messages.at(-1)).includes('hold-owned-task')){queueMicrotask(()=>stream.push({type:'start',partial:message}));const abort=()=>{stream.push({type:'error',reason:'aborted',error:{...message,stopReason:'aborted',errorMessage:'Owned task aborted'}});stream.end();};if(options?.signal?.aborted)abort();else options?.signal?.addEventListener('abort',abort,{once:true});return stream;}
  queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});stream.end();});return stream;
 }});
 pi.registerCommand('hub-test-quit',{handler:async(_,ctx)=>ctx.shutdown()});
}
