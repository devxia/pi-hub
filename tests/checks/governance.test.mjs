import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import * as asar from '@electron/asar';
import {checkRendererBoundaries, checkPackagePolicy} from '../../scripts/check-project.mjs';
import {checkPackage, machOArchitectures, checkArchiveEntries} from '../../scripts/check-package.mjs';
import {buildInputs, writeBuildReceipt, verifyBuildReceipt} from '../../scripts/lib/build-artifacts.mjs';
import {isolateClipboard} from '../fixtures/clipboard.ts';

async function temporary(run) {
  const root = await mkdtemp(join(tmpdir(), 'pi-hub-governance-check-'));
  try { await run(root); } finally { await rm(root, {recursive: true, force: true}); }
}
async function put(root, path, content) {
  const target = join(root, path);
  await mkdir(join(target, '..'), {recursive: true});
  await writeFile(target, content);
}
function machO(arch) {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(arch === 'x64' ? 0x01000007 : 0x0100000c, 4);
  return header;
}

test('renderer parser ignores comments, text and type imports but rejects executable Node/Electron dependencies', () => temporary(async root => {
  const path = join(root, 'entry.ts');
  await writeFile(path, '// import x from "electron"\nimport type {Stats} from "node:fs";\nexport const note = "require(node:fs)";\n');
  assert.equal(await checkRendererBoundaries(root), 1);
  for (const code of [
    'import {ipcRenderer} from "electron"; console.log(ipcRenderer);',
    'export {readFileSync} from "fs";',
    'console.log(require("node:child_process"));',
    'void import("node:fs/promises");',
  ]) {
    await writeFile(path, code);
    await assert.rejects(checkRendererBoundaries(root), /trusted preload API/);
  }
}));

test('actual Forge policy rejects nested outputs and build receipts without excluding runtime directories', () => {
  const require = createRequire(import.meta.url), forge = require('../../forge.config.cjs');
  checkPackagePolicy(forge);
  assert.throws(() => checkPackagePolicy({packagerConfig: {ignore: [/^\/(?!package\.json$|node_modules(?:\/|$)|dist(?:\/|$))/]}}), /Development\/output path/);
  checkArchiveEntries(['/package.json', '/dist', '/dist/desktop/main.cjs', '/node_modules/example/index.js']);
  for (const path of ['/tests/business.test.ts', '/.scratch/receipt.json', '/dist/packages/old.app', '/dist/build-receipt.json']) assert.throws(() => checkArchiveEntries([path]), /Unexpected development\/output/);
});

test('Mach-O parser distinguishes architectures and rejects truncated binaries', () => {
  assert.deepEqual(machOArchitectures(machO('x64')), ['x64']);
  assert.deepEqual(machOArchitectures(machO('arm64')), ['arm64']);
  assert.throws(() => machOArchitectures(Buffer.from('not executable')), /Not a Mach-O/);
  const fat = Buffer.alloc(8); fat.writeUInt32BE(0xcafebabe); fat.writeUInt32BE(2, 4);
  assert.throws(() => machOArchitectures(fat), /Invalid fat/);
});

async function packageFixture(root) {
  for (const [path, content] of Object.entries({
    'src/renderer/main.tsx': 'export const app = 1;', 'scripts/build.mjs': '// synthetic build',
    'package.json': JSON.stringify({name: 'pi-hub', productName: 'Pi Hub', version: '0.1.0', dependencies: {'@earendil-works/pi-coding-agent': '1.5.2'}}),
    'package-lock.json': '{}', 'forge.config.cjs': '{}', 'tsconfig.json': '{}', 'docs/design/clear-order.tokens.css': ':root{}',
    'dist/desktop/main.cjs': 'console.log(1);', 'dist/renderer/index.html': '<main></main>', 'dist/terminal/sdk-host.mjs': 'export {};',
  })) await put(root, path, content);
  const receipt = await writeBuildReceipt(root), app = join(root, 'fixture.app');
  const files = join(root, 'archive-input');
  await put(files, 'package.json', await readFile(join(root, 'package.json')));
  await put(files, 'node_modules/@earendil-works/pi-coding-agent/package.json', '{"version":"1.5.2"}');
  for (const path of Object.keys(receipt.runtime)) await put(files, path, await readFile(join(root, path)));
  const archive = join(app, 'Contents/Resources/app.asar');
  await mkdir(join(archive, '..'), {recursive: true});
  await asar.createPackage(files, archive);
  for (const path of [
    'Contents/MacOS/Pi Hub', 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
    'Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/darwin-x64.node',
    'Contents/Resources/app.asar.unpacked/node_modules/@earendil-works/pi-tui/native/darwin/prebuilds/darwin-x64/darwin-platform.node',
  ]) await put(app, path, machO('x64'));
  return {app, archive, files};
}

