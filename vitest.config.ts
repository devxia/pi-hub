import {defineConfig} from 'vitest/config';
import {resolve} from 'node:path';

// Real SDK/CLI/PTY/shell paths and the opt-in scale probe are not the local quick lane.
const integration = [
  'tests/service/auto-terminal.test.ts',
  'tests/service/native-session-commands.test.ts',
  'tests/service/pi-sdk-client.test.ts',
  'tests/service/sdk-native-runtime.test.ts',
  'tests/service/terminal-shell-environment.test.ts',
  'tests/service/session-scale.test.ts',
];

export default defineConfig({test: {
  projects: [
    {test: {name: 'quick', include: ['tests/service/**/*.test.ts'], exclude: integration}},
    {test: {name: 'integration', include: integration, fileParallelism: false, maxWorkers: 1, env: {
      PI_HUB_TEST_EVIDENCE: process.env.PI_HUB_TEST_EVIDENCE || resolve('.scratch/integration-tests', new Date().toISOString().replaceAll(':', '-')),
    }}},
    ...(process.env.PI_HUB_TEST_NATIVE === '1' ? [{test: {name: 'native', include: ['tests/native/**/*.test.ts'], fileParallelism: false, maxWorkers: 1}}] : []),
  ],
}});
