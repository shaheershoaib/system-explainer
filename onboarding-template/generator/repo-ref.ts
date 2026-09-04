import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * "name@sha" for the grounding record's verified-against pin. The sha is the FULL 40-character
 * commit id: a short prefix reads well but cannot be fetched (`git fetch origin <7 chars>` fails),
 * so it is not a reproducible pin. The UI shortens it for display (see src/lib/persona.ts).
 * Uses `git rev-parse` (correct in worktrees, where .git is a file); falls back to reading
 * .git/HEAD, then to the bare directory name.
 */
export function repoRefOf(repo: string): string {
  const name = path.basename(path.resolve(repo))
  try {
    const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (/^[0-9a-f]{40}$/.test(sha)) return `${name}@${sha}`
  } catch {
    /* fall through */
  }
  try {
    const head = readFileSync(path.join(repo, '.git', 'HEAD'), 'utf8').trim()
    const m = head.match(/^ref:\s*(.+)$/)
    const sha = m ? readFileSync(path.join(repo, '.git', m[1]), 'utf8').trim() : head
    if (/^[0-9a-f]{40}$/.test(sha)) return `${name}@${sha}`
  } catch {
    /* fall through */
  }
  return name
}
