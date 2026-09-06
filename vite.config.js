import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Only VITE_* reaches the browser. The Reacher key and the service-role key are
// deliberately NOT prefixed, so they can never be bundled even by accident.
export default defineConfig({
  plugins: [react()],
  server: { port: 5180 },
  build: { outDir: 'dist', sourcemap: false },
});
