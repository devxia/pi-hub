import {piInstallation} from '../fixtures/pi-installation';
import {test,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ghosttyAdapter} from '../../src/desktop/ghostty-adapter';
import {closeSessionTerminal} from '../../src/desktop/close-session-terminal';
import {observeProcess} from '../../src/session-management/runtime-process';
import {ghosttyMetadata,cleanupReturnedGhosttyTarget} from '../fixtures/ghostty-native';
import type {TerminalTarget} from '../../src/session-management/interface';
const exec=promisify(execFile);
test.runIf(process.env.PI_HUB_TEST_REAL_GHOSTTY==='1')('closing one exited Ghostty surface preserves the other split and its live process',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'pi-close-split-'))),evidence=process.env.PI_HUB_TEST_EVIDENCE!;await mkdir(evidence,{recursive:true});const baseline=(await exec('/usr/bin/osascript',['-e',ghosttyMetadata])).stdout;let original:TerminalTarget|undefined,split:TerminalTarget|undefined;const facts:any={root};
 async function sleepProcess(target:TerminalTarget){let result:any;await expect.poll(async()=>{const rows=(await exec('/bin/ps',['-t',target.tty.slice(5),'-o','pid=','-o','comm='])).stdout;const found=rows.match(/(\d+)\s+(?:\/bin\/)?sleep\s*$/m);if(!found)return false;result={pid:Number(found[1]),...await observeProcess(Number(found[1]))};return true;}).toBe(true);return result;}
 try{
  original=await ghosttyAdapter.launch!({hostId:'owned',requestId:'owned-close-surface',appData:root,cwd:root,executable:'/bin/sleep',argv:['4'],env:{HOME:root,PATH:'/usr/bin:/bin'},credentialPath:join(root,'unused'),statusPath:join(root,'unused-status'),runtimeNodePath:process.execPath,startupAssetPath:'',sdk:{packagePath:root,entryPath:root,version:piInstallation.version,packageIdentity:'unused',manifestHash:'unused',entryHash:'unused'},sessionDir:root,targetIdentity:'unused'});const first=await sleepProcess(original);facts.original={target:original,process:first};
  const script=join(root,'second.sh');await writeFile(script,'#!/bin/sh\nexec /bin/sleep 120\n',{mode:0o700});const output=(await exec('/usr/bin/osascript',['-e',`on run argv
 tell application id "com.mitchellh.ghostty"
  set w to window id (item 1 of argv)
  set t to tab id (item 2 of argv) of w
  set original to terminal id (item 3 of argv) of t
  if tty of original is not (item 4 of argv) then error "Original surface changed"
  set config to new surface configuration
  set command of config to "/bin/sh '" & (item 5 of argv) & "'"
  set initial working directory of config to item 6 of argv
  set environment variables of config to {"HOME=" & (item 6 of argv), "PATH=/usr/bin:/bin"}
  set wait after command of config to true
  set created to split original direction right with configuration config
  repeat 100 times
   if tty of created is not "" then exit repeat
   delay 0.02
  end repeat
  return (id of created as text) & (ASCII character 9) & tty of created
 end tell
end run`,String(original.windowId),original.tabId!,original.terminalId!,original.tty,script,root])).stdout.trim().split('\t');split={...original,terminalId:output[0],tty:output[1]};const second=await sleepProcess(split);facts.split={target:split,process:second};await expect.poll(async()=>{try{await observeProcess(first.pid);return false;}catch{return true;}},{timeout:10000}).toBe(true);
  await closeSessionTerminal('Ghostty',{...first,tty:original.tty,target:original});expect(await observeProcess(second.pid)).toMatchObject({startIdentity:second.startIdentity,tty:split.tty});const after=(await exec('/usr/bin/osascript',['-e',ghosttyMetadata])).stdout;expect(after).not.toContain(original.terminalId!);expect(after).toContain(split.terminalId!);expect(baseline.trim().split('\n').filter(Boolean).every(row=>after.includes(row))).toBe(true);facts.otherSplitSurvived=true;facts.status='passed';
 }finally{facts.cleanup=[];if(original)facts.cleanup.push(await cleanupReturnedGhosttyTarget(original,root));if(split)facts.cleanup.push(await cleanupReturnedGhosttyTarget(split,root));await writeFile(join(evidence,'split-close.json'),JSON.stringify(facts,null,2));await rm(root,{recursive:true,force:true});}
},30000);