test('package gate binds current build and catches wrong CPU, changed assets and unexpected output files', () => temporary(async root => {
  const {app, archive, files} = await packageFixture(root);
  assert.equal((await checkPackage({root, app, arch: 'x64'})).runtimeAssets, 3);
  const binary = 'Contents/MacOS/Pi Hub';
  await put(app, binary, machO('arm64'));
  await assert.rejects(checkPackage({root, app, arch: 'x64'}), /CPU mismatch/);
  await put(app, binary, machO('x64'));
  await put(files, 'dist/desktop/main.cjs', 'tampered();');
  await asar.createPackage(files, archive);
  asar.uncache(archive);
  await assert.rejects(checkPackage({root, app, arch: 'x64'}), /Runtime asset mismatch/);
  await put(files, 'dist/desktop/main.cjs', await readFile(join(root, 'dist/desktop/main.cjs')));
  await put(files, 'dist/packages/old.app/Contents/Info.plist', 'unwanted old package');
  await asar.createPackage(files, archive);
  asar.uncache(archive);
  await assert.rejects(checkPackage({root, app, arch: 'x64'}), /Unexpected development\/output path/);
}));

test('receipt rejects source and runtime changes after build', () => temporary(async root => {
  await packageFixture(root);
  await verifyBuildReceipt(root);
  const startedWith = await buildInputs(root);
  await put(root, 'src/renderer/main.tsx', 'changed source');
  await assert.rejects(verifyBuildReceipt(root), /Build inputs changed/);
  await assert.rejects(writeBuildReceipt(root, startedWith), /Build inputs changed during compilation/);
  await writeBuildReceipt(root);
  await put(root, 'dist/desktop/main.cjs', 'changed output');
  await assert.rejects(verifyBuildReceipt(root), /Build runtime changed/);
}));

test('clipboard boundary stays in memory on success, cancellation and thrown assertions; unknown APIs cannot fall through', () => {
  let osCalls = 0;
  const clipboard = Object.fromEntries(['writeText', 'readText', 'clear', 'readImage', 'writeHTML'].map(name => [name, () => { osCalls++; throw Error('Real OS boundary reached'); }]));
  Object.defineProperty(clipboard, 'readBuffer', {value: () => { osCalls++; }, writable: true});
  Object.setPrototypeOf(clipboard, {writeImage() { osCalls++; }});
  const state = isolateClipboard({clipboard});
  clipboard.writeText('baseline');
  // Cancelling a menu performs no write.
  assert.equal(clipboard.readText(), 'baseline');
  assert.equal(state.writes, 1);
  clipboard.writeText('complete-native-id');
  assert.equal(clipboard.readText(), 'complete-native-id');
  assert.throws(() => { assert.equal(clipboard.readText(), 'simulate a failing assertion'); });
  assert.equal(state.text, 'complete-native-id');
  assert.throws(() => clipboard.readImage(), /Unsupported clipboard operation/);
  assert.throws(() => clipboard.readBuffer(), /Unsupported clipboard operation/);
  assert.throws(() => clipboard.writeImage(), /Unsupported clipboard operation/);
  assert.equal(osCalls, 0);
  assert.equal(state.clears, 0);
  delete globalThis.ownedClipboard;
});

test('quiet Electron boundary suppresses native activation, leaves data untouched and rejects unexpected native dialogs', () => {
  const require=createRequire(import.meta.url), install=require('../fixtures/quiet-electron.cjs');
  let osCalls=0,policy;
  class NativeWindow {
    constructor(options){this.options=options;this.id=1;this.listeners={};}
    on(name,listener){this.listeners[name]=listener;}
    show(){osCalls++;} focus(){osCalls++;} hide(){this.hidden=true;} blur(){this.blurred=true;}
  }
  const electron={app:{setActivationPolicy(value){policy=value;},focus(){osCalls++;}},dialog:{showOpenDialog(){osCalls++;}},Menu:class {popup(){osCalls++;}},business:{snapshot:'unchanged'}};
  Object.defineProperty(electron,'BrowserWindow',{get:()=>NativeWindow,configurable:false});
  const quiet=install(electron),window=new quiet.BrowserWindow({show:true,focusable:true,width:860});
  assert.equal(electron.BrowserWindow,NativeWindow);
  assert.equal(quiet.business,electron.business);
  assert.equal(policy,'prohibited');
  assert.deepEqual(window.options,{show:false,focusable:false,width:860});
  window.show();window.focus();window.moveTop();quiet.app.focus();
  assert.equal(osCalls,0);
  assert.equal(globalThis.ownedQuietWindows.suppressed.length,4);
  assert.throws(()=>quiet.dialog.showOpenDialog(),/explicit OS boundary/);
  assert.throws(()=>new quiet.Menu().popup(),/explicit OS boundary/);
  window.listeners.show();window.listeners.focus();
  assert.equal(globalThis.ownedQuietWindows.violations.length,2);
  assert.equal(window.hidden,true);assert.equal(window.blurred,true);
  delete globalThis.ownedQuietWindows;
});
