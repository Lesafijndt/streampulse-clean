import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        // Keep the largest framework dependencies in stable, independently cacheable chunks.
        // This reduces the main application entry chunk without changing runtime behavior.
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return undefined;
          if (id.includes('/node_modules/lucide-react/')) return 'icons-vendor';
          if (
            id.includes('/node_modules/firebase/') ||
            id.includes('/node_modules/@firebase/')
          ) {
            return 'firebase-vendor';
          }
          return undefined;
        },
      },
    },
  },
});
