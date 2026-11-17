import { defineConfig } from '@playwright/test';
export default defineConfig({
  workers: 1, timeout: 45000, expect: { timeout: 10000 }, reporter: 'list',
  projects: [
    { name: 'desktop', testDir: './tests/desktop', testMatch: '**/*.spec.ts', grepInvert: /@foreground/, metadata: {foreground: false} },
    { name: 'desktop-foreground', testDir: './tests/desktop', testMatch: '**/*.spec.ts', grep: /@foreground/, metadata: {foreground: true} },
    { name: 'native', testDir: './tests/native', testMatch: '**/*.spec.ts', metadata: {foreground: true} },
  ],
});
