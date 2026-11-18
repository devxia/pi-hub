import { it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

it('reads the declared metrics path through real descriptor boundaries and rejects unsafe files', async () => {
  await mkdir(process.env.PI_HUB_TEST_EVIDENCE!, { recursive: true });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-progress-boundary-')));
  try {
    await mkdir(join(root, 'output'));
    await writeFile(join(root, 'output/metrics.json'), JSON.stringify({ completed: 7, total: 10 }));
    await writeFile(
      join(root, 'output/progress.json'),
      JSON.stringify({ completed: 1, total: 10 }),
    );
    const script = `import json, os, runpy, sys
runner = runpy.run_path(sys.argv[1])
transfer = runpy.run_path(sys.argv[2])
runner['streams'].__globals__.update({k: v for k, v in transfer.items() if k.startswith('tf_')})
root = sys.argv[3]
retained = runner['directory'](root)
fd = int(retained.rsplit('/', 1)[1])
def progress(name):
    return runner['streams'](retained, {'progressFile': name}).get('progress')
assert progress('metrics.json')['completed'] == 7
assert progress('missing.json') is None
with open(root + '/output/metrics.json', 'w') as f:
    f.write('bad json')
assert progress('metrics.json') is None
os.unlink(root + '/output/metrics.json')
os.symlink('progress.json', root + '/output/metrics.json')
os.mkdir(root + '/output/nested')
with open(root + '/output/nested/custom.json', 'w') as f:
    f.write('{"completed":9}')
assert progress('nested/custom.json')['completed'] == 9
os.rename(root + '/output/nested', root + '/output/held')
os.symlink('held', root + '/output/nested')
for name in ['metrics.json', 'nested/custom.json']:
    try:
        progress(name)
    except OSError:
        pass
    else:
        raise AssertionError('followed a symlink: ' + name)
assert os.fstat(fd).st_ino == os.stat(root).st_ino
foreign = os.dup(fd)
try:
    runner['streams']('/proc/self/fd/' + str(foreign), {})
except RuntimeError as error:
    assert 'Unowned attempt descriptor' in str(error)
else:
    raise AssertionError('accepted an unowned descriptor')
finally:
    os.close(foreign)
print(json.dumps({'declaredPath': True, 'missing': True, 'malformed': True,
                  'symlinkRefused': True, 'ancestorRefused': True, 'retainedStillOpen': True,
                  'unownedDescriptorRefused': True}))`;
    const output = execFileSync(
      '/usr/bin/python3',
      ['-c', script, resolve('src/remote/runner.py'), resolve('src/remote/transfer.py'), root],
      { env: { PATH: '/usr/bin:/bin', HOME: root }, encoding: 'utf8' },
    );
    expect(JSON.parse(output).declaredPath).toBe(true);
    await writeFile(join(process.env.PI_HUB_TEST_EVIDENCE!, 'progress-boundary.json'), output);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('passes positional SLUID or full JobID plus all constraints at an actual subprocess argv boundary', async () => {
  await mkdir(process.env.PI_HUB_TEST_EVIDENCE!, { recursive: true });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-slurm-argv-')));
  try {
    // This recorder proves OS argv only. It never returns or simulates controller acceptance.
    const recorder = join(root, 'argv-recorder.py');
    await writeFile(recorder, 'import sys,json\nprint(json.dumps(sys.argv[1:]))\n');
    const script = `import runpy,sys,json,subprocess\nn=runpy.run_path(sys.argv[1]); ref={'owner':'owned','cluster':'fixture-cluster','name':'unique-marker','jobId':'123_7','sluid':'s_0123456789abcdef'}\nresults=[]\nfor mode in ('sluid','constraints'):\n argv=n['slurm_cancel_argv'](ref,mode)\n results.append(json.loads(subprocess.check_output([sys.executable,sys.argv[2],*argv])))\nprint(json.dumps(results))`;
    const result = JSON.parse(
      execFileSync('/usr/bin/python3', ['-c', script, resolve('src/remote/runner.py'), recorder], {
        env: { PATH: '/usr/bin:/bin', HOME: root },
        encoding: 'utf8',
      }),
    );
    expect(result).toEqual([
      [
        'scancel',
        '--ctld',
        '--user=owned',
        '--clusters=fixture-cluster',
        '--name=unique-marker',
        's_0123456789abcdef',
      ],
      [
        'scancel',
        '--ctld',
        '--user=owned',
        '--clusters=fixture-cluster',
        '--name=unique-marker',
        '123_7',
      ],
    ]);
    await writeFile(
      join(process.env.PI_HUB_TEST_EVIDENCE!, 'slurm-process-argv.json'),
      JSON.stringify({ scope: 'OS argv only, no controller acceptance', result }, null, 2),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('requires the live ping identity to match the queried controller configuration', async () => {
  const evidence = process.env.PI_HUB_TEST_EVIDENCE!;
  await mkdir(evidence, { recursive: true });
  const script = `import json,runpy,sys
identity=runpy.run_path(sys.argv[1])['controller_identity']
config='''SLURM_VERSION = 25.05.3
ClusterName = owned
SlurmctldHost[0] = owned-controller(127.0.0.1)
'''
queries=[]
def execute(argv, ping='Slurmctld(primary) at owned-controller is UP'):
 queries.append(argv)
 return config if argv[-2:]==['show','config'] else ping
result=identity('owned',execute)
denied=[]
for cluster,ping in [('owned','Slurmctld(primary) at other-controller is UP'),('owned','backup is UP'),('other','Slurmctld(primary) at owned-controller is UP')]:
 try: identity(cluster,lambda argv: execute(argv,ping))
 except RuntimeError: denied.append([cluster,ping])
 else: raise AssertionError('accepted conflicting controller')
print(json.dumps({'result':result,'queries':queries,'denied':denied}))`;
  const output = execFileSync('/usr/bin/python3', ['-c', script, resolve('src/remote/runner.py')], {
    env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' },
    encoding: 'utf8',
  });
  expect(JSON.parse(output)).toMatchObject({
    result: {
      version: '25.05.3',
      cluster: 'owned',
      configurationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    },
  });
  expect(JSON.parse(output).denied).toHaveLength(3);
  await writeFile(join(evidence, 'controller-identity-parser.json'), output);
});

it('cannot publish capability acceptance without actual complete evidence and has no manual pass input', async () => {
  await mkdir(process.env.PI_HUB_TEST_EVIDENCE!, { recursive: true });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-capability-denial-')));
  try {
    // Deliberately incomplete evidence, never a synthetic verified receipt.
    const script = `import runpy,sys,json,os,time,hashlib
n=runpy.run_path(sys.argv[1]); root=sys.argv[2]
h={'host':'owned','user':'owned','bootId':'owned','retention':'unverified','cancel':'unsupported'}
evidence={'complete':False,'checks':{'lastLogout':False}}
open(root+'/incomplete.json','w').write(json.dumps(evidence))
digest=hashlib.sha256(json.dumps(evidence,sort_keys=True,separators=(',',':')).encode()).hexdigest()
receipt={'schema':1,'host':'owned','user':'owned','bootId':'owned','expiresAt':time.time()*1000+10000,'supervisorHash':'owned-supervisor','toolHash':'owned-tool','retention':'forbidden','evidenceFile':'incomplete.json','evidenceDigest':digest,'checks':evidence['checks']}
results=[]
for label,patch in [('incomplete',{}),('expired',{'expiresAt':0}),('boot',{'bootId':'old'}),('tool',{'toolHash':'old'}),('supervisor',{'supervisorHash':'old'}),('digest',{'evidenceDigest':'0'*64})]:
 open(root+'/linux-capability.json','w').write(json.dumps(dict(receipt,**patch)))
 result=n['acceptance'](root,h,'owned-supervisor','owned-tool')
 assert result['retention']=='unverified',label
 results.append(label)
print(json.dumps({'scope':'denied incomplete evidence only','denied':results}))`;
    const output = execFileSync(
      '/usr/bin/python3',
      ['-c', script, resolve('src/remote/runner.py'), root],
      { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: root } },
    );
    expect(JSON.parse(output).denied).toHaveLength(6);
    await writeFile(join(process.env.PI_HUB_TEST_EVIDENCE!, 'capability-denials.json'), output);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  // Exercise actual authorization gates before any SSH is allowed. This command creates no test jobs.
  const result = spawnSync(process.execPath, [resolve('dist/remote/acceptance-cli.mjs')], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('--authorize-owned-resources');
});
