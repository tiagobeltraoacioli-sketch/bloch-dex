import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'native',
  base: '/__postern/native/',
  plugins: [react()],
  build: { outDir: '../dist/native-page', emptyOutDir: true, target: 'es2022' },
});
