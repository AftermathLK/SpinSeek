import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import { fileURLToPath } from 'node:url';

const fromRoot = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: fromRoot('./src/client'),
  plugins: [react()],
  css: {
    postcss: {
      plugins: [tailwindcss(fromRoot('./tailwind.config.js')), autoprefixer()],
    },
  },
  build: {
    outDir: fromRoot('./dist/client'),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.PORT || 3080}`,
        changeOrigin: false,
      },
    },
  },
});
