import {test,expect} from '@playwright/test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {launchOwnedElectron,observeOwnedShutdown} from '../fixtures/owned-electron';
const exec=promisify(execFile);

test('native directory picker cancels without changes, adds the exact chosen directory, and Cmd+Q quits normally',async()=>{
 test.skip(process.env.PI_HUB_TEST_NATIVE!=='1','Explicit serial native run');
 test.setTimeout(90000);
 const root=await mkdtemp(join(tmpdir(),'pi-hub-native-shell-')),project=join(root,'原生选择 中文 空格');
 const evidence=resolve(process.env.PI_HUB_TEST_EVIDENCE!,'native-shell');
 await mkdir(project);await mkdir(evidence,{recursive:true});
 const app=await launchOwnedElectron(root,join(root,'profile'),join(root,'agent'),join(root,'sessions'),evidence);
 let closed=false;const checks:string[]=[];
 const target=`first application process whose unix id is ${app.process().pid}`;
 const os=async(body:string)=>(await exec('/usr/bin/osascript',['-e',`tell application "System Events" to tell ${target}\n${body}\nend tell`],{timeout:15000})).stdout.trim();
 const sheetCount=async()=>{try{return await os('get count of sheets of window 1');}catch{return '0';}};
 // Every keyboard action is directed to the checked owned process, never the global foreground app.
 const key=async(command:string)=>{await os('set frontmost to true');expect(await os('get frontmost')).toBe('true');await os(command);};
 try{
  const page=await app.firstWindow();
  await expect(page.getByRole('heading',{name:'从一个项目开始'})).toBeVisible();
  const add=page.getByRole('button',{name:'添加项目',exact:true}).first();
  await add.click();await expect.poll(sheetCount).toBe('1');await key('key code 53');await expect.poll(sheetCount).toBe('0');
  await expect(page.getByRole('heading',{name:'从一个项目开始'})).toBeVisible();
  expect(await page.evaluate(async()=>{const r=await window.sessionManagement.getSnapshot();if(r.status==='failed')throw Error(r.error.message);return r.value.projects.length;})).toBe(0);
  checks.push('native cancel keeps the public workspace empty');
  await add.click();await expect.poll(sheetCount).toBe('1');await key('keystroke "g" using {command down, shift down}');
  await expect.poll(async()=>{try{return await os('get count of text fields of sheet 1 of sheet 1 of window 1');}catch{return '0';}}).toBe('1');
  await os(`set value of text field 1 of sheet 1 of sheet 1 of window 1 to ${JSON.stringify(project)}`);
  await key('key code 36');
  await expect.poll(async()=>await os('get count of sheets of sheet 1 of window 1')).toBe('0');
  await os('click button "选择目录" of sheet 1 of window 1');
  await page.getByRole('button',{name:'确认添加项目',exact:true}).click();
  await expect(page.getByRole('button',{name:/原生选择 中文 空格/})).toBeVisible();
  const paths=await page.evaluate(async()=>{const r=await window.sessionManagement.getSnapshot();if(r.status==='failed')throw Error(r.error.message);return r.value.projects.map(p=>p.path);});
  // macOS /var canonicalization is permitted by the native directory chooser.
  const {realpath}=await import('node:fs/promises');expect(await Promise.all(paths.map(p=>realpath(p)))).toEqual([await realpath(project)]);
  await page.screenshot({path:join(evidence,'native-project.png')});
  checks.push('real native chooser commits only the chosen directory through IPC and SQLite');
  await observeOwnedShutdown(app,evidence,async()=>{const event=app.waitForEvent('close');await key('keystroke "q" using command down');await event;closed=true;});
  checks.push('targeted native Cmd+Q exits the app normally and all owned PIDs disappear');
 }finally{
  if(!closed)await app.close();
  await writeFile(join(evidence,'result.json'),JSON.stringify({checks,closed},null,2));
  await rm(root,{recursive:true,force:true});
 }
});
