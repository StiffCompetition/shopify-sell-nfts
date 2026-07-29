import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/claim': 'http://localhost:3000',
      '/webhooks': 'http://localhost:3000',
    },
  },
});
