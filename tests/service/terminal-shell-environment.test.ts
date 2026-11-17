import {piInstallation} from '../fixtures/pi-installation';
import {test,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {prepareLaunch} from '../../src/desktop/terminal-adapter';
import {prepareManualHandoff} from '../../src/session-management/manual-handoff';
import type {TerminalLaunchDescriptor} from '../../src/session-management/terminal';
const exec=promisify(execFile);
test('native launch loads the user interactive environment without persisting its credentials',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pi-shell-env-')),home=join(root,'home'),app=join(root,'app'),bin=join(home,'user-bin');await mkdir(bin,{recursive:true});await mkdir(app);const sentinel='owned-credential-from-interactive-shell';await writeFile(join(home,'.zshrc'),`export FIRECRAWL_API_KEY='${sentinel}'\nexport PATH='${bin}':"$PATH"\n`);const probe=join(root,'probe.mjs');await writeFile(probe,`console.log(JSON.stringify({keyPresent:!!process.env.FIRECRAWL_API_KEY,userBinPresent:(process.env.PATH??'').split(':').includes(${JSON.stringify(bin)}),home:process.env.HOME}));`);
 const descriptor:TerminalLaunchDescriptor={hostId:'owned',credentialPath:join(app,'credential.json'),requestId:'shell-env',attemptId:'manual-environment',statusPath:join(app,'status.json'),runtimeNodePath:process.execPath,startupAssetPath:probe,sdk:{packagePath:root,entryPath:probe,version:piInstallation.version,packageIdentity:'owned',manifestHash:'owned',entryHash:'owned'},sessionDir:root,targetIdentity:'owned',cwd:root,executable:process.execPath,argv:[],appData:app,env:{HOME:home,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',SHELL:'/bin/zsh',PI_CODING_AGENT_DIR:join(home,'.pi/agent')}};
 try{const script=await prepareLaunch(descriptor),result=await exec('/bin/sh',[script],{env:{HOME:home,SHELL:'/bin/zsh',PATH:'/usr/bin:/bin:/usr/sbin:/sbin',TERM:'xterm-256color'},timeout:10000,maxBuffer:8192});const observed=JSON.parse(result.stdout.trim().split('\n').at(-1)!);expect(observed).toMatchObject({keyPresent:true,userBinPresent:true,home});const handoff=await prepareManualHandoff(descriptor),manual=await exec('/bin/sh',['-c',handoff.command],{env:{HOME:home,SHELL:'/bin/zsh',PATH:'/usr/bin:/bin:/usr/sbin:/sbin',TERM:'xterm-256color'},timeout:10000,maxBuffer:8192});expect(JSON.parse(manual.stdout.trim().split('\n').at(-1)!)).toMatchObject({keyPresent:true,userBinPresent:true,home});for(const file of await readdir(join(app,'terminal-launches'))){expect(await readFile(join(app,'terminal-launches',file),'utf8')).not.toContain(sentinel);}}
 finally{await rm(root,{recursive:true,force:true});}
},15000);
