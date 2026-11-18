import {readFile, readdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join, relative} from 'node:path';

export const runtimeDirectories = ['desktop', 'renderer', 'terminal', 'remote'];
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function filesUnder(root) {
  const files = [];
  for (const entry of await readdir(root, {withFileTypes: true})) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile()) files.push(path);
    else throw Error('Unexpected symbolic link or special build input: ' + path);
  }
  return files.sort();
}
async function hashes(repository, paths) {
  return Object.fromEntries(await Promise.all(paths.sort().map(async path => [relative(repository, path), digest(await readFile(path))])));
}
export async function buildInputs(repository) {
  return hashes(repository, [
    ...await filesUnder(join(repository, 'src')),
    ...await filesUnder(join(repository, 'scripts')),
    ...['package.json', 'package-lock.json', 'forge.config.cjs', 'tsconfig.json', 'docs/design/clear-order.tokens.css'].map(path => join(repository, path)),
  ]);
}
export async function runtimeHashes(repository) {
  return hashes(repository, (await Promise.all(runtimeDirectories.map(dir => filesUnder(join(repository, 'dist', dir))))).flat());
}
export async function writeBuildReceipt(repository, expectedInputs) {
  const inputs = await buildInputs(repository);
  if (expectedInputs && JSON.stringify(expectedInputs) !== JSON.stringify(inputs)) throw Error('Build inputs changed during compilation; run npm run build again.');
  const receipt = {schema: 1, inputs, runtime: await runtimeHashes(repository)};
  await writeFile(join(repository, 'dist/build-receipt.json'), JSON.stringify(receipt, null, 2) + String.fromCharCode(10));
  return receipt;
}
export async function verifyBuildReceipt(repository) {
  const receipt = JSON.parse(await readFile(join(repository, 'dist/build-receipt.json'), 'utf8'));
  if (receipt.schema !== 1) throw Error('Unsupported build receipt; run npm run build.');
  for (const [key, actual] of [['inputs', await buildInputs(repository)], ['runtime', await runtimeHashes(repository)]]) {
    if (JSON.stringify(receipt[key]) !== JSON.stringify(actual)) throw Error('Build ' + key + ' changed; run npm run build before checking a package.');
  }
  return receipt;
}
