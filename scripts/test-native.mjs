import {spawn} from 'node:child_process';
import {mkdir,writeFile,access} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,resolve,isAbsolute} from 'node:path';
import {verifyLatestPi} from '../tests/fixtures/pi-installation.ts';

const repository=fileURLToPath(new URL('../',import.meta.url));
process.chdir(repository);
if(process.platform!=='darwin')throw Error('Native checks require macOS, Terminal and Ghostty.');
if(!process.env.PI_HUB_TEST_APP||!isAbsolute(process.env.PI_HUB_TEST_APP))throw Error('Set PI_HUB_TEST_APP to the absolute packaged Pi Hub executable; no installed default is assumed.');
await access(process.env.PI_HUB_TEST_APP);
const evidence=resolve(process.env.PI_HUB_TEST_EVIDENCE??join('.scratch','native-tests',new Date().toISOString().replaceAll(':','-')));
await mkdir(evidence,{recursive:true});
const version=verifyLatestPi();
await writeFile(join(evidence,'pi-version.json'),JSON.stringify(version,null,2));
const env={...process.env,PI_HUB_TEST_EVIDENCE:evidence,PI_HUB_TEST_PI_VERSION:version.latest,PI_HUB_TEST_NATIVE:'1',PI_HUB_TEST_REAL_GHOSTTY:'1'};
const results=[];
for(const [name,args] of [
 ['surfaces',['node_modules/vitest/vitest.mjs','run','tests/native','--maxWorkers=1']],
 ['macos',['node_modules/@playwright/test/cli.js','test','--project=desktop-foreground','--project=native']],
]){
 const log=createWriteStream(join(evidence,name+'.log'));
 const startedAt=new Date().toISOString();
 const child=spawn(process.execPath,args,{cwd:repository,env,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',chunk=>{log.write(chunk);process.stdout.write(chunk);});
 child.stderr.on('data',chunk=>{log.write(chunk);process.stderr.write(chunk);});
 const code=await new Promise((accept,reject)=>{child.on('error',reject);child.on('close',accept);});
 await new Promise(done=>log.end(done));
 results.push({name,startedAt,finishedAt:new Date().toISOString(),code});
 await writeFile(join(evidence,'results.json'),JSON.stringify(results,null,2));
 if(code!==0){process.exitCode=typeof code==='number'?code:1;break;}
}
