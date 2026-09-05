#!/usr/bin/env node
// Thin launcher: the compiled CLI lives in dist-cli/ (built by `npm run build:cli`, always present in the published package).
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const built = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist-cli', 'system-explainer.js')
if (!existsSync(built)) {
  console.error('system-explainer: dist-cli/ is missing. From a clone run `npm run build:cli` (or use `npm run cli -- <command>`).')
  process.exit(1)
}
const mod = await import(pathToFileURL(built).href)
process.exitCode = await mod.main(process.argv.slice(2))
