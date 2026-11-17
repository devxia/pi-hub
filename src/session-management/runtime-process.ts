import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
/** Used only to verify a particular SDK host or native terminal target, never to detect session occupancy. */
export async function observeProcess(pid: number) {
  const { stdout } = await exec(
    '/bin/ps',
    ['-p', String(pid), '-o', 'uid=', '-o', 'lstart=', '-o', 'tty='],
    { timeout: 2000, maxBuffer: 4096, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } },
  );
  const match = stdout.trim().match(/^(\d+)\s+(.+?)\s+(\S+)$/);
  if (!match || Number(match[1]) !== process.getuid!()) throw Error('Process identity unavailable');
  const { stdout: boot } = await exec('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
    timeout: 2000,
    maxBuffer: 4096,
  });
  return {
    startIdentity: boot.trim() + ':' + match[2].trim().replace(/\s+/g, ' '),
    tty: match[3] === '??' ? null : '/dev/' + match[3],
  };
}
