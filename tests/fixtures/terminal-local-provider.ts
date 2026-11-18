import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream,type AssistantMessage } from '@earendil-works/pi-ai';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
export default function(pi:ExtensionAPI){
 pi.registerProvider('hub-terminal-local',{api:'hub-terminal-local-api',apiKey:'owned-local-placeholder',baseUrl:'http://127.0.0.1:1',headers:{'x-owned-local':'true'},models:[{id:'deterministic',name:'Owned local response',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:2048}],streamSimple(model,context,options){
  const stream=createAssistantMessageEventStream();const message:AssistantMessage={role:'assistant',content:[{type:'text',text:'Owned zero-network response'}],api:model.api,provider:model.provider,model:model.id,stopReason:'stop',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  if(JSON.stringify(context.messages.at(-1)).includes('hold-owned-task')){queueMicrotask(()=>stream.push({type:'start',partial:message}));const abort=()=>{stream.push({type:'error',reason:'aborted',error:{...message,stopReason:'aborted',errorMessage:'Owned task aborted'}});stream.end();};if(options?.signal?.aborted)abort();else options?.signal?.addEventListener('abort',abort,{once:true});return stream;}
  const last = context.messages.at(-1);
  const prompt = last?.role === 'user' && Array.isArray(last.content)
    ? last.content.find((part) => part.type === 'text')?.text
    : last?.role === 'user' ? last.content : undefined;
  if (process.env.PI_HUB_TEST_REMOTE_RESULTS && typeof prompt === 'string' && prompt.startsWith('owned-remote:')) {
    message.stopReason = 'toolUse';
    message.content = [{ type: 'toolCall', id: randomUUID(), name: 'pi_hub_remote', arguments: JSON.parse(prompt.slice('owned-remote:'.length)) }];
  }
  queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason as 'stop' | 'toolUse',message});stream.end();});return stream;
 }});
 const results = process.env.PI_HUB_TEST_REMOTE_RESULTS;
 if (results) pi.on('tool_result', (event, ctx) => {
  if (event.toolName === 'pi_hub_remote') appendFileSync(results, JSON.stringify({ cwd: ctx.cwd, content: event.content, isError: event.isError }) + '\n');
 });
 pi.registerCommand('hub-test-quit',{handler:async(_,ctx)=>ctx.shutdown()});
}
