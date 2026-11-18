import {execFileSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkProject} from './check-project.mjs';
import {buildInputs, writeBuildReceipt, digest} from './lib/build-artifacts.mjs';
import { build as bundle } from 'esbuild';
import { build as vite } from 'vite';
import { rm, mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
const repository = fileURLToPath(new URL('../', import.meta.url));
await checkProject(repository);
const inputs = await buildInputs(repository);
const remoteAssets={};
for(const name of ['runner.py','supervisor.py','transfer.py','sftp.py','acceptance.py','cli.mjs']) remoteAssets[name]=digest(await readFile('src/remote/'+name));
// Keep dist/packages so building one architecture does not delete the other release.
await Promise.all(['desktop','renderer','terminal','remote'].map(dir=>rm(`dist/${dir}`, { recursive: true, force: true })));
await mkdir('dist/remote',{recursive:true});
const headers=resolve(dirname(process.execPath),'../include/node');
execFileSync('/usr/bin/clang++',['-std=c++17','-shared','-fPIC','-O2','-DNAPI_VERSION=8','-I'+headers,...(process.platform==='darwin'?['-arch','x86_64','-arch','arm64','-undefined','dynamic_lookup']:[]),'src/remote/secure-fs.cc','-o','dist/remote/secure-fs.node'],{stdio:'inherit'});
remoteAssets['secure-fs.node']=digest(await readFile('dist/remote/secure-fs.node'));
await bundle({entryPoints:['src/remote/acceptance-cli.ts'],outfile:'dist/remote/acceptance-cli.mjs',bundle:true,platform:'node',format:'esm',target:'node24',define:{__REMOTE_BASE_ASSETS__:JSON.stringify(remoteAssets)}});
remoteAssets['acceptance-cli.mjs']=digest(await readFile('dist/remote/acceptance-cli.mjs'));
await bundle({
  entryPoints: ['src/desktop/main.ts', 'src/desktop/preload.ts', 'src/desktop/utility.ts', 'src/desktop/remote-utility.ts'],
  outdir: 'dist/desktop', outExtension: { '.js': '.cjs' }, bundle: true,
  platform: 'node', format: 'cjs', target: 'node24', packages: 'external',
  sourcemap: true, define:{__REMOTE_ASSET_DIGESTS__:JSON.stringify(remoteAssets)},
});
await vite({ configFile: false, root: 'src/renderer', base: './', build: { outDir: '../../dist/renderer', emptyOutDir: true } });

await mkdir('dist/terminal',{recursive:true});
await copyFile('src/terminal/sdk-host.mjs','dist/terminal/sdk-host.mjs');

await mkdir('dist/remote',{recursive:true});
for(const name of ['runner.py','supervisor.py','transfer.py','sftp.py','acceptance.py','cli.mjs']) {
  await copyFile('src/remote/'+name,'dist/remote/'+name);
  remoteAssets[name]=digest(await readFile('dist/remote/'+name));
}
await writeFile('dist/remote/assets.json', JSON.stringify(remoteAssets,null,2)+'\n');
await writeBuildReceipt(repository, inputs);
