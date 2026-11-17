import type {ElectronApplication} from '@playwright/test';

/** Replace the OS boundary before product interaction. Never read, save or restore a user's clipboard. */
export function isolateClipboard({clipboard: boundary}: {clipboard: object}) {
  const clipboard = boundary as Record<string, unknown>;
  const state = {text: '', writes: 0, clears: 0};
  const methods = new Set<string>();
  for (let owner: object | null = clipboard; owner && owner !== Object.prototype; owner = Object.getPrototypeOf(owner)) {
    for (const key of Object.getOwnPropertyNames(owner)) if (key !== 'constructor' && typeof clipboard[key] === 'function') methods.add(key);
  }
  for (const key of methods) clipboard[key] = () => { throw Error('Unsupported clipboard operation in an isolated test: ' + key); };
  clipboard.writeText = (text: string) => {
    if (typeof text !== 'string') throw Error('Clipboard text must be a string.');
    state.text = text;
    state.writes++;
  };
  clipboard.readText = () => state.text;
  clipboard.clear = () => { state.text = ''; state.clears++; };
  clipboard.availableFormats = () => state.text ? ['text/plain'] : [];
  clipboard.has = (format: string) => format === 'text/plain' && state.text !== '';
  (globalThis as any).ownedClipboard = state;
  return state;
}

export async function installMemoryClipboard(app: ElectronApplication) {
  await app.evaluate(isolateClipboard);
}
