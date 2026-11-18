#!/usr/bin/env node
// This exact physical file is unpacked. No Electron/SQLite imports, PATH lookup or daemon fallback.
import { readFile, realpath, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
const hash = (b) => createHash('sha256').update(b).digest('hex');
try {
  const args = process.argv.slice(2);
  if (args.shift() !== '--profile')
    throw Error('Use the profile-bound launcher or --profile /absolute/profile.');
  const profile = args.shift();
  if (!profile || !isAbsolute(profile) || (await realpath(profile)) !== profile)
    throw Error('An exact canonical profile is required.');
  if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Node 24+ is required.');
  const dir = join(profile, 'remote'),
    st = await lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || st.mode & 0o077)
    throw Error('Remote profile directory must be private and owned.');
  const binding = JSON.parse(await readFile(join(dir, 'cli-binding.json'), 'utf8')),
    cli = await realpath(fileURLToPath(import.meta.url)),
    node = await realpath(process.execPath);
  if (
    binding.schema !== 1 ||
    binding.profile !== profile ||
    binding.cliPath !== cli ||
    binding.nodePath !== node ||
    hash(await readFile(cli)) !== binding.cliHash ||
    hash(await readFile(node)) !== binding.nodeHash
  )
    throw Error(
      'CLI/application/Node/profile integrity binding changed; configure the launcher again in Pi Hub.',
    );
  if (args.shift() !== '--grant-file')
    throw Error('Use --grant-file /private/grant.json; tokens are never passed as arguments.');
  const credential = args.shift();
  if (!credential || !isAbsolute(credential) || (await realpath(credential)) !== credential)
    throw Error('Exact absolute grant file required.');
  const gs = await lstat(credential);
  if (!gs.isFile() || gs.uid !== process.getuid() || gs.mode & 0o077)
    throw Error('Grant file must be private and owned.');
  const grant = JSON.parse(await readFile(credential, 'utf8'));
  let request;
  const command = args.shift();
  if (command === 'list' && args.length === 0) request = { command: 'snapshot' };
  else if ((command === 'propose' || command === 'prepare') && args.length === 2) {
    const requestId = args[0],
      action = JSON.parse(args[1]);
    request = { command: 'propose', requestId, action };
  } else if (
    command === 'server' &&
    args.length === 1 &&
    ['list', 'capabilities'].includes(args[0])
  )
    request = { command: 'servers' };
  else if (command === 'operation' && args.length === 2 && args[0] === 'status')
    request = { command: 'operation', requestId: args[1] };
  else if (command === 'task' && args[0] === 'status' && args.length === 2)
    request = { command: 'status', attemptId: args[1] };
  else if (command === 'task' && args[0] === 'logs' && args.length === 4)
    request = {
      command: 'logs',
      attemptId: args[1],
      offset: Number(args[2]),
      length: Number(args[3]),
    };
  else if (command === 'task' && args[0] === 'adopt' && args.length === 3)
    request = { command: 'adopt', taskId: args[1], job: JSON.parse(args[2]) };
  else if (command === 'task' && args[0] === 'prepare' && args.length === 3)
    request = { command: 'propose', requestId: args[1], action: JSON.parse(args[2]) };
  else
    throw Error(
      'Usage: launcher --grant-file /private/grant.json list | propose requestId \'{"kind":"submit","taskId":"…"}\'',
    );
  const output = await new Promise((resolve, reject) => {
    const client = connect(join(dir, 'control.sock'));
    let size = 0,
      parts = [];
    client.setTimeout(15000, () =>
      client.destroy(
        Error('Pi Hub response timed out; do not repeat a write with a new request ID.'),
      ),
    );
    client.on('connect', () => client.write(JSON.stringify({ ...grant, request }) + '\n'));
    client.on('data', (b) => {
      size += b.length;
      if (size > 24 * 1024 * 1024) client.destroy(Error('CLI response too large'));
      else parts.push(b);
    });
    client.on('error', () =>
      reject(
        Error('Pi Hub is unavailable, or its private profile socket rejected the connection.'),
      ),
    );
    client.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString('utf8')));
      } catch {
        reject(Error('Invalid Hub response.'));
      }
    });
  });
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  if (!output.ok) process.exitCode = 1;
} catch (error) {
  process.stderr.write(String(error.message) + '\n');
  process.exitCode = 1;
}
