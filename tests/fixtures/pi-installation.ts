import {readFileSync,realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';

/** One installation for SDK, CLI, inspected launcher and test subprocesses. No user-specific paths. */
const repository=fileURLToPath(new URL('../../',import.meta.url));
const manifest=JSON.parse(readFileSync(join(repository,'package.json'),'utf8'));
const lock=JSON.parse(readFileSync(join(repository,'package-lock.json'),'utf8'));
const packagePath=realpathSync(join(repository,'node_modules/@earendil-works/pi-coding-agent'));
const installed=JSON.parse(readFileSync(join(packagePath,'package.json'),'utf8'));
const version=manifest.dependencies['@earendil-works/pi-coding-agent'];
if(installed.version!==version||lock.packages['node_modules/@earendil-works/pi-coding-agent'].version!==version||process.env.PI_HUB_TEST_PI_VERSION&&process.env.PI_HUB_TEST_PI_VERSION!==version)throw Error('Pi test version mismatch: align the package, lockfile, installation and latest-version preflight.');
if(Number(process.versions.node.split('.')[0])<24)throw Error('Pi tests require Node 24+.');
export const piInstallation=Object.freeze({
 version,packagePath,
 launcher:realpathSync(join(repository,'node_modules/.bin/pi')),
 cli:realpathSync(join(packagePath,'dist/bundle/cli.js')),
 sdk:realpathSync(join(packagePath,'dist/index.js')),
 node:realpathSync(process.execPath),
});

/** Run once per acceptance, never once per test. A changed latest version fails explicitly. */
export function verifyLatestPi(){
 const result=JSON.parse(execFileSync('npm',['view','@earendil-works/pi-coding-agent','version','--json'],{encoding:'utf8',timeout:20000}));
 const latest=Array.isArray(result)?result[0]:result;
 if(latest!==version)throw Error(`Official latest Pi is ${latest}; update ${version} and validate compatibility before testing.`);
 return {latest,installed:version,node:process.versions.node,checkedAt:new Date().toISOString()};
}
