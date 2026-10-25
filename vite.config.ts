import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 800 },
  server: {
    host: true,
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:8642', changeOrigin: false } },
  },
});
