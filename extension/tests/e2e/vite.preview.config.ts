import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss()],
  esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1', port: 4173, strictPort: true },
});
