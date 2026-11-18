import { mkdir, chmod, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { RemoteService } from '../remote/service';
import { assert, checkedDirectory } from '../remote/security';
declare const __REMOTE_ASSET_DIGESTS__: Record<string, string>;
const parent = process.parentPort!;
async function start() {
  const [profile, assets, generation] = process.argv.slice(2),
    dir = join(profile, 'remote');
  await checkedDirectory(profile);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await checkedDirectory(dir);
  await chmod(dir, 0o700);
  const service = new RemoteService(profile, assets, __REMOTE_ASSET_DIGESTS__, (snapshot) => {
    if (Buffer.byteLength(JSON.stringify(snapshot)) <= 24 * 1024 * 1024)
      parent.postMessage({ generation, type: 'snapshot', snapshot });
  });
  const socket = join(dir, 'control.sock'),
    canListen = Buffer.byteLength(socket) < 104;
  if (canListen)
    try {
      const st = await lstat(socket);
      assert(st.isSocket() && st.uid === process.getuid?.(), 'Unsafe CLI socket path.');
      await unlink(socket);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  let clients = 0;
  const server = createServer((client) => {
    if (++clients > 4) {
      clients--;
      client.destroy();
      return;
    }
    client.setTimeout(5000, () => client.destroy());
    let bytes = 0,
      parts: Buffer[] = [],
      handled = false;
    client.on('close', () => clients--);
    client.on('error', () => {});
    client.on('data', async (b) => {
      if (handled) return;
      bytes += b.length;
      if (bytes > 128 * 1024) {
        client.destroy();
        return;
      }
      parts.push(b);
      if (!b.includes(10)) return;
      handled = true;
      let reply;
      try {
        reply = await service.cliRequest(JSON.parse(Buffer.concat(parts).toString('utf8')));
      } catch {
        reply = { ok: false, error: 'Invalid CLI request.' };
      }
      const output = JSON.stringify(reply);
      if (Buffer.byteLength(output) > 24 * 1024 * 1024) {
        client.end(JSON.stringify({ ok: false, error: 'CLI response exceeds limit.' }) + '\n');
        return;
      }
      client.end(output + '\n');
    });
  });
  if (canListen) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, () => resolve());
    });
    await chmod(socket, 0o600);
  }
  parent.on('message', async ({ data }: any) => {
    if (data.generation !== generation) return;
    if (data.command === 'close') {
      server.close();
      await service.close();
      await unlink(socket).catch(() => {});
      parent.postMessage({ generation, id: data.id, reply: { ok: true, value: null } });
      process.exit(0);
    }
    const reply =
      data.command === 'pending'
        ? { ok: true, value: service.pending() }
        : data.nativePi
          ? await service.nativePiRequest(data.nativePi)
          : await service.request(data.request);
    parent.postMessage({
      generation,
      id: data.id,
      reply:
        Buffer.byteLength(JSON.stringify(reply)) <= 24 * 1024 * 1024
          ? reply
          : { ok: false, error: 'Remote response exceeds the 24 MiB limit.' },
    });
  });
  parent.postMessage({ generation, type: 'ready' });
}
void start().catch((error) => {
  parent.postMessage({ type: 'fatal', error: String(error) });
  process.exit(1);
});
