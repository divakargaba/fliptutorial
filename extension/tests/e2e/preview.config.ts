import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: '.',
  testMatch: ['ui.preview.spec.ts', 'drafts.spec.ts'],
  fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:4173', browserName: 'chromium' },
  webServer: {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    command: 'node node_modules/vite/bin/vite.js --config tests/e2e/vite.preview.config.ts',
    url: 'http://127.0.0.1:4173/tests/e2e/preview.html',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'narrow', use: { viewport: { width: 1024, height: 768 } } },
  ],
});
