import { describe, it, expect, vi, afterAll, afterEach } from 'vitest'
import { parseChangedFiles, affectedModules, pinnedSha, changedCorpusDocs, reverify, printReverify, type ReverifyResult } from './reverify'
import { readWorkDir } from './assemble-bundle'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

describe('parseChangedFiles', () => {
  it('splits git diff --name-only output into a set, dropping blanks', () => {
    const s = parseChangedFiles('src/app.py\n\nsrc/models.py\n')
    expect(s).toEqual(new Set(['src/app.py', 'src/models.py']))
  })
})

const bundleFixture = {
  provenance: { grounding: { repoRef: 'flask@36e4a82' } },
  modules: [
    {
      id: 'routing',
      title: 'Routing',
      lessons: [
        { id: 'l1', blocks: [{ type: 'code', sourcePath: 'src/app.py', code: 'x' }, { type: 'prose', md: 'p' }] },
        { id: 'l2', blocks: [{ type: 'code', sourcePath: 'src/blueprints.py', code: 'y' }] },
      ],
    },
    {
      id: 'sessions',
      title: 'Sessions',
      lessons: [{ id: 'l1', blocks: [{ type: 'code', sourcePath: 'src/sessions.py', code: 'z' }] }],
    },
  ],
}

describe('affectedModules', () => {
  it('maps changed files to the modules whose code blocks cite them', () => {
    const out = affectedModules(bundleFixture, new Set(['src/app.py', 'docs/README.md']))
    expect(out).toEqual([{ moduleId: 'routing', title: 'Routing', files: ['src/app.py'], blocks: 1 }])
  })
  it('returns empty when no cited file changed (docs-only diff)', () => {
    expect(affectedModules(bundleFixture, new Set(['docs/README.md']))).toEqual([])
  })
  it('counts multiple hit blocks and files per module', () => {
    const out = affectedModules(bundleFixture, new Set(['src/app.py', 'src/blueprints.py', 'src/sessions.py']))
    expect(out).toEqual([
      { moduleId: 'routing', title: 'Routing', files: ['src/app.py', 'src/blueprints.py'], blocks: 2 },
      { moduleId: 'sessions', title: 'Sessions', files: ['src/sessions.py'], blocks: 1 },
    ])
  })
})

describe('pinnedSha', () => {
  it('extracts the sha from provenance.grounding.repoRef', () => {
    expect(pinnedSha(bundleFixture)).toBe('36e4a82')
  })
  it('returns undefined when unpinned', () => {
    expect(pinnedSha({})).toBeUndefined()
  })
})

describe('readWorkDir (the disk-bus reader)', () => {
  function makeWorkDir() {
    const dir = mkdtempSync(path.join(tmpdir(), 'ua-workdir-'))
    mkdirSync(path.join(dir, 'modules'))
    writeFileSync(
      path.join(dir, 'plan.json'),
      JSON.stringify({ systemName: 'Demo', oneLiner: 'demo', elevatorPitch: 'pitch', outOfScope: [], audience: 'developer', depth: 'L3', repoUrl: null, domains: [{ id: 'b-mod', title: 'B' }, { id: 'a-mod', title: 'A' }] }),
    )
    writeFileSync(path.join(dir, 'datamodel.json'), JSON.stringify({ entities: [{ id: 'e1', name: 'E1', definition: 'd' }] }))
    const mod = (id: string) => ({ id, title: id.toUpperCase(), objective: 'o', concepts: [], lessons: [{ title: 'L', prose: 'p' }], quiz: [] })
    writeFileSync(path.join(dir, 'modules', 'a-mod.json'), JSON.stringify(mod('a-mod')))
    writeFileSync(path.join(dir, 'modules', 'b-mod.json'), JSON.stringify(mod('b-mod')))
    writeFileSync(path.join(dir, 'modules', 'extra.json'), JSON.stringify(mod('extra'))) // critic addition, not in plan
    return dir
  }
  it('reads plan + datamodel + modules, ordering by the plan with extras appended', () => {
    const out = readWorkDir(makeWorkDir())
    expect(out.system.name).toBe('Demo')
    expect(out.system.audience).toBe('developer')
    expect(out.dataModel.entities).toHaveLength(1)
    expect(out.modules.map((m: any) => m.id)).toEqual(['b-mod', 'a-mod', 'extra'])
  })
  it('fails LOUDLY on an unparseable module file instead of silently shrinking the course', () => {
    const dir = makeWorkDir()
    writeFileSync(path.join(dir, 'modules', 'corrupt.json'), '{ not json')
    expect(() => readWorkDir(dir)).toThrow(/unparseable module file/)
  })
  it('fails when modules/ is missing or empty', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ua-workdir-'))
    expect(() => readWorkDir(dir)).toThrow(/no modules/)
  })
})

// ── documents and mixed courses: what changed is decided by the recorded sha256 of each corpus document ──
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const tmp: string[] = []
const scratch = (label: string) => {
  const d = mkdtempSync(path.join(tmpdir(), `reverify-${label}-`))
  tmp.push(d)
  return d
}
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true })
})

