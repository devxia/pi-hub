import { cloneHistoryUnsupportedReason } from './session-source';
import type { Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { open, opendir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { RecordIdentity, SessionRecord } from './interface';

export class RecordParseError extends Error {}
export class PartialRecordError extends Error {}
export const sourceFingerprint = (info: Stats) =>
  `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Standard Pi layout: sessions/<encoded cwd>/*.jsonl. Folder names never decide ownership. */
export async function* standardFiles(root: string, signal: AbortSignal): AsyncGenerator<string> {
  let folders;
  try {
    folders = await opendir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for await (const folder of folders) {
    signal.throwIfAborted();
    if (
      !folder.isDirectory() &&
      !(folder.isSymbolicLink() && (await stat(join(root, folder.name))).isDirectory())
    )
      continue;
    const entries = await opendir(join(root, folder.name));
    for await (const file of entries) {
      signal.throwIfAborted();
      if ((file.isFile() || file.isSymbolicLink()) && file.name.endsWith('.jsonl'))
        yield join(root, folder.name, file.name);
    }
  }
}

export async function readIdentity(
  sourcePath: string,
  signal: AbortSignal,
): Promise<RecordIdentity> {
  signal.throwIfAborted();
  const file = await open(sourcePath, 'r');
  try {
    const info = await file.stat();
    // Bounded header read; never parse or stream an unrelated record's body.
    const chunks: Buffer[] = [];
    let length = 0;
    while (length < 65536) {
      signal.throwIfAborted();
      const chunk = Buffer.alloc(256);
      const { bytesRead } = await file.read(chunk, 0, chunk.length, length);
      if (!bytesRead) throw new PartialRecordError('会话头尚未写完。');
      const end = chunk.subarray(0, bytesRead).indexOf(10);
      chunks.push(chunk.subarray(0, end < 0 ? bytesRead : end));
      length += bytesRead;
      if (end < 0) continue;
      const text = Buffer.concat(chunks).toString('utf8');
      const header = JSON.parse(text);
      if (
        header.type !== 'session' ||
        typeof header.id !== 'string' ||
        !header.id ||
        typeof header.cwd !== 'string' ||
        !isAbsolute(header.cwd)
      )
        throw Error('无法识别会话头。');
      const identity = hash(`${info.dev}:${info.ino}:${text}`);
      return {
        physicalIdentity: `${info.dev}:${info.ino}`,
        key: hash(identity),
        headerId: header.id,
        sourcePath,
        cwd: resolve(header.cwd),
        identity,
      };
    }
    throw Error('会话头过长。');
  } finally {
    await file.close();
  }
}

export async function readRecord(
  identity: RecordIdentity,
  signal: AbortSignal,
  onMessageWatermark?: (rawHash: string, dialogueHash: string | null) => void,
): Promise<SessionRecord | null> {
  const file = await open(identity.sourcePath, 'r');
  try {
    const before = await file.stat();
    const current = await readIdentity(identity.sourcePath, signal);
    if (current.identity !== identity.identity) throw Error('记录身份已变化，请重新扫描。');
    let cloneUnsupportedReason: string | undefined;
    let createdAt: string | null = null;
    let firstUser = true;
    let pending = '';
    let first = true;
    let name = '';
    let title = '';
    let lastMessageAt: string | null = null;
    const messageWatermark: string[] = [];
    // Read a finite snapshot. Ignore a partial final line until a later scan.
    signal.throwIfAborted();
    const stream = file.createReadStream({
      encoding: 'utf8',
      autoClose: false,
      start: 0,
      end: Math.max(0, before.size - 1),
      highWaterMark: 32768,
      signal,
    });
    for await (const chunk of stream) {
      signal.throwIfAborted();
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (first) {
          first = false;
          const header = JSON.parse(line);
          cloneUnsupportedReason = cloneHistoryUnsupportedReason(header, true);
          const time = new Date(header.timestamp);
          if (typeof header.timestamp === 'string' && !Number.isNaN(time.valueOf()))
            createdAt = time.toISOString();
          continue;
        }
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          throw new RecordParseError('会话包含无法解析的完整记录。');
        }
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
          throw new RecordParseError('会话记录格式无效。');
        cloneUnsupportedReason ??= cloneHistoryUnsupportedReason(entry);
        if (entry.type === 'session_info' && typeof entry.name === 'string')
          name = entry.name.trim();
        if (entry.type !== 'message' || !['user', 'assistant'].includes(entry.message?.role))
          continue;
        const content = entry.message.content;
        const text =
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content
                  .filter(
                    (part: { type?: string; text?: string }) =>
                      part.type === 'text' && typeof part.text === 'string',
                  )
                  .map((part: { text: string }) => part.text)
                  .join(' ')
              : '';
        const images = Array.isArray(content)
          ? content
              .filter((part: { type?: string }) => part.type === 'image')
              .map((part: { data?: string; mimeType?: string }) => [part.mimeType, part.data])
          : [];
        if (!text.trim() && !images.length) {
          onMessageWatermark?.(hash(line), null);
          continue;
        }
        // Dialogue identity ignores transport/provider metadata and non-dialogue blocks.
        // Same entry with changed visible content or time is new; replaying it is not.
        const messageTime = new Date(entry.message.timestamp ?? entry.timestamp);
        const signature =
          'dialogue:' +
          hash(
            JSON.stringify([
              entry.id ?? null,
              entry.message.role,
              text,
              images,
              Number.isNaN(messageTime.valueOf()) ? null : messageTime.toISOString(),
            ]),
          );
        messageWatermark.push(signature);
        onMessageWatermark?.(hash(line), signature);
        if (firstUser && entry.message.role === 'user') {
          firstUser = false;
          title = text.replace(/\s+/g, ' ').trim().slice(0, 120);
        }
        const time = new Date(entry.message.timestamp ?? entry.timestamp);
        if (!Number.isNaN(time.valueOf()) && (!lastMessageAt || time.toISOString() > lastMessageAt))
          lastMessageAt = time.toISOString();
      }
      if (pending.length > 16 * 1024 * 1024)
        throw new RecordParseError('单条记录超过可读取大小（16 MB）。');
    }
    const finalIdentity = await readIdentity(identity.sourcePath, signal);
    if (finalIdentity.identity !== identity.identity)
      throw Error('记录读取期间身份发生变化，请重试。');
    const after = await stat(identity.sourcePath);
    if (
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw Error('记录读取期间发生重写，请重试。');
    return messageWatermark.length
      ? {
          ...identity,
          projectionVersion: 6,
          cloneUnsupportedReason,
          createdAt,
          name,
          automaticTitle: title,
          hasMessages: true,
          sourceModifiedAt: before.mtimeMs,
          sourceFingerprint: sourceFingerprint(before),
          title: name || title || `未命名会话 · ${identity.headerId.slice(0, 8)}`,
          lastMessageAt,
          messageWatermark,
        }
      : null;
  } finally {
    await file.close();
  }
}

/** Pi --session-dir stores JSONL directly in the selected directory. Neither mode recurses arbitrarily. */
export async function* locationFiles(
  root: string,
  mode: 'encoded' | 'flat',
  signal: AbortSignal,
): AsyncGenerator<string> {
  if (mode === 'encoded') {
    yield* standardFiles(root, signal);
    return;
  }
  const entries = await opendir(root);
  for await (const file of entries) {
    signal.throwIfAborted();
    if ((file.isFile() || file.isSymbolicLink()) && file.name.endsWith('.jsonl'))
      yield join(root, file.name);
  }
}
