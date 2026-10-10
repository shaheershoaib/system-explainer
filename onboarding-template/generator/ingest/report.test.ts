// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { credentialNames, formatProblems, isCredentialName, sourceCatalog } from './report'
import type { SourceProblem } from './types'

const PDF: SourceProblem = {
  source: './handbook.pdf',
  kind: 'pdf',
  observed: 'pdftotext not on PATH',
  why: "pdftotext is not installed, so the PDF's text cannot be extracted.",
  fixes: ['On macOS run: brew install poppler (it provides pdftotext), then retry.', 'Or pass --transcribe to have Claude read the PDF (costs API tokens).'],
}
const WEB: SourceProblem = { source: 'https://app.example.test/p/1', kind: 'web', why: 'it needs a sign-in.', fixes: ['Export it and pass the file.'] }

describe('formatProblems', () => {
  it('renders the loud block: header with counts, then source, seen, why and numbered fixes', () => {
    expect(formatProblems([PDF, WEB], { total: 5 })).toBe(
      [
        '✗ 2 of 5 sources could not be read. Nothing was generated and no API call was made.',
        '',
        '  pdf ./handbook.pdf',
        '    seen pdftotext not on PATH',
        "    why  pdftotext is not installed, so the PDF's text cannot be extracted.",
        '    fix  1. On macOS run: brew install poppler (it provides pdftotext), then retry.',
        '         2. Or pass --transcribe to have Claude read the PDF (costs API tokens).',
        '',
        '  web https://app.example.test/p/1',
        '    why  it needs a sign-in.',
        '    fix  Export it and pass the file.',
        '',
      ].join('\n'),
    )
  })

  it('says the course is built without them under --allow-partial, and is honest when the access agent already spent', () => {
    expect(formatProblems([WEB], { partial: true }).split('\n')[0]).toBe(
      '✗ 1 source could not be read. The course will be built WITHOUT it; it will be listed in the course and in the proof report.',
    )
    expect(formatProblems([PDF, WEB], { partial: true, total: 3 }).split('\n')[0]).toMatch(/WITHOUT them; they will be listed/)
    expect(formatProblems([WEB], { usedApi: true }).split('\n')[0]).toMatch(/Nothing was generated; the only API calls made were the access agent/)
    expect(formatProblems([])).toBe('')
  })
})

describe('sourceCatalog', () => {
  const env = { NOTES_API_TOKEN: 'secret-value-123', ANTHROPIC_API_KEY: 'sk-ant-xyz-123456', PATH: '/bin' }
  const all = (bin: string) => `/usr/bin/${bin}`

  it('lists formats with their tools, reachable or not, and one row for everything else', () => {
    const rows = sourceCatalog(env, all)
    expect(rows.map((r) => r.kind)).toEqual(['repo', 'folder', 'markdown', 'html', 'transcript', 'csv', 'json', 'email', 'word', 'slides', 'pdf', 'image', 'spreadsheet', 'audio-video', 'git-remote', 'web', 'remote'])
    for (const r of rows) {
      expect(r.label.length).toBeGreaterThan(0)
      expect(r.examples.length).toBeGreaterThan(0)
      if (!r.reachableNow) expect(r.fixes.length).toBeGreaterThan(0)
    }
    const pdf = rows.find((r) => r.kind === 'pdf')!
    expect(pdf).toMatchObject({ reachableNow: true, status: 'pdftotext found', fixes: [] })
    const remote = rows.find((r) => r.kind === 'remote')!
    expect(remote.label).toMatch(/^Anything else: the access agent works out how to reach it/)
    expect(remote.reachableNow).toBe(true)
    expect(remote.status).toContain('NOTES_API_TOKEN')
    expect(JSON.stringify(rows)).not.toContain('secret-value-123')
    expect(JSON.stringify(rows)).not.toContain('sk-ant')
  })

  it('reports missing tools and a missing model key with the fixes that unlock them', () => {
    const rows = sourceCatalog({}, () => null)
    const by = (k: string) => rows.find((r) => r.kind === k)!
    expect(by('pdf')).toMatchObject({ reachableNow: false, status: 'pdftotext not found' })
    expect(by('pdf').fixes.join(' ')).toMatch(/brew install poppler.*apt-get install poppler-utils/)
    expect(by('word')).toMatchObject({ reachableNow: false, status: 'unzip and tar not found' })
    expect(by('git-remote')).toMatchObject({ reachableNow: false, status: 'git not found' })
    expect(by('remote')).toMatchObject({ reachableNow: false })
    expect(by('remote').status).toMatch(/needs ANTHROPIC_API_KEY/)
    expect(by('image').fixes[0]).toMatch(/--transcribe/)
  })

  it('credentialNames lists names only, never the model key', () => {
    expect(credentialNames({ B_SECRET: 'x', A_TOKEN: 'y', ANTHROPIC_API_KEY: 'z', HOME: '/h', EMPTY_KEY: '' })).toEqual(['A_TOKEN', 'B_SECRET'])
  })
})

describe('credential names', () => {
  it('matches whole name parts, never substrings like the PAT in PATH', () => {
    const env = Object.fromEntries(['PATH', 'MANPATH', 'CLAUDE_CODE_EXECPATH', 'PWD', 'SSH_AUTH_SOCK', 'HOME', 'ACME_API_KEY', 'DB_PASSWORD', 'MY_PAT', 'GHTOKEN', 'WIKI_TOKEN', 'ANTHROPIC_API_KEY'].map((k) => [k, 'x']))
    expect(credentialNames(env)).toEqual(['ACME_API_KEY', 'DB_PASSWORD', 'GHTOKEN', 'MY_PAT', 'WIKI_TOKEN'])
    expect(isCredentialName('PATH')).toBe(false)
    expect(isCredentialName('session_cookie')).toBe(true)
  })
})