function writeFiles(dir: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    writeFileSync(path.join(dir, rel), text)
  }
}

const DOCS: Record<string, string> = {
  'weekly/2026-09-01.md': '# Weekly sync\n\n- We decided invoices go out on the 1st of every month.\n',
  'weekly/2026-09-15.md': '# Weekly sync\n\n- Invoices now go out on the 5th of every month, replacing the 1st.\n',
  'handbook.md': '# Handbook\n\nRefunds above 500 dollars need a second approver.\n',
}

const quoteBlock = (sourcePath: string, text: string) => ({ type: 'quote', text, sourcePath, cite: { title: sourcePath } })

/** An engine root holding a bundle at bundles/<id>/bundle.json; returns the bundle path relative to it. */
function engineWith(bundle: any): { root: string; bundlePath: string } {
  const root = scratch('root')
  const bundlePath = `bundles/${bundle.system.id}/bundle.json`
  writeFiles(root, { [bundlePath]: JSON.stringify(bundle) })
  return { root, bundlePath }
}

/** A corpus dir plus a documents bundle whose provenance records each doc's sha256 (and one legacy KB entry, which must be skipped). */
function documentsCourse() {
  const corpus = scratch('corpus')
  writeFiles(corpus, DOCS)
  const bundle = {
    system: { id: 'notes', name: 'Notes', oneLiner: 'what the team decided' },
    provenance: {
      sources: [
        ...Object.entries(DOCS).map(([p, text]) => ({ path: p, sha256: sha256(text), title: p, kind: 'markdown' })),
        { path: '/somewhere/kb/one-job.md', sha256: '0123456789abcdef', lastModified: '2026-09-01T00:00:00.000Z' },
      ],
      corpus: { mode: 'documents', docs: 3 },
      grounding: { repoRef: 'corpus@5f2c9a1e', total: 3, verified: 3, partial: 0, drifted: 0, missingFile: 0, exact: 3 },
    },
    modules: [
      { id: 'cadence', title: 'Cadence', lessons: [{ id: 'l1', blocks: [quoteBlock('weekly/2026-09-15.md', 'Invoices now go out on the 5th of every month, replacing the 1st.'), { type: 'prose', md: 'p' }] }] },
      { id: 'history', title: 'History', lessons: [{ id: 'l1', blocks: [quoteBlock('weekly/2026-09-01.md', 'We decided invoices go out on the 1st of every month.')] }] },
      { id: 'refunds', title: 'Refunds', lessons: [{ id: 'l1', blocks: [quoteBlock('handbook.md', 'Refunds above 500 dollars need a second approver.')] }] },
    ],
  }
  return { corpus, bundle, ...engineWith(bundle) }
}

describe('changedCorpusDocs + reverify (documents course)', () => {
  it('reports nothing changed when every document still matches its recorded hash, and skips legacy 16-char entries', () => {
    const c = documentsCourse()
    expect(changedCorpusDocs(c.bundle, c.corpus)).toEqual(new Set())
    // `since` is a git ref; a documents course has no history, so it is ignored rather than failing
    const r = reverify({ system: 'notes', bundlePath: c.bundlePath, repo: c.corpus, root: c.root, since: 'not-a-ref' })
    expect(r).toMatchObject({ mode: 'documents', base: 'corpus@5f2c9a1e', changed: 0, changedDocs: 0, affected: [], bad: [] })
    expect(r.summary).toMatchObject({ total: 3, verified: 3, exact: 3 })
  })

  it('an edited document affects exactly the modules that cite it', () => {
    const c = documentsCourse()
    appendFileSync(path.join(c.corpus, 'weekly/2026-09-15.md'), '\n- Ben owns the remit report.\n')
    expect(changedCorpusDocs(c.bundle, c.corpus)).toEqual(new Set(['weekly/2026-09-15.md']))
    const r = reverify({ system: 'notes', bundlePath: c.bundlePath, repo: c.corpus, root: c.root })
    expect(r.changed).toBe(1)
    expect(r.affected).toEqual([{ moduleId: 'cadence', title: 'Cadence', files: ['weekly/2026-09-15.md'], blocks: 1 }])
    expect(r.bad).toEqual([]) // the quote itself is still in the document
  })

  it('a deleted document is changed, and the quotes citing it are missing-file', () => {
    const c = documentsCourse()
    rmSync(path.join(c.corpus, 'handbook.md'))
    expect(changedCorpusDocs(c.bundle, c.corpus)).toEqual(new Set(['handbook.md']))
    const r = reverify({ system: 'notes', bundlePath: c.bundlePath, repo: c.corpus, root: c.root })
    expect(r.affected.map((a) => a.moduleId)).toEqual(['refunds'])
    expect(r.bad).toEqual([{ status: 'missing-file', moduleId: 'refunds', sourcePath: 'handbook.md' }])
  })

  it('--write makes the current documents the baseline and keeps the corpus repoRef', () => {
    const c = documentsCourse()
    appendFileSync(path.join(c.corpus, 'handbook.md'), '\nUpdated.\n')
    const r = reverify({ system: 'notes', bundlePath: c.bundlePath, repo: c.corpus, root: c.root, write: true })
    expect(r.restamped).toBe('corpus@5f2c9a1e')
    const written = JSON.parse(readFileSync(path.join(c.root, c.bundlePath), 'utf8'))
    expect(written.provenance.sources.find((s: any) => s.path === 'handbook.md').sha256).toBe(sha256(readFileSync(path.join(c.corpus, 'handbook.md'), 'utf8')))
    expect(written.provenance.sources.at(-1).sha256).toBe('0123456789abcdef') // legacy entry untouched
    expect(reverify({ system: 'notes', bundlePath: c.bundlePath, repo: c.corpus, root: c.root }).changed).toBe(0)
  })
})

