import { createHash, timingSafeEqual, randomUUID as __importUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, realpath, mkdir, rename } from 'node:fs/promises';
import { isAbsolute, join, dirname, resolve, relative } from 'node:path';
import type { InputHandle } from './snapshots';
import type { DefaultSSHPreview, Hop, Server } from './contract';
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.entries(v)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, x]) => JSON.stringify(k) + ':' + canonical(x))
      .join(',') +
    '}'
  );
}
export const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
export const digest = (v: unknown) => hash(canonical(v));
export function equal(a: string, b: string) {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw Error(message);
}
export const id = (s: unknown): s is string =>
  typeof s === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(s);
export function relativePath(s: string) {
  assert(
    typeof s === 'string' &&
      s.length > 0 &&
      s.length < 1024 &&
      !s.includes('\\') &&
      !s.includes('\0') &&
      !isAbsolute(s) &&
      s.split('/').every((p) => p && p !== '.' && p !== '..'),
    'Use a relative path without traversal.',
  );
  return s;
}
export function absolutePath(s: string) {
  assert(
    typeof s === 'string' && isAbsolute(s) && !/[\r\n\0]/.test(s) && resolve(s) === s,
    'An absolute normalized path is required.',
  );
  return s;
}
export function validateServer(s: Server) {
  assert(
    s &&
      id(s.id) &&
      Number.isSafeInteger(s.revision) &&
      s.revision >= 0 &&
      ['linux', 'slurm'].includes(s.backend) &&
      typeof s.name === 'string' &&
      s.name.length <= 120,
    'Invalid server.',
  );
  absolutePath(s.root);
  assert(
    s.root !== '/' && s.hops.length > 0 && s.hops.length <= 5,
    'Choose a private remote workspace and at most five hops.',
  );
  for (const h of s.hops) {
    assert(
      /^[a-zA-Z0-9_-]{1,80}$/.test(h.alias) &&
        /^[a-zA-Z0-9.:-]{1,253}$/.test(h.host) &&
        /^[a-zA-Z0-9_.-]{1,80}$/.test(h.user) &&
        Number.isInteger(h.port) &&
        h.port > 0 &&
        h.port < 65536,
      'Invalid SSH destination.',
    );
    if (h.identityFile) absolutePath(h.identityFile);
    if (h.certificateFile) absolutePath(h.certificateFile);
    assert(h.agent === undefined || h.agent === 'environment', 'Invalid agent reference.');
    if (h.agentIdentity)
      assert(
        /^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/]+={0,3}$/.test(h.agentIdentity),
        '请选择完整的 SSH Agent 公钥。',
      );
    if (h.hostKey)
      assert(
        /^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/]+={0,3}$/.test(h.hostKey),
        'Paste a complete public host key, without a comment.',
      );
  }
}
const sshConfigLimit = 64 * 1024;
const sshAlias = /^[a-zA-Z0-9_-]{1,80}$/;
const sshFields = new Set([
  'hostname',
  'user',
  'port',
  'identityfile',
  'proxyjump',
  'identitiesonly',
  'certificatefile',
  'identityagent',
]);

