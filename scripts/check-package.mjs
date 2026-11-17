import * as asar from '@electron/asar';
import {open, readFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {join, resolve} from 'node:path';
import {digest, verifyBuildReceipt} from './lib/build-artifacts.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const cpuNames = new Map([[0x01000007, 'x64'], [0x0100000c, 'arm64'], [7, 'x86']]);
export function machOArchitectures(header) {
  if (header.length < 8) throw Error('Truncated Mach-O header.');
  const magic = header.readUInt32BE(0);
  let cpus;
  if ([0xcffaedfe, 0xcefaedfe].includes(magic)) cpus = [header.readUInt32LE(4)];
  else if ([0xfeedfacf, 0xfeedface].includes(magic)) cpus = [header.readUInt32BE(4)];
  else if ([0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca].includes(magic)) {
    const read = magic === 0xbebafeca || magic === 0xbfbafeca ? offset => header.readUInt32LE(offset) : offset => header.readUInt32BE(offset);
    const count = read(4), stride = magic === 0xcafebabf || magic === 0xbfbafeca ? 32 : 20;
    if (!count || count > 128 || 8 + count * stride > header.length) throw Error('Invalid fat Mach-O header.');
    cpus = Array.from({length: count}, (_, index) => read(8 + index * stride));
  } else throw Error('Not a Mach-O binary.');
  return cpus.map(cpu => {
    const name = cpuNames.get(cpu);
    if (!name) throw Error('Unsupported Mach-O CPU: ' + cpu);
    return name;
  });
}
export function checkArchiveEntries(entries) {
  for (const entry of entries) {
    if (!/^\/(?:package\.json$|node_modules(?:\/|$)|dist(?:\/|$))/.test(entry) || /^\/dist\/(?!desktop(?:\/|$)|renderer(?:\/|$)|terminal(?:\/|$))/.test(entry) || /\.app(?:\/|$)/i.test(entry)) {
      throw Error('Unexpected development/output path in package: ' + entry);
    }
  }
}
async function checkCPU(path, arch) {
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(8192), {bytesRead} = await file.read(header, 0, header.length, 0);
    const actual = machOArchitectures(header.subarray(0, bytesRead));
    if (actual.length !== 1 || actual[0] !== arch) throw Error('CPU mismatch: ' + path + ' = ' + actual.join(','));
    return actual[0];
  } finally { await file.close(); }
}
export async function checkPackage({app, arch, root = repository}) {
  if (!['x64', 'arm64'].includes(arch)) throw Error('Specify x64 or arm64.');
  const receipt = await verifyBuildReceipt(root), archive = join(app, 'Contents/Resources/app.asar');
  const entries = asar.listPackage(archive);
  checkArchiveEntries(entries);
  const packagedRuntime = entries.filter(path => path.startsWith('/dist/') && !asar.statFile(archive, path.slice(1), false).files).map(path => path.slice(1)).sort();
  if (JSON.stringify(packagedRuntime) !== JSON.stringify(Object.keys(receipt.runtime).sort())) throw Error('Packaged runtime file set differs from the build receipt.');
  for (const [path, hash] of Object.entries(receipt.runtime)) {
    if (asar.statFile(archive, path, false).link || digest(asar.extractFile(archive, path)) !== hash) throw Error('Runtime asset mismatch: ' + path);
  }
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString());
  for (const key of ['name', 'productName', 'version', 'dependencies']) {
    if (JSON.stringify(packaged[key]) !== JSON.stringify(manifest[key])) throw Error('Packaged manifest mismatch: ' + key);
  }
  const expectedPi = manifest.dependencies['@earendil-works/pi-coding-agent'];
  const pi = JSON.parse(asar.extractFile(archive, 'node_modules/@earendil-works/pi-coding-agent/package.json').toString());
  if (pi.version !== expectedPi) throw Error('Packaged Pi version mismatch.');
  const targets = [
    'Contents/MacOS/Pi Hub',
    'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
    'Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/darwin-' + arch + '.node',
    'Contents/Resources/app.asar.unpacked/node_modules/@earendil-works/pi-tui/native/darwin/prebuilds/darwin-' + arch + '/darwin-platform.node',
  ];
  const binaries = [];
  for (const path of targets) binaries.push({path, arch: await checkCPU(join(app, path), arch)});
  return {app: resolve(app), arch, pi: pi.version, runtimeAssets: packagedRuntime.length, buildInputs: Object.keys(receipt.inputs).length, asarSha256: digest(await readFile(archive)), binaries};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  let arch = 'all', packages = resolve(repository, process.env.PI_HUB_PACKAGE_OUT || 'dist/packages');
  while (args.length) {
    const name = args.shift(), value = args.shift();
    if (name === '--arch' && ['all', 'x64', 'arm64'].includes(value)) arch = value;
    else if (name === '--packages-dir' && value) packages = resolve(value);
    else throw Error('Usage: npm run check:package -- [--arch all|x64|arm64] [--packages-dir path]');
  }
  const reports = [];
  for (const cpu of arch === 'all' ? ['x64', 'arm64'] : [arch]) reports.push(await checkPackage({app: join(packages, 'Pi Hub-darwin-' + cpu, 'Pi Hub.app'), arch: cpu}));
  console.log(JSON.stringify(reports, null, 2));
}
