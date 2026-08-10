import { defineConfig } from 'vite'
import path from 'path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// React + Tailwind v4 via the Vite plugin,
// `@` aliased to src. `@schema` exposes the shared bundle contract to the app.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@schema': path.resolve(__dirname, './schema'),
    },
  },
  server: {
    port: 5174,
    strictPort: true,
    // The backend writes server/data/*.json at runtime; the generator writes bundles/*.
    // Without this, those writes trip Vite's watcher and full-reload the page in a loop.
    // The client imports nothing from server/ or bundles/, so ignoring them is safe.
    watch: { ignored: ['**/server/**', '**/bundles/**'] },
  },
})
