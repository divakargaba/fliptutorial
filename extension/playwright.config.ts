import { defineConfig } from '@playwright/test';

// Keep paths stable when invoked through the legacy tests/e2e config on Windows.
const extensionRoot = decodeURIComponent(new URL('.', import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, '');

export default defineConfig({
  testDir: `${extensionRoot}/tests/e2e`,
  timeout: 30_000,
  workers: 1, // Each built-extension test owns the configured loopback API port.
  use: { baseURL: 'http://127.0.0.1:4173', browserName: 'chromium' },
  webServer: {
    cwd: extensionRoot,
    command: 'node node_modules/wxt/bin/wxt.mjs build && node node_modules/vite/bin/vite.js --config tests/e2e/vite.preview.config.ts',
    url: 'http://127.0.0.1:4173/tests/e2e/preview.html',
    reuseExistingServer: false,
  },
  projects: [
    ...[{ name: 'desktop', viewport: { width: 1440, height: 900 } },
      { name: 'narrow', viewport: { width: 1024, height: 768 } }].flatMap(({ name, viewport }) => [
      { name: `preview-${name}`, testMatch: ['ui.preview.spec.ts', 'drafts.spec.ts', 'test-me.preview.spec.ts', 'v2.preview.spec.ts', ...(name === 'desktop' ? ['api.spec.ts'] : [])], use: { viewport } },
      { name: `mv3-${name}`, testMatch: ['extension.spec.ts', 'release.spec.ts', 'test-me.spec.ts', 'hints.spec.ts', 'v2-popup.spec.ts', 'plan.spec.ts'], use: { viewport } },
    ]),
  ],
});
