import { createRequire } from 'node:module';
import { expect, test } from 'vitest';

const require = createRequire(import.meta.url);
test('Pi Hub ships its own application identity and declares terminal automation', () => {
  const config = require('../../forge.config.cjs');
  const manifest = require('../../package.json');
  expect(manifest.name).toBe('pi-hub');
  expect(manifest.productName).toBe('Pi Hub');
  expect(config.packagerConfig.name).toBe('Pi Hub');
  expect(config.packagerConfig.executableName).toBe('Pi Hub');
  expect(config.packagerConfig.appBundleId).toBe('local.pi-hub.desktop');
  expect(config.packagerConfig.extendInfo?.NSAppleEventsUsageDescription).toBe(
    'Pi Hub 需要控制 Terminal 和 Ghostty，以启动 Pi 会话并定位已有会话。',
  );
});
