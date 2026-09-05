import { defineConfig } from 'vite'

// Bundles the CLI entry (and the generator modules it imports) into one Node ESM file.
// Dependencies stay external (they are installed with the package); the SPA config is untouched.
export default defineConfig({
  publicDir: false, // the SPA's public/ (bundle.json) has no business in the CLI bundle
  build: {
    ssr: 'generator/system-explainer.ts',
    outDir: 'dist-cli',
    target: 'node20',
    minify: false,
    sourcemap: true,
    rollupOptions: { output: { entryFileNames: 'system-explainer.js' } },
  },
  ssr: { target: 'node' },
})
