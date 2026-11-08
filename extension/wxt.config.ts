import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifestVersion: 3,
  manifest: {
    name: 'Breakpoint',
    description: 'Practice coding and concepts while watching YouTube tutorials.',
    permissions: ['storage'],
    host_permissions: ['http://127.0.0.1/*'],
    action: {
      default_title: 'Breakpoint',
      default_icon: { 16: '/icon/16.png', 32: '/icon/32.png', 48: '/icon/48.png', 128: '/icon/128.png' },
    },
  },
  vite: () => ({
    plugins: [tailwindcss()],
    // Chrome rejects literal Unicode noncharacters in extension scripts. CodeMirror uses U+FFFF as a sentinel.
    build: { rolldownOptions: { output: { charset: 'ascii' } } },
  }),
});
