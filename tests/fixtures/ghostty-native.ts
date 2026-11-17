import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TerminalTarget } from '../../src/session-management/interface';
const exec=promisify(execFile);
export const ghosttyMetadata=`tell application id "com.mitchellh.ghostty"
 set resultText to ""
 repeat with w in windows
  repeat with t in tabs of w
   repeat with term in terminals of t
    set resultText to resultText & (id of w as text) & (ASCII character 9) & (id of t as text) & (ASCII character 9) & (id of term as text) & (ASCII character 9) & (tty of term) & linefeed
   end repeat
  end repeat
 end repeat
 return resultText
end tell`;
export async function ownedGhosttyAction(target:TerminalTarget,action:string,text=''){
 return exec('/usr/bin/osascript',['-e',`on run argv
 tell application id "com.mitchellh.ghostty"
  repeat with w in windows
   if (id of w as text) is (item 1 of argv) then
    repeat with t in tabs of w
     if (id of t as text) is (item 2 of argv) then
      repeat with term in terminals of t
       if (id of term as text) is (item 3 of argv) and tty of term is (item 4 of argv) then
        if (item 5 of argv) is "close" then
         close term
        else if (item 5 of argv) is "interrupt" then
         send key "c" modifiers "control" to term
        else
         input text (item 6 of argv) to term
         send key "enter" to term
        end if
        return "owned-object-verified"
       end if
      end repeat
     end if
    end repeat
   end if
  end repeat
  error "Owned Ghostty object changed"
 end tell
end run`,String(target.windowId),target.tabId!,target.terminalId!,target.tty,action,text]);
}

import { setTimeout } from 'node:timers/promises';
import { observeProcess } from '../../src/session-management/runtime-process';
/** Recovery for a returned, task-owned surface when Pi identification fails before the assertion. */
export async function cleanupReturnedGhosttyTarget(target:TerminalTarget,root:string){
 const rows=(await exec('/usr/bin/osascript',['-e',ghosttyMetadata])).stdout.trim().split('\n').map(l=>l.split('\t'));
 if(!rows.some(r=>r[0]===target.windowId&&r[1]===target.tabId&&r[2]===target.terminalId&&r[3]===target.tty))return {target,alreadyAbsent:true};
 const processes=(await exec('/bin/ps',['-ww','-t',target.tty.slice(5),'-o','pid=','-o','command='])).stdout.trim().split('\n');
 const owned: {pid:number;startIdentity:string;tty:string|null}[]=[];let hasPi=false;
 for(const line of processes){const match=line.trim().match(/^(\d+)\s+(.+)$/);if(!match)continue;const pid=Number(match[1]),command=match[2]!;
  const cwd=(await exec('/usr/sbin/lsof',['-a','-p',String(pid),'-d','cwd','-Fn']).catch(()=>({stdout:''}))).stdout;
  if(!command.includes(root)&&!(cwd.split('\n').some(line=>line==='n'+root||line.startsWith('n'+root+'/'))&&/^(?:pi|\/bin\/sleep)(?:\s|$)/.test(command)))continue;
  const os=await observeProcess(pid).catch(()=>null);if(os?.tty===target.tty){owned.push({pid,...os});if(/^pi(?:\s|$)/.test(command))hasPi=true;}
 }
 if(owned.length){for(const p of owned){const now=await observeProcess(p.pid).catch(()=>null);if(now&&(now.startIdentity!==p.startIdentity||now.tty!==p.tty))throw Error('Owned process changed before cleanup');}
  await ownedGhosttyAction(target,hasPi?'input':'interrupt',hasPi?'/hub-test-quit':'');
  const deadline=Date.now()+10000;for(;;){const live=(await Promise.all(owned.map(async p=>{const now=await observeProcess(p.pid).catch(()=>null);return now?.startIdentity===p.startIdentity&&now.tty===p.tty;}))).some(Boolean);if(!live)break;if(Date.now()>deadline)throw Error('Owned process did not exit; surface retained');await setTimeout(100);}
 }
 // Recheck native PID and the exact IDs after exit; an unfamiliar live process is never closed.
 const nativePid=Number((await exec('/usr/bin/osascript',['-e',`on run argv
 tell application id "com.mitchellh.ghostty"
  repeat with w in windows
   if (id of w as text) is (item 1 of argv) then
    repeat with t in tabs of w
     if (id of t as text) is (item 2 of argv) then
      repeat with term in terminals of t
       if (id of term as text) is (item 3 of argv) and tty of term is (item 4 of argv) then return pid of term
      end repeat
     end if
    end repeat
   end if
  end repeat
  error "Owned surface changed"
 end tell
end run`,String(target.windowId),target.tabId!,target.terminalId!,target.tty])).stdout.trim());
 if(!Number.isInteger(nativePid)||nativePid<0)throw Error('Unknown native process identity');
 if(nativePid&&await observeProcess(nativePid).catch(()=>null))throw Error('Live native process remains; surface retained');
 await ownedGhosttyAction(target,'close');return {target,owned,osExited:true,objectClosed:true};
}

/** Discover only newly created fixture surfaces with an OS command referring to this run's private root. */
export async function findOwnedGhosttyTargets(root:string,baseline:string){
 const previous=new Set(baseline.trim().split('\n'));const lines=(await exec('/usr/bin/osascript',['-e',ghosttyMetadata])).stdout.trim().split('\n');const owned:TerminalTarget[]=[];
 for(const line of lines){if(!line||previous.has(line))continue;const parts=line.split('\t');if(parts.length!==4)continue;const processes=await exec('/bin/ps',['-ww','-t',parts[3]!.slice(5),'-o','command=']).catch(()=>({stdout:''}));if(!processes.stdout.includes(root))continue;owned.push({terminal:'Ghostty',windowId:parts[0]!,tabId:parts[1]!,terminalId:parts[2]!,tty:parts[3]!});}
 return owned;
}

import type { Page } from '@playwright/test';
import { readdir,readFile } from 'node:fs/promises';
import { join } from 'node:path';
/** The startup receipt supplies only the request ID; the public coordinator returns actual object ownership. */
export async function captureGhosttyLaunchTargets(page:Page,root:string){
 const directory=join(root,'profile','terminal-launches'),files=await readdir(directory).catch(()=>[]),targets:TerminalTarget[]=[];
 for(const file of files.filter(f=>f.endsWith('.status.json'))){let requestId:string;try{requestId=JSON.parse(await readFile(join(directory,file),'utf8')).requestId;}catch{continue;}
  const result=await page.evaluate(id=>window.sessionManagement.getTerminalOutcome({requestId:id}),requestId);if(result.status==='completed'&&result.value?.target?.terminal==='Ghostty')targets.push(result.value.target);
 }
 return targets;
}
