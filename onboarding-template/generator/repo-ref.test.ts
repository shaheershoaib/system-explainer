import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { repoRefOf } from './repo-ref'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
// An installed skill (a plain copy, not a clone) has no .git; the fallback is covered below.
const insideGit = spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).stdout.trim() === 'true'

describe('repoRefOf', () => {
  it.skipIf(!insideGit)('pins the FULL 40-character commit id of a git checkout (a prefix cannot be fetched)', () => {
    expect(repoRefOf(root)).toMatch(/^[\w.-]+@[0-9a-f]{40}$/)
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
