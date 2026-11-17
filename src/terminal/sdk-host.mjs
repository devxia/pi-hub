import net from 'node:net';
import {
  readFileSync,
  lstatSync,
  statSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  fsyncSync,
  existsSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
const hash = (b) => createHash('sha256').update(b).digest('hex');
function privateFile(path) {
  const s = lstatSync(path);
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.uid !== process.getuid() ||
    (s.mode & 0o777) !== 0o600 ||
    s.size > 1024 * 1024
  )
    throw Error('Private SDK startup file changed');
  return readFileSync(path, 'utf8');
}
const descriptorPath = process.argv[2],
  descriptorBytes = privateFile(descriptorPath),
  d = JSON.parse(descriptorBytes),
  parent = lstatSync(dirname(descriptorPath));
if (
  !parent.isDirectory() ||
  parent.isSymbolicLink() ||
  parent.uid !== process.getuid() ||
  (parent.mode & 0o777) !== 0o700
)
  throw Error('SDK startup directory changed');
const ps = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart=', '-o', 'tty='], {
  encoding: 'utf8',
  env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
})
  .trim()
  .match(/^(.+?)\s+(\S+)$/);
if (!ps) throw Error('SDK host process unavailable');
const boot = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
    encoding: 'utf8',
  }).trim(),
  identity = {
    pid: process.pid,
    startIdentity: boot + ':' + ps[1].trim().replace(/\s+/g, ' '),
    tty: ps[2] === '??' ? null : '/dev/' + ps[2],
  };
