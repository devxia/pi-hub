import {fileURLToPath} from 'node:url';
import {checkProject} from './check-project.mjs';
import {buildInputs, writeBuildReceipt} from './lib/build-artifacts.mjs';
import { build as bundle } from 'esbuild';
import { build as vite } from 'vite';
import { rm, mkdir, copyFile } from 'node:fs/promises';
const repository = fileURLToPath(new URL('../', import.meta.url));
await checkProject(repository);
const inputs = await buildInputs(repository);
// Keep dist/packages so building one architecture does not delete the other release.
await Promise.all(['desktop','renderer','terminal'].map(dir=>rm(`dist/${dir}`, { recursive: true, force: true })));
await bundle({
  entryPoints: ['src/desktop/main.ts', 'src/desktop/preload.ts', 'src/desktop/utility.ts'],
  outdir: 'dist/desktop', outExtension: { '.js': '.cjs' }, bundle: true,
  platform: 'node', format: 'cjs', target: 'node24', packages: 'external',
  sourcemap: true,
});
await vite({ configFile: false, root: 'src/renderer', base: './', build: { outDir: '../../dist/renderer', emptyOutDir: true } });

await mkdir('dist/terminal',{recursive:true});
await copyFile('src/terminal/sdk-host.mjs','dist/terminal/sdk-host.mjs');

await writeBuildReceipt(repository, inputs);
