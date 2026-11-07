import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifestVersion: 3,
  manifest: {
    name: 'Breakpoint',
    description: 'Practice Python while watching YouTube tutorials.',
    permissions: ['storage'],
    host_permissions: ['http://127.0.0.1/*'],
  },
  vite: () => ({ plugins: [tailwindcss()] }),
});
