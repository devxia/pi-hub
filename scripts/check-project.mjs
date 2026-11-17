import {builtinModules, createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolve, relative, isAbsolute, join} from 'node:path';
import {build} from 'esbuild';
import {filesUnder} from './lib/build-artifacts.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
export function checkPackagePolicy(config) {
  const patterns = config.packagerConfig?.ignore;
  if (!Array.isArray(patterns) || patterns.some(pattern => !(pattern instanceof RegExp))) throw Error('Package exclusions must be explicit regular expressions.');
  const excluded = path => patterns.some(pattern => { pattern.lastIndex = 0; return pattern.test(path); });
  const accepted = ['/package.json', '/node_modules', '/node_modules/example/index.js', '/dist', '/dist/desktop', '/dist/desktop/main.cjs', '/dist/renderer/assets/app.js', '/dist/terminal/sdk-host.mjs'];
  const rejected = ['/tests/example.spec.ts', '/.scratch/evidence.json', '/scripts/build.mjs', '/out/old.app', '/assets/readme/hero.svg', '/dist/packages/Pi Hub.app/Contents/MacOS/Pi Hub', '/dist/build-receipt.json', '/dist/unknown/file.js'];
  for (const path of accepted) if (excluded(path)) throw Error('Required runtime path excluded: ' + path);
  for (const path of rejected) if (!excluded(path)) throw Error('Development/output path can enter a package: ' + path);
}
export async function checkRendererBoundaries(root) {
  const entries = (await filesUnder(root)).filter(path => /\.[cm]?[jt]sx?$/.test(path) && !path.endsWith('.d.ts'));
  await build({entryPoints: entries, bundle: true, write: false, outdir: 'unused-renderer-check', platform: 'browser', logLevel: 'silent', plugins: [{
    name: 'renderer-runtime-boundary',
    setup(context) {
      context.onResolve({filter: /.*/}, args => {
        if (!args.importer) return;
        const name = args.path;
        if (name === 'electron' || name.startsWith('electron/') || name.startsWith('node:') || builtins.has(name)) return {errors: [{text: 'Renderer must use the trusted preload API, not ' + name, location: null}]};
        // Every renderer file is parsed as its own entry. Dependencies need not be executed or bundled.
        return {path: name, external: true};
      });
    },
  }]});
  return entries.length;
}
export async function checkProject(root = repository) {
  const require = createRequire(join(root, 'package.json'));
  checkPackagePolicy(require(join(root, 'forge.config.cjs')));
  const rendererFiles = await checkRendererBoundaries(join(root, 'src/renderer'));
  return {packagePolicy: true, rendererFiles};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await checkProject(), null, 2));
}