describe('reverify (mixed course): the git diff and the changed corpus documents, unioned', () => {
  it('maps a committed code change and an edited corpus document onto their modules', () => {
    const repo = scratch('mixed')
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const notes = '.system-explainer/corpus/weekly.md'
    const notesText = '# Weekly\n\n- The remit job runs nightly at 02:00 UTC, after the bank file lands.\n'
    writeFiles(repo, { '.gitignore': '.system-explainer/\n', 'src/remit.ts': 'export function runRemit() {}\n', 'src/other.ts': 'export const other = 1\n', [notes]: notesText })
    git('init', '-q')
    git('add', '-A')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initial')
    const sha = git('rev-parse', 'HEAD').trim()
    const bundle = {
      system: { id: 'mixed', name: 'Mixed', oneLiner: 'x' },
      provenance: {
        sources: [{ path: notes, sha256: sha256(notesText), title: 'Weekly', kind: 'markdown', date: '2026-09-01' }],
        corpus: { mode: 'mixed', docs: 1 },
        grounding: { repoRef: `repo@${sha}` },
      },
      modules: [
        { id: 'code', title: 'Code', lessons: [{ id: 'l1', blocks: [{ type: 'code', language: 'ts', code: 'export function runRemit() {}', sourcePath: 'src/remit.ts' }] }] },
        { id: 'why', title: 'Why', lessons: [{ id: 'l1', blocks: [quoteBlock(notes, 'The remit job runs nightly at 02:00 UTC, after the bank file lands.')] }] },
        { id: 'other', title: 'Other', lessons: [{ id: 'l1', blocks: [{ type: 'code', language: 'ts', code: 'export const other = 1', sourcePath: 'src/other.ts' }] }] },
      ],
    }
    const e = engineWith(bundle)
    appendFileSync(path.join(repo, 'src/remit.ts'), '// touched\n')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-am', 'touch remit')
    appendFileSync(path.join(repo, notes), '\n- Added later.\n') // gitignored: only its recorded hash can see this edit

    const r = reverify({ system: 'mixed', bundlePath: e.bundlePath, repo, root: e.root })
    expect(r).toMatchObject({ mode: 'mixed', base: sha, changed: 2, changedDocs: 1 })
    expect(r.affected.map((a) => a.moduleId)).toEqual(['code', 'why'])

    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    printReverify('mixed', e.bundlePath, r, false)
    expect(log.mock.calls[0][0]).toBe(`reverify mixed: 1 file(s) changed since ${sha.slice(0, 7)}, 1 source document(s) changed since the course was built`)
    log.mockRestore()
  })
})

describe('printReverify', () => {
  afterEach(() => vi.restoreAllMocks())
  const summary = { total: 2, verified: 2, partial: 0, drifted: 0, missingFile: 0, noSource: 0, exact: 2 }
  const affected = [{ moduleId: 'cadence', title: 'Cadence', files: ['weekly/2026-09-15.md'], blocks: 1 }]
  const lines = (r: ReverifyResult, write = false) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    printReverify('notes', 'bundles/notes/bundle.json', r, write)
    return log.mock.calls.map((c) => c[0])
  }

  it('keeps the code-mode output exactly as it was', () => {
    expect(lines({ mode: 'code', base: '36e4a82deadbeef', changed: 2, affected: [{ moduleId: 'routing', title: 'Routing', files: ['src/app.py'], blocks: 1 }], summary, bad: [] })).toEqual([
      'reverify notes: 2 file(s) changed since 36e4a82',
      '  1 module(s) cite changed files:',
      '   • routing ("Routing") — 1 block(s): src/app.py',
      '  grounding @ HEAD: 2/2 verified, 2 exact',
      '  (dry run — pass --write to restamp the bundle at HEAD)',
    ])
  })

  it('words a documents course by its documents, not by a sha', () => {
    const out = lines({ mode: 'documents', base: 'corpus@5f2c9a1e', changed: 1, changedDocs: 1, affected, summary, bad: [] })
    expect(out[0]).toBe('reverify notes: 1 source document(s) changed since the course was built')
    expect(out[1]).toBe('  1 module(s) cite changed source documents:')
    expect(out.join('\n')).not.toContain('since corpus')
  })
})
