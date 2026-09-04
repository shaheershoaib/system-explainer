import { defineConfig } from 'vite'
import path from 'path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// React + Tailwind v4 via the Vite plugin,
// `@` aliased to src. `@schema` exposes the shared bundle contract to the app.
export default defineConfig({
  // Sub-path deployments (e.g. a GitHub Pages project site) set VITE_BASE=/<repo>/ at build time.
  base: process.env.VITE_BASE || '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@schema': path.resolve(__dirname, './schema'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Split heavy, rarely-changing vendor code out of the main chunk so it can be
        // cached separately and so no single chunk trips the 500 kB size warning.
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (['react-markdown', 'remark-gfm', 'micromark', 'mdast', 'unified'].some((name) => id.includes(name))) {
            return 'vendor-markdown'
          }
          if (['react', 'react-dom', 'react-router'].some((name) => id.includes(`/node_modules/${name}/`))) {
            return 'vendor-react'
          }
        },
      },
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
