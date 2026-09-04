import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { repoRefOf } from './repo-ref'

const here = path.dirname(fileURLToPath(import.meta.url))

describe('repoRefOf', () => {
  it('pins the FULL 40-character commit id of a git checkout (a prefix cannot be fetched)', () => {
    const ref = repoRefOf(path.resolve(here, '..', '..')) // this repository
    expect(ref).toMatch(/^system-explainer@[0-9a-f]{40}$/)
  })
  it('falls back to the directory name when the path is not inside a repository', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'not-a-repo-'))
    try {
      expect(repoRefOf(dir)).toBe(path.basename(dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