function atomic(path, value) {
  const temp = path + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  const fd = openSync(temp, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}
function status(phase, errorCode, message) {
  if (d.statusPath)
    atomic(d.statusPath, { requestId: d.requestId, phase, runtime: identity, errorCode, message });
}
if (d.manual) {
  if (hash(privateFile(process.argv[1])) !== d.manual.entryHash)
    throw Error('SDK host entry changed');
  try {
    const fd = openSync(d.manual.claimPath, 'wx', 0o600);
    try {
      writeFileSync(
        fd,
        JSON.stringify({ state: 'claimed', descriptorHash: hash(descriptorBytes), ...identity }),
      );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    if (e.code === 'EEXIST') {
      console.error(
        'This startup command has already been claimed or cancelled. No Pi was started.',
      );
      process.exit(0);
    }
    throw e;
  }
}
status('preparing');
let runtimeHost,
  socket,
  retry,
  timer,
  generation = randomUUID(),
  sequence = 0,
  stopped = false;
const requestsPath = d.statusPath + '.commands.json';
let requests = {};
try {
  requests = JSON.parse(privateFile(requestsPath));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
const report = () => {
  const s = runtimeHost.session,
    m = s.sessionManager,
    file = m.getSessionFile();
  return {
    hostId: d.hostId,
    ...identity,
    generation,
    sequence: ++sequence,
    sessionId: m.getSessionId(),
    file: file ?? null,
    cwd: runtimeHost.cwd,
    leafId: m.getLeafId(),
    persisted: !!file && existsSync(file),
    busy: !s.isIdle,
  };
};
function sendReport() {
  try {
    if (socket?.writable && runtimeHost && socket.writableLength < 32768) {
      const credential = JSON.parse(privateFile(d.credentialPath));
      socket.write(
        JSON.stringify({
          kind: 'report',
          protocol: 2,
          token: credential.token,
          hostId: d.hostId,
          report: report(),
        }) + '\n',
      );
    }
  } catch {
    socket?.destroy();
  }
}
function schedule() {
  if (!stopped) {
    retry = setTimeout(connect, 1000);
    retry.unref();
  }
}
async function command(c) {
  if (
    !c ||
    typeof c.id !== 'string' ||
    c.id.length > 128 ||
    !['rename', 'clone'].includes(c.type) ||
    Object.keys(c).some(
      (k) => !['kind', 'id', 'type', 'name', 'expectedRevision', 'sessionId', 'file'].includes(k),
    )
  )
    throw Error('Invalid SDK command');
  const canonical = JSON.stringify({
    type: c.type,
    name: c.name,
    expectedRevision: c.expectedRevision,
    sessionId: c.sessionId,
    file: c.file,
  });
  const previous = requests[c.id];
  if (previous) {
    if (previous.command !== canonical) throw Error('Request ID used for another native command');
    if (previous.state !== 'completed')
      throw Error('Original native command result is unconfirmed; it will not be repeated');
    return previous.value;
  }
  const s = runtimeHost.session;
  if (s.sessionId !== c.sessionId || s.sessionFile !== c.file)
    throw Error('Current native session changed');
  if (c.expectedRevision && hash(readFileSync(c.file)) !== c.expectedRevision)
    throw Error('Original session revision changed');
  if (c.type === 'clone' && !s.isIdle)
    throw Error('Pi is busy; finish the current operation before cloning');
  if (c.type === 'rename' && (typeof c.name !== 'string' || c.name.includes('\0')))
    throw Error('Invalid session name');
  requests[c.id] = { command: canonical, state: 'pending' };
  atomic(requestsPath, requests);
  if (c.type === 'rename') s.setSessionName(c.name);
  else {
    const leaf = s.sessionManager.getLeafId();
    if (!leaf) throw Error('No saved native branch to clone');
    const result = await runtimeHost.fork(leaf, { position: 'at' });
    if (result.cancelled) {
      const value = { ...report(), cancelled: true };
      requests[c.id] = { command: canonical, state: 'completed', value };
      atomic(requestsPath, requests);
      return value;
    }
  }
  const value = { ...report(), name: runtimeHost.session.sessionName };
  requests[c.id] = { command: canonical, state: 'completed', value };
  atomic(requestsPath, requests);
  sendReport();
  return value;
}
function connect() {
  if (stopped) return;
  try {
    const credential = JSON.parse(privateFile(d.credentialPath));
    if (credential.protocol !== 2) throw Error('SDK protocol mismatch');
    const endpoint = lstatSync(credential.socketPath);
    if (
      !endpoint.isSocket() ||
      endpoint.uid !== process.getuid() ||
      (endpoint.mode & 0o777) !== 0o600
    )
      throw Error('Private SDK endpoint unavailable');
    const s = net.createConnection(credential.socketPath);
    socket = s;
    let input = '',
      queue = Promise.resolve();
    s.setEncoding('utf8');
    s.on('connect', sendReport);
    s.on('error', () => {});
    s.on('close', () => {
      if (socket === s) socket = undefined;
      schedule();
    });
    s.on('data', (bytes) => {
      input += bytes;
      let end;
      while ((end = input.indexOf('\n')) >= 0) {
        const line = input.slice(0, end);
        input = input.slice(end + 1);
        if (Buffer.byteLength(line) > 32768) {
          s.destroy();
          return;
        }
        queue = queue.then(async () => {
          let c;
          try {
            c = JSON.parse(line);
            if (c.kind === 'ack') return;
            if (c.kind === 'query') {
              if (
                Object.keys(c).some((k) => !['kind', 'id', 'requestId'].includes(k)) ||
                typeof c.requestId !== 'string'
              )
                throw Error('Invalid result query');
              const old = requests[c.requestId];
              s.write(
                JSON.stringify({
                  kind: 'result',
                  id: c.id,
                  ok: true,
                  value: old?.state === 'completed' ? old.value : null,
                }) + '\n',
              );
              return;
            }
            if (c.kind !== 'command') throw Error('Unknown SDK message');
            const value = await command(c);
            s.write(JSON.stringify({ kind: 'result', id: c.id, ok: true, value }) + '\n');
          } catch (e) {
            if (c?.id)
              s.write(
                JSON.stringify({
                  kind: 'result',
                  id: c.id,
                  ok: false,
                  error: String(e.message ?? e),
                }) + '\n',
              );
            else s.destroy();
          }
        });
      }
      if (Buffer.byteLength(input) > 32768) s.destroy();
    });
  } catch {
    schedule();
  }
}
try {
  const target = statSync(d.cwd);
  if (!target.isDirectory() || `${target.dev}:${target.ino}` !== d.targetIdentity)
    throw Error('Launch directory changed');
  if (d.source) {
    const info = statSync(d.source.path),
      bytes = readFileSync(d.source.path, 'utf8'),
      header = bytes.slice(0, bytes.indexOf('\n'));
    if (
      hash(`${info.dev}:${info.ino}:${header}`) !== d.source.identity ||
      hash(bytes) !== d.source.hash
    )
      throw Error('Original session identity or revision changed');
    const declaredHeader = JSON.parse(header);
    if (declaredHeader.type !== 'session' || declaredHeader.version !== 3)
      throw Error(
        'Open older session formats with ordinary Pi first; Hub does not silently migrate the original',
      );
  }
  const shellPath = process.env.PATH;
  for (const [key, value] of Object.entries(d.env)) if (key !== 'PATH') process.env[key] = value;
  process.env.PATH = [
    ...new Set(
      [
        dirname(d.runtimeNodePath),
        ...(shellPath ?? '').split(':'),
        ...(d.env.PATH ?? '').split(':'),
      ].filter((path) => path.startsWith('/')),
    ),
  ].join(':');
  process.chdir(d.cwd);
  const sdk = d.sdk,
    manifest = readFileSync(join(sdk.packagePath, 'package.json')),
    info = statSync(sdk.packagePath);
  if (
    `${info.dev}:${info.ino}` !== sdk.packageIdentity ||
    hash(manifest) !== sdk.manifestHash ||
    hash(readFileSync(sdk.entryPath)) !== sdk.entryHash
  )
    throw Error('Inspected Pi package changed');
  const declared = JSON.parse(manifest),
    entry = declared.exports?.['.']?.import ?? declared.exports?.['.'];
  if (
    declared.name !== '@earendil-works/pi-coding-agent' ||
    declared.version !== '1.5.2' ||
    join(sdk.packagePath, entry) !== sdk.entryPath
  )
    throw Error('Unsupported public Pi SDK');
  const pi = await import(pathToFileURL(sdk.entryPath).href);
  const manager = d.source
    ? pi.SessionManager.open(d.source.path, d.sessionDir, d.cwd)
    : pi.SessionManager.create(d.cwd, d.sessionDir);
  const trustStore = new pi.ProjectTrustStore(d.env.PI_CODING_AGENT_DIR),
    trust = new Map();
  const factory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const settingsManager = pi.SettingsManager.create(cwd, d.env.PI_CODING_AGENT_DIR, {
      projectTrusted: false,
    });
    const ask = async (message) => {
      const input = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await input.question(message);
      } finally {
        input.close();
      }
    };
    const resolveProjectTrust = async ({ extensionsResult }) => {
      if (trust.has(cwd)) return trust.get(cwd);
      const hasResources = pi.hasTrustRequiringProjectResources(cwd);
      let decision;
      const ui = {
        select: async (message, items) => {
          const text = await ask(
            message + '\n' + items.map((item, i) => `${i + 1}. ${item}`).join('\n') + '\nChoice: ',
          );
          return items[Number(text.trim()) - 1];
        },
        confirm: async (title, message) =>
          /^(y|yes)$/i.test((await ask(title + '\n' + message + ' [y/N] ')).trim()),
        input: (title) => ask(title + ': '),
        notify: (message) => console.log(message),
      };
      if (hasResources) {
        for (const extension of extensionsResult.extensions) {
          for (const handler of extension.handlers.get('project_trust') ?? []) {
            const result = await handler(
              { type: 'project_trust', cwd },
              { cwd, mode: 'tui', hasUI: true, ui },
            );
            if (result?.trusted === 'yes' || result?.trusted === 'no') {
              decision = result.trusted === 'yes';
              if (result.remember === true) trustStore.set(cwd, decision);
              break;
            }
          }
          if (decision !== undefined) break;
        }
      }
      if (decision === undefined) {
        const saved = trustStore.get(cwd),
          mode = settingsManager.getDefaultProjectTrust();
        decision =
          saved ??
          (!hasResources || mode === 'always'
            ? true
            : mode === 'never'
              ? false
              : await ui.confirm('Trust Pi project resources?', cwd));
      }
      trust.set(cwd, decision);
      return decision;
    };
    if (
      (sessionManager.buildSessionContext().model?.provider ??
        settingsManager.getDefaultProvider()) === 'llama.cpp'
    )
      throw Error('This SDK host does not provide the CLI built-in llama.cpp integration');
    const extensionFactories = [
      { name: 'codemode', factory: pi.createCodemodeExtension(), builtin: true, replaceable: true },
      {
        name: 'tool-search',
        factory: pi.createToolSearchExtension(),
        builtin: true,
        replaceable: true,
      },
      { name: 'mcp', factory: pi.createMcpExtension(), builtin: true, replaceable: true },
    ];
    const services = await pi.createAgentSessionServices({
      cwd,
      agentDir: d.env.PI_CODING_AGENT_DIR,
      settingsManager,
      resourceLoaderReloadOptions: { resolveProjectTrust },
      resourceLoaderOptions: { extensionFactories },
    });
    const result = await pi.createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    });
    generation = randomUUID();
    sequence = 0;
    result.session.subscribe((e) => {
      if (
        [
          'session_info_changed',
          'entry_appended',
          'agent_start',
          'agent_settled',
          'compaction_start',
          'compaction_end',
          'queue_update',
          'auto_retry_start',
          'auto_retry_end',
        ].includes(e.type)
      )
        queueMicrotask(sendReport);
    });
    return { ...result, services, diagnostics: services.diagnostics };
  };
  runtimeHost = await pi.createAgentSessionRuntime(factory, {
    cwd: d.cwd,
    agentDir: d.env.PI_CODING_AGENT_DIR,
    sessionManager: manager,
  });
  connect();
  timer = setInterval(sendReport, 2000);
  timer.unref();
  status('running');
  process.on('exit', () => {
    stopped = true;
    clearTimeout(retry);
    clearInterval(timer);
    status('exited');
  });
  await new pi.InteractiveMode(runtimeHost, { tuiMode: 'regular' }).run();
} catch (error) {
  stopped = true;
  clearTimeout(retry);
  clearInterval(timer);
  socket?.destroy();
  status('not-started', 'PI_MISSING', String(error.message ?? error));
  throw error;
}