/** Explicit, self-contained fragments from the picker or clipboard. */
export function importSSH(source: string): Hop[][] {
  assert(
    typeof source === 'string' && Buffer.byteLength(source) <= sshConfigLimit,
    'SSH configuration is too large.',
  );
  const entries = new Map<string, Record<string, string>>();
  let current: Record<string, string> | undefined;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([a-zA-Z]+)\s*(?:=\s*)?(.+?)\s*$/.exec(line);
    assert(m, 'Unsupported SSH syntax.');
    const key = m[1].toLowerCase(),
      value = m[2];
    assert(!/["'`$\\\r\n]/.test(value), 'Quoted or expanded SSH values are not supported.');
    if (key === 'host') {
      assert(
        sshAlias.test(value) && !entries.has(value),
        'Choose explicit unique Host aliases.',
      );
      current = { alias: value };
      entries.set(value, current);
    } else {
      assert(
        current && sshFields.has(key),
        'Unsupported SSH directive: ' + key,
      );
      assert(!current[key], 'Duplicate SSH directive: ' + key);
      current[key] = value;
    }
  }
  return [...entries.keys()].map((alias) => resolveSSHAlias(alias, (name) => entries.get(name)));
}

function resolveSSHAlias(
  alias: string,
  lookup: (name: string) => Record<string, string> | undefined,
  seen: string[] = [],
  hops: Hop[] = [],
): Hop[] {
  assert(!seen.includes(alias.toLowerCase()), 'SSH jump cycle or depth exceeded.');
  assert(seen.length + hops.length < 5, 'SSH jump cycle or depth exceeded.');
  const e = lookup(alias);
  assert(e?.hostname && e.user, 'Every alias needs explicit HostName and User.');
  if (e.proxyjump && e.proxyjump.toLowerCase() !== 'none') {
    const next = [...seen, alias.toLowerCase()];
    for (const name of e.proxyjump.split(',')) resolveSSHAlias(name, lookup, next, hops);
  }
  assert(
    !e.identityagent || ['none', 'SSH_AUTH_SOCK'].includes(e.identityagent),
    'IdentityAgent must be none or an explicit SSH_AUTH_SOCK reference.',
  );
  assert(
    !e.identitiesonly || e.identitiesonly.toLowerCase() === 'yes',
    'IdentitiesOnly must be yes.',
  );
  const h: Hop = {
    ...(e.certificatefile ? { certificateFile: e.certificatefile } : {}),
    ...(e.identityagent === 'SSH_AUTH_SOCK' ? { agent: 'environment' as const } : {}),
    alias,
    host: e.hostname,
    user: e.user,
    port: Number(e.port || 22),
    ...(e.identityfile ? { identityFile: e.identityfile } : {}),
  };
  validateServer({
    id: 'import',
    revision: 0,
    name: alias,
    root: '/tmp/pi-hub-import',
    backend: 'linux',
    hops: [h],
  });
  hops.push(h);
  return hops;
}

const localSSHOptions = new Set([
  'addkeystoagent',
  'usekeychain',
  'ignoreunknown',
  'serveraliveinterval',
  'serveralivecountmax',
  'tcpkeepalive',
  'connecttimeout',
  'connectionattempts',
  'compression',
  'loglevel',
  // Pi Hub checks host keys using its own per-hop trust records.
  'stricthostkeychecking',
  'userknownhostsfile',
]);

type SSHSection = { hosts: string[]; fields: [key: string, value: string][]; issue?: string };

/** Read only declarative fields from the main user config. Never evaluate additional sources. */
export function previewDefaultSSH(source: string, home: string): DefaultSSHPreview {
  assert(Buffer.byteLength(source) <= sshConfigLimit, 'SSH 配置文件超过 64 KiB。');
  const preview: DefaultSSHPreview = { aliases: [], skipped: [], omitted: [] };
  const omitted = new Set<DefaultSSHPreview['omitted'][number]>();
  const names = new Map<string, string>();
  let section: SSHSection | undefined = { hosts: ['*'], fields: [] };
  const sections = [section];
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([a-zA-Z][a-zA-Z0-9]*)\s*(?:=\s*)?(.*)$/.exec(line);
    const key = match?.[1].toLowerCase();
    const value = (match?.[2] ?? '').replace(/\s+#.*$/, '').trim();
    if (key === 'host') {
      const hosts = value.split(/\s+/);
      if (!hosts.every((name) => name === '*' || sshAlias.test(name))) {
        omitted.add('Host 通配模式');
        section = undefined;
        continue;
      }
      section = { hosts: hosts.map((name) => name.toLowerCase()), fields: [] };
      sections.push(section);
      for (const name of hosts) {
        if (name !== '*' && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
      }
    } else if (key === 'match') {
      omitted.add('Match');
      section = undefined;
    } else if (key === 'include') {
      omitted.add('Include');
    } else if (section && !section.issue) {
      if (key && sshFields.has(key) && value) section.fields.push([key, value]);
      else if (!key || !localSSHOptions.has(key)) {
        section.issue = key
          ? `第 ${index + 1} 行的 ${match![1]} 需要手动核对。`
          : `第 ${index + 1} 行的 SSH 配置语法无法解析。`;
      }
    }
  }

  const entries = new Map<string, Record<string, string>>();
  const reasons = new Map<string, string>();
  for (const [name, alias] of names) {
    const fields: Record<string, string> = {};
    try {
      for (const { hosts, fields: values, issue } of sections) {
        if (!hosts.includes('*') && !hosts.includes(name)) continue;
        if (issue) throw Error(issue);
        for (const [key, rawValue] of values) {
          const additive = key === 'identityfile' || key === 'certificatefile';
          if (key in fields && !additive) continue;
          const value = rawValue.replace(/^"([^"]*)"$/, '$1');
          const agent = key === 'identityagent' && value === '$SSH_AUTH_SOCK';
          assert(
            agent || !/["'`$\\%\u0000-\u001f]/.test(value),
            `请手动核对含引号或变量展开的 ${key}。`,
          );
          const resolved = agent ? 'SSH_AUTH_SOCK'
            : additive && value.startsWith('~/') ? join(home, value.slice(2))
            : value;
          assert(
            !additive || !(key in fields) || fields[key] === resolved,
            `配置含多个 ${key}，请选择要使用的一项。`,
          );
          fields[key] = resolved;
        }
      }
      for (const key of ['identityfile', 'certificatefile']) {
        if (fields[key]?.toLowerCase() === 'none') delete fields[key];
      }
      if (fields.identitiesonly?.toLowerCase() === 'no') delete fields.identitiesonly;
      assert(fields.hostname && fields.user, '请补充明确的 HostName 和 User。');
      assert(!fields.port || /^[0-9]{1,5}$/.test(fields.port), '请核对 SSH 端口。');
      entries.set(name, fields);
    } catch (error) {
      reasons.set(name, (error as Error).message);
    }
  }
  for (const [name, alias] of names) {
    try {
      const reason = reasons.get(name);
      if (reason) throw Error(reason);
      const hops = resolveSSHAlias(alias, (jump) => {
        const key = jump.toLowerCase();
        assert(entries.has(key), `跳板 ${names.get(key) ?? '别名'} 无法从默认配置导入。`);
        const entry = entries.get(key)!;
        if (entry.proxyjump?.toLowerCase() !== 'none') {
          const jumps = entry.proxyjump?.split(',') ?? [];
          assert(
            jumps.every((jumpName) => sshAlias.test(jumpName)),
            'ProxyJump 需要明确声明的 Host 别名。',
          );
          // An explicit multihop route cannot be used with per-hop implicit routes.
          assert(
            jumps.length < 2 || jumps.every((jumpName) => {
              const proxy = entries.get(jumpName.toLowerCase())?.proxyjump;
              return !proxy || proxy.toLowerCase() === 'none';
            }),
            '多跳 ProxyJump 含有各自的跳板，请手动核对连接顺序。',
          );
        }
        return entry;
      });
      preview.aliases.push(hops);
    } catch (error) {
      preview.skipped.push({ alias, reason: (error as Error).message });
    }
  }
  preview.omitted = [...omitted];
  return preview;
}

export const fingerprint = (key: string) =>
  'SHA256:' +
  createHash('sha256')
    .update(Buffer.from(key.split(' ')[1], 'base64'))
    .digest('base64')
    .replace(/=+$/, '');
export async function checkedDirectory(path: string) {
  absolutePath(path);
  const parts = path.split('/').filter(Boolean);
  let cursor = '/';
  for (const part of parts) {
    cursor = join(cursor, part);
    const st = await lstat(cursor);
    assert(
      st.isDirectory() && !st.isSymbolicLink(),
      'Directory contains a symlink or special file: ' + cursor,
    );
  }
  assert((await realpath(path)) === path, 'Directory identity changed.');
  const s = await lstat(path);
  return `${s.dev}:${s.ino}`;
}
const excluded =
  /(^|\/)(?:\.git|\.scratch|node_modules|\.env(?:\.[^/]*)?|\.ssh|\.aws|\.pi-hub|dist|outputs?|__pycache__|\.cache)(\/|$)|\.(?:pem|key|p12|pfx)$/i;
export interface FileSnapshot {
  path: string;
  data: string;
  sha256: string;
  size: number;
}
export interface SecureFiles {
  openInput(root: string, path: string): InputHandle;
  finishInput(handle: InputHandle, verify: boolean): void;
  enumerate(root: string, selections: string[]): { files: string[]; directories: string[] };
  publishDisk(
    destination: string,
    files: { path: string; sourceStamp: string }[],
    parent: string,
    temp: string,
    revision: string,
    source: string,
    directories: string[],
  ): void;
  snapshot(root: string, paths: string[]): { path: string; bytes: Buffer }[];
  publish(
    destination: string,
    files: { path: string; bytes: Buffer }[],
    expectedParent: string,
    tempName: string,
    expectedTarget: string,
  ): void;
  inspect(path: string): string;
  releaseSnapshot(parent: string, name: string): void;
}
export async function snapshot(
  root: string,
  paths: string[],
  native: SecureFiles,
): Promise<FileSnapshot[]> {
  absolutePath(root);
  assert(
    Array.isArray(paths) && paths.length <= 256 && new Set(paths).size === paths.length,
    'At most 256 unique input files.',
  );
  paths.forEach((name) => {
    relativePath(name);
    assert(!excluded.test(name), 'Excluded input: ' + name);
  });
  return native
    .snapshot(root, paths)
    .map(({ path, bytes }) => ({
      path,
      data: bytes.toString('base64'),
      sha256: hash(bytes),
      size: bytes.length,
    }));
}
export async function publishResults(
  destination: string,
  files: FileSnapshot[],
  native: SecureFiles,
  expectedParent: string,
  expectedTarget = '',
) {
  absolutePath(destination);
  assert(
    Array.isArray(files) &&
      files.length <= 256 &&
      new Set(files.map((f) => f.path)).size === files.length,
    'Unexpected result file set.',
  );
  let total = 0;
  const checked = files.map((f) => {
    relativePath(f.path);
    const bytes = Buffer.from(f.data, 'base64');
    total += bytes.length;
    assert(
      total <= 16 * 1024 * 1024 && hash(bytes) === f.sha256 && bytes.length === f.size,
      'Result integrity/size mismatch.',
    );
    return { path: f.path, bytes };
  });
  const backup = '.pi-hub-result-' + __importUUID();
  native.publish(destination, checked, expectedParent, backup, expectedTarget);
  return expectedTarget ? join(dirname(destination), backup) : undefined;
}

export function executionOptions(t: { environment?: Record<string, string>; resources?: object }) {
  const environment = t.environment ?? {},
    resources = t.resources ?? {};
  assert(
    environment &&
      typeof environment === 'object' &&
      !Array.isArray(environment) &&
      Object.keys(environment).length <= 16,
    'Invalid environment.',
  );
  for (const [key, value] of Object.entries(environment))
    assert(
      [
        'LANG',
        'LC_ALL',
        'OMP_NUM_THREADS',
        'MKL_NUM_THREADS',
        'OPENBLAS_NUM_THREADS',
        'CUDA_VISIBLE_DEVICES',
        'NVIDIA_VISIBLE_DEVICES',
        'TOKENIZERS_PARALLELISM',
      ].includes(key) &&
        typeof value === 'string' &&
        value.length <= 512 &&
        !/[\0\r\n]/.test(value),
      'Unsupported environment variable.',
    );
  assert(
    resources && typeof resources === 'object' && !Array.isArray(resources),
    'Invalid resources.',
  );
  for (const [key, value] of Object.entries(resources)) {
    if (['partition', 'account', 'qos'].includes(key))
      assert(
        typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(value),
        'Invalid scheduler resource.',
      );
    else
      assert(
        ['minutes', 'memoryMB', 'cpus', 'gpus', 'nodes'].includes(key) &&
          Number.isSafeInteger(value) &&
          Number(value) >= (key === 'gpus' ? 0 : 1) &&
          Number(value) <= 1000000,
        'Invalid numeric scheduler resource.',
      );
  }
  return { environment, resources };
}
