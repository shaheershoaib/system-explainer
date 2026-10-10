import { describe, it, expect, afterAll, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type Anthropic from '@anthropic-ai/sdk'
import { assemble, AssembleError } from './assemble-bundle'
import { DOCUMENT_RULES, MIXED_RULES, SOURCES_HEADER, runCourse, type CourseOptions } from './course'
import { createFakeCoursePlayer, roleOf } from './fake-course-roles'
import type { CorpusDoc, CorpusManifest } from './ingest/types'
import { createFakeClient, type FakeStep } from './llm/fake'
import { repoRefOf } from './repo-ref'
import { validateBundle } from './validate'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.resolve(here, '..', 'fixtures', 'mini-repo')
const tmp: string[] = []
const scratch = (label: string) => {
  const d = mkdtempSync(path.join(tmpdir(), `course-${label}-`))
  tmp.push(d)
  return d
}
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true })
})

/** A copy of the fixture, so the disk-bus writes (.system-explainer/) stay out of the repo. */
function freshRepo(): string {
  const repo = scratch('repo')
  cpSync(fixture, repo, { recursive: true })
  return repo
}
/** A minimal engine dir for assemble to write into. */
function engineDir(): string {
  const root = scratch('engine')
  mkdirSync(path.join(root, 'bundles'))
  mkdirSync(path.join(root, 'public'))
  return root
}
type Script = Parameters<typeof createFakeClient>[0]
const options = (repo: string, root: string, script: Script): CourseOptions => ({
  client: createFakeClient(script),
  model: 'claude-opus-5',
  repoPath: repo,
  systemName: 'tinystore',
  root,
})
const readBundle = (p: string) => JSON.parse(readFileSync(p, 'utf8'))

describe('runCourse (offline, fake model)', () => {
  it('courses the fixture repo end to end: one grounded module per source file, a validated bundle, usage and cost', async () => {
    const repo = freshRepo()
    const root = engineDir()
    const events: { type: string; label: string }[] = []
    const res = await runCourse({ ...options(repo, root, createFakeCoursePlayer(repo)), onEvent: (e) => events.push(e) })

    expect(res.modules).toEqual(['events', 'index', 'store'])
    expect(res.workDir).toBe(path.join(repo, '.system-explainer', 'auto-course', 'tinystore'))
    for (const f of ['plan.json', 'datamodel.json', 'drafts/events.json', 'drafts/store.json', 'modules/events.json', 'modules/index.json', 'modules/store.json'])
      expect(existsSync(path.join(res.workDir, f)), f).toBe(true)
    const plan = JSON.parse(readFileSync(path.join(res.workDir, 'plan.json'), 'utf8'))
    expect(plan).toMatchObject({ systemName: 'tinystore', audience: 'developer', depth: 'L3', repoUrl: null })
    expect(plan.domains.map((d: { id: string }) => d.id)).toEqual(['events', 'index', 'store'])

    expect(res.bundlePath).toBe(path.join(root, 'bundles', 'tinystore', 'bundle.json'))
    const bundle = readBundle(res.bundlePath)
    expect(validateBundle(bundle).ok).toBe(true)
    expect(bundle.system).toMatchObject({ id: 'tinystore', audience: 'developer', depth: 'L3' })
    expect(bundle.modules.map((m: { id: string }) => m.id)).toEqual(res.modules)
    expect(readBundle(path.join(root, 'public', 'bundle.json')).system.id).toBe('tinystore')

    // the fake copies verbatim runs, so the real grounding gate marks every snippet verified and exact
    expect(res.grounding).toBeDefined()
    expect(res.grounding!.total).toBe(3)
    expect(res.grounding!.verified).toBe(res.grounding!.total)
    expect(res.grounding!.exact).toBeGreaterThanOrEqual(1)
    expect(res.grounding!.drifted + res.grounding!.missingFile).toBe(0)
    expect(bundle.provenance.grounding).toMatchObject({ total: 3, verified: 3 })
    expect(res.dataModelEntities).toBeGreaterThanOrEqual(2)
    expect(res.dataModelEntities).toBeLessThanOrEqual(4)

    // one agent per role instance; the author+verify pairs ran concurrently, so compare as a set
    const labels = res.agents.map((a) => a.label)
    expect(labels[0]).toBe('enumerate')
    expect(labels[1]).toBe('data-model')
    expect(labels.at(-1)).toBe('completeness:r1')
    expect([...labels].sort()).toEqual(['author:events', 'author:index', 'author:store', 'completeness:r1', 'data-model', 'enumerate', 'verify:events', 'verify:index', 'verify:store'])
    expect(res.agents.every((a) => a.stopReason === 'submitted')).toBe(true)
    expect(res.agents.every((a) => a.turns >= 1)).toBe(true)

    expect(res.usage.input_tokens).toBeGreaterThan(0)
    expect(res.usage.input_tokens).toBe(res.agents.reduce((n, a) => n + a.usage.input_tokens, 0))
    expect(typeof res.estimatedCostUsd).toBe('number')
    expect(res.estimatedCostUsd).toBeGreaterThan(0)
    expect(res.seconds).toBeGreaterThanOrEqual(0)
    expect(events.filter((e) => e.type === 'phase').map((e) => e.label)).toEqual(['Enumerate', 'Data model', 'Author + verify', 'Completeness', 'Assemble'])
  })

  it('drops a domain whose author never submits, records both attempts, and still assembles the rest', async () => {
    const repo = freshRepo()
    const root = engineDir()
    const base = createFakeCoursePlayer(repo)
    const stubborn = (i: number, p: Anthropic.MessageCreateParamsNonStreaming): FakeStep =>
      roleOf(p) === 'author' && String(p.messages[0].content).includes('MODULE ID: store') ? { text: 'Still reading, one moment.' } : base(i, p)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const res = await runCourse(options(repo, root, stubborn))
      expect(res.modules).toEqual(['events', 'index'])
      expect(existsSync(path.join(res.workDir, 'modules', 'store.json'))).toBe(false)
      expect(validateBundle(readBundle(res.bundlePath)).ok).toBe(true)

      const failed = res.agents.filter((a) => a.stopReason !== 'submitted')
      expect(failed.map((a) => a.label)).toEqual(['author:store', 'author:store (retry)'])
      expect(failed.map((a) => a.stopReason)).toEqual(['ended_without_submit', 'ended_without_submit'])
      expect(res.agents.some((a) => a.label === 'verify:store')).toBe(false)
      expect(res.usage.input_tokens).toBe(res.agents.reduce((n, a) => n + a.usage.input_tokens, 0))
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/dropping domain "store"/))
    } finally {
      warn.mockRestore()
    }
  })

  it('unknown model: usage is still summed but the cost estimate is null', async () => {
    const repo = freshRepo()
    const res = await runCourse({ ...options(repo, engineDir(), createFakeCoursePlayer(repo)), model: 'not-a-priced-model', concurrency: 1 })
    expect(res.modules).toHaveLength(3)
    expect(res.usage.output_tokens).toBeGreaterThan(0)
    expect(res.estimatedCostUsd).toBeNull()
  })
})

describe('assemble (the back half as a function)', () => {
  function workDir(): string {
    const dir = scratch('work')
    mkdirSync(path.join(dir, 'modules'))
    writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ systemName: 'Demo', oneLiner: 'demo', elevatorPitch: 'pitch', outOfScope: [], audience: 'developer', depth: 'L3', repoUrl: null, domains: [{ id: 'a' }] }))
    writeFileSync(path.join(dir, 'modules', 'a.json'), JSON.stringify({ id: 'a', title: 'A', objective: 'o', concepts: [], lessons: [{ title: 'L', prose: 'p' }], quiz: [] }))
    return dir
  }
  it('returns the validated bundle and where it was written', () => {
    const root = engineDir()
    const res = assemble({ dir: workDir(), system: 'demo', root })
    expect(res.outPath).toBe(path.join(root, 'bundles', 'demo', 'bundle.json'))
    expect(res.grounding).toBeUndefined()
    expect(res.bundle.modules.map((m) => m.id)).toEqual(['a'])
    expect(validateBundle(readBundle(res.outPath)).ok).toBe(true)
    expect(existsSync(path.join(root, 'public', 'bundle.json'))).toBe(true)
  })
  it('throws an AssembleError instead of exiting when the repo does not exist', () => {
    const dir = workDir()
    const call = () => assemble({ dir, system: 'demo', repo: path.join(dir, 'nope'), root: engineDir() })
    expect(call).toThrow(AssembleError)
    expect(call).toThrow(/--repo not found/)
  })
})

// ── documents and mixed modes ───────────────────────────────────────────────────────────────
type Params = Anthropic.MessageCreateParamsNonStreaming
interface DocSpec {
  path: string
  title: string
  kind: CorpusDoc['kind']
  service?: string
  date: string
  origin: string
  speakers?: string[]
  body: string
}
// Listed out of date order on purpose: the SOURCES block must still come out oldest first.
const DOCS: DocSpec[] = [
  {
    path: 'ops-handbook-2026-09-05/handbook.md',
    title: 'Billing ops handbook',
    kind: 'pdf',
    date: '2026-09-05',
    origin: 'https://example.com/billing-ops-handbook.pdf',
    body: '# Billing ops handbook\n\nEvery invoice batch is approved by the Finance Lead before it is sent to customers.\n',
  },
  {
    path: 'kickoff-2026-08-01/notes.md',
    title: 'Billing kickoff',
    kind: 'markdown',
    service: 'Granola',
    date: '2026-08-01',
    origin: 'https://notes.example.com/d/kickoff-0801',
    speakers: ['Alice Chen', 'Bob Diaz'],
    body: '# Billing kickoff\n\nAlice Chen: We decided to store every invoice in Postgres so finance can query it directly.\nBob Diaz: The Billing Service owns the invoice table and nobody else writes to it.\n',
  },
  {
    // reverses the kickoff decision
    path: 'design-review-2026-08-20/notes.md',
    title: 'Storage design review',
    kind: 'markdown',
    date: '2026-08-20',
    origin: '/home/alice/notes/design-review.md',
    speakers: ['Bob Diaz'],
    body: '# Storage design review\n\nBob Diaz: We are reversing the kickoff decision, invoices move from Postgres to DynamoDB.\nNobody has decided yet who migrates the historical invoices.\n',
  },
]
const UNREACHABLE = { source: 'https://chat.example.com/archives/C123', why: 'The chat archive needs a sign-in the CLI does not have.' }

/** Write the docs (front matter + body) and a manifest shaped per the corpus contract, with real sha256s. */
function writeCorpus(dir: string, specs: DocSpec[]): CorpusManifest {
  const docs = specs.map((s): CorpusDoc => {
    const text = `---\ntitle: ${s.title}\nsource: ${s.origin}\ndate: ${s.date}\n---\n${s.body}`
    mkdirSync(path.dirname(path.join(dir, s.path)), { recursive: true })
    writeFileSync(path.join(dir, s.path), text)
    const doc: CorpusDoc = { path: s.path, sourceId: s.path.split('/')[0], title: s.title, kind: s.kind, origin: s.origin, date: s.date, retrievedAt: '2026-10-10T00:00:00Z', sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) }
    if (s.speakers) doc.speakers = s.speakers
    if (s.service) doc.service = s.service
    return doc
  })
  const manifest: CorpusManifest = {
    version: 1,
    createdAt: '2026-10-10T00:00:00Z',
    sources: [
      ...specs.map((s) => ({ raw: s.origin, kind: s.kind, status: 'ok' as const, docs: [s.path] })),
      { raw: UNREACHABLE.source, kind: 'remote', status: 'unreachable', docs: [], problem: { source: UNREACHABLE.source, kind: 'remote', why: UNREACHABLE.why, fixes: ['Export the channel and pass the export folder.'] } },
    ],
    docs,
  }
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return manifest
}

const blocksOf = (bundle: any): any[] => bundle.modules.flatMap((m: any) => m.lessons.flatMap((l: any) => l.blocks))
/** The SOURCES block's document lines (it ends at the first blank line). */
const sourceLines = (system: string) => system.slice(system.indexOf(SOURCES_HEADER) + SOURCES_HEADER.length + 1).split('\n\n')[0].split('\n')
const toolResultsOf = (p: Params) =>
  p.messages
    .flatMap((m) => (m.role === 'user' && Array.isArray(m.content) ? m.content : []))
    .filter((b): b is Anthropic.ToolResultBlockParam => b.type === 'tool_result')
    .map((b) => ({ content: String(b.content), isError: !!b.is_error }))

describe('runCourse documents mode (offline, fake model)', () => {
  it('courses a corpus: exact quote blocks cited from the manifest, corpus provenance, SOURCES oldest first in every prompt', async () => {
    const ws = scratch('docs')
    const corpusDir = path.join(ws, '.system-explainer', 'corpus')
    const manifest = writeCorpus(corpusDir, DOCS)
    const systems: string[] = []
    const base = createFakeCoursePlayer(corpusDir)
    const res = await runCourse({
      client: createFakeClient((i, p) => {
        systems.push(String(p.system))
        return base(i, p)
      }),
      model: 'claude-opus-5',
      repoPath: corpusDir,
      systemName: 'billing',
      root: engineDir(),
      mode: 'documents',
      corpus: { dir: corpusDir, manifest, relPath: '' },
    })

    expect(res.workDir).toBe(path.join(ws, '.system-explainer', 'auto-course', 'billing'))
    expect(res.modules).toEqual(['design-review-2026-08-20', 'kickoff-2026-08-01', 'ops-handbook-2026-09-05'])
    expect(res.agents.every((a) => a.stopReason === 'submitted')).toBe(true)
    expect(res.agents.map((a) => a.label).sort()).toEqual([
      'author:design-review-2026-08-20', 'author:kickoff-2026-08-01', 'author:ops-handbook-2026-09-05', 'completeness:r1', 'data-model', 'enumerate',
      'verify:design-review-2026-08-20', 'verify:kickoff-2026-08-01', 'verify:ops-handbook-2026-09-05',
    ])
    expect(res.dataModelEntities).toBeGreaterThanOrEqual(2)
    expect(res.dataModelEntities).toBeLessThanOrEqual(4)

    const bundle = readBundle(res.bundlePath)
    expect(validateBundle(bundle).ok).toBe(true)
    const blocks = blocksOf(bundle)
    expect(blocks.some((b) => b.type === 'code')).toBe(false)
    const quotes = blocks.filter((b) => b.type === 'quote')
    expect(quotes).toHaveLength(3)
    for (const q of quotes) {
      expect(q.verified).toBe('verified')
      expect(q.lineRange).toBeDefined()
    }
    expect(res.grounding).toMatchObject({ total: 3, verified: 3, exact: 3, drifted: 0, missingFile: 0 })

    const bySource = (p: string) => quotes.find((q) => q.sourcePath === p)
    const kickoff = bySource('kickoff-2026-08-01/notes.md')
    expect(kickoff.text).toBe('Alice Chen: We decided to store every invoice in Postgres so finance can query it directly.\nBob Diaz: The Billing Service owns the invoice table and nobody else writes to it.')
    expect(kickoff.lineRange).toEqual({ start: 8, end: 9 })
    expect(kickoff.cite).toEqual({ title: 'Billing kickoff', kind: 'Granola', date: '2026-08-01', url: 'https://notes.example.com/d/kickoff-0801' })
    // a local origin is not a link
    expect(bySource('design-review-2026-08-20/notes.md').cite).toEqual({ title: 'Storage design review', kind: 'markdown', date: '2026-08-20' })
    expect(bySource('ops-handbook-2026-09-05/handbook.md').cite).toEqual({ title: 'Billing ops handbook', kind: 'pdf', date: '2026-09-05', url: 'https://example.com/billing-ops-handbook.pdf' })
    expect(blocks.some((b) => b.type === 'callout' && b.variant === 'note' && b.md.startsWith('Open question:'))).toBe(true)
    expect(bundle.modules.every((m: { quiz: unknown[] }) => m.quiz.length === 2)).toBe(true)

    const prov = bundle.provenance
    expect(prov.corpus).toEqual({ mode: 'documents', docs: 3, unreachable: [UNREACHABLE] })
    expect(prov.sources).toHaveLength(3)
    for (const d of manifest.docs) expect(prov.sources.find((s: { path: string }) => s.path === d.path)?.sha256).toBe(d.sha256)
    expect(prov.sources.find((s: { path: string }) => s.path === 'kickoff-2026-08-01/notes.md')).toEqual({
      path: 'kickoff-2026-08-01/notes.md', sha256: manifest.docs[1].sha256, title: 'Billing kickoff', kind: 'Granola', origin: 'https://notes.example.com/d/kickoff-0801', date: '2026-08-01', retrievedAt: '2026-10-10T00:00:00Z',
    })
    const pin = manifest.docs.map((d) => `${d.path}:${d.sha256}`).sort().join('\n')
    expect(prov.grounding.repoRef).toBe(`corpus@${createHash('sha256').update(pin).digest('hex').slice(0, 12)}`)

    // every agent: ROLE then MODE, the document rules, and the SOURCES block oldest first
    expect(systems.length).toBeGreaterThan(0)
    for (const s of systems) {
      const [role, mode] = s.split('\n')
      expect(role).toMatch(/^ROLE: (enumerate|data-model|author|verify|critic)$/)
      expect(mode).toBe('MODE: documents')
      expect(s).toContain(DOCUMENT_RULES)
      expect(s).not.toContain(MIXED_RULES)
      expect(sourceLines(s)).toEqual([
        'kickoff-2026-08-01/notes.md | Billing kickoff | markdown | 2026-08-01 | Alice Chen, Bob Diaz',
        'design-review-2026-08-20/notes.md | Storage design review | markdown | 2026-08-20 | Bob Diaz',
        'ops-handbook-2026-09-05/handbook.md | Billing ops handbook | pdf | 2026-09-05 | -',
      ])
    }
  })

  it('refuses documents mode without a corpus', async () => {
    const call = runCourse({ ...options(scratch('nocorpus'), engineDir(), () => ({ text: 'unused' })), mode: 'documents' })
    await expect(call).rejects.toThrow(/needs options\.corpus/)
  })
})

describe('runCourse mixed mode (offline, fake model)', () => {
  it('courses code plus the corpus beside it, hides the run output from every agent, and grounds snippets and quotes', async () => {
    const repo = freshRepo()
    const corpusDir = path.join(repo, '.system-explainer', 'corpus')
    const manifest = writeCorpus(corpusDir, DOCS.slice(1))
    const secret = 'TOP-SECRET-BUNDLE-CONTENT'
    mkdirSync(path.join(repo, '.system-explainer', 'bundles'), { recursive: true })
    writeFileSync(path.join(repo, '.system-explainer', 'bundles', 'x.json'), JSON.stringify({ secret }))
    const transcripts = scratch('transcripts')
    const systems: string[] = []
    const probes: { content: string; isError: boolean }[] = []
    const base = createFakeCoursePlayer(repo)
    // The critic first probes the run output, then answers as usual (the fake critic ignores tool results).
    const player = (i: number, p: Params): FakeStep => {
      systems.push(String(p.system))
      if (roleOf(p) === 'critic') {
        const results = toolResultsOf(p)
        if (!results.length)
          return {
            toolUse: [
              { name: 'list_dir', input: { path: '.system-explainer' } },
              { name: 'list_dir', input: { path: '.system-explainer/bundles' } },
              { name: 'read_file', input: { path: '.system-explainer/bundles/x.json' } },
              { name: 'search', input: { pattern: secret, fixed_strings: true } },
            ],
          }
        if (!probes.length) probes.push(...results)
      }
      return base(i, p)
    }
    const res = await runCourse({ ...options(repo, engineDir(), player), mode: 'mixed', corpus: { dir: corpusDir, manifest, relPath: '.system-explainer/corpus' }, transcriptDir: transcripts })

    expect(res.workDir).toBe(path.join(repo, '.system-explainer', 'auto-course', 'tinystore'))
    expect(res.modules).toEqual(['events', 'index', 'store', 'design-review-2026-08-20', 'kickoff-2026-08-01'])
    expect(res.agents.every((a) => a.stopReason === 'submitted')).toBe(true)

    // hidden: listing shows only the corpus, the bundle file reads as missing, a search finds nothing
    expect(probes).toHaveLength(4)
    expect(probes[0]).toEqual({ content: '.system-explainer/corpus/', isError: false })
    expect(probes[1].isError).toBe(true)
    expect(probes[1].content).toMatch(/not found/)
    expect(probes[2].isError).toBe(true)
    expect(probes[2].content).toMatch(/not found/)
    expect(probes[3]).toEqual({ content: '(no matches)', isError: false })
    const outputs = readdirSync(transcripts)
      .flatMap((f) => readFileSync(path.join(transcripts, f), 'utf8').trim().split('\n'))
      .map((l) => JSON.parse(l))
      .flatMap((e) => (Array.isArray(e.next?.content) ? e.next.content : []))
      .filter((b: { type: string }) => b.type === 'tool_result')
      .map((b: { content: unknown }) => String(b.content))
    expect(outputs.some((c) => c.includes('We decided to store every invoice'))).toBe(true)
    expect(outputs.some((c) => c.includes(secret))).toBe(false)

    const bundle = readBundle(res.bundlePath)
    expect(validateBundle(bundle).ok).toBe(true)
    const blocks = blocksOf(bundle)
    expect(blocks.filter((b) => b.type === 'code')).toHaveLength(3)
    const quotes = blocks.filter((b) => b.type === 'quote')
    expect(quotes.map((q) => q.sourcePath).sort()).toEqual(['.system-explainer/corpus/design-review-2026-08-20/notes.md', '.system-explainer/corpus/kickoff-2026-08-01/notes.md'])
    for (const q of quotes) expect(q.verified).toBe('verified')
    expect(quotes.find((q) => q.sourcePath.includes('kickoff')).cite).toEqual({ title: 'Billing kickoff', kind: 'Granola', date: '2026-08-01', url: 'https://notes.example.com/d/kickoff-0801' })
    expect(res.grounding).toMatchObject({ total: 5, verified: 5, drifted: 0, missingFile: 0 })
    expect(bundle.provenance.corpus).toEqual({ mode: 'mixed', docs: 2, unreachable: [UNREACHABLE] })
    expect(bundle.provenance.sources.map((s: { path: string; sha256: string }) => [s.path, s.sha256])).toEqual(manifest.docs.map((d) => [`.system-explainer/corpus/${d.path}`, d.sha256]))
    expect(bundle.provenance.grounding.repoRef).toBe(repoRefOf(repo))
    expect(bundle.provenance.sourceLicense).toBeDefined()

    for (const s of systems) {
      expect(s.split('\n')[1]).toBe('MODE: mixed')
      expect(s).toContain('Start by listing the repository root and src.')
      expect(s).toContain(DOCUMENT_RULES)
      expect(s).toContain(MIXED_RULES)
      expect(sourceLines(s)).toEqual([
        '.system-explainer/corpus/kickoff-2026-08-01/notes.md | Billing kickoff | markdown | 2026-08-01 | Alice Chen, Bob Diaz',
        '.system-explainer/corpus/design-review-2026-08-20/notes.md | Storage design review | markdown | 2026-08-20 | Bob Diaz',
      ])
    }
  })
})

describe('runCourse code mode prompts', () => {
  it('every system prompt is ROLE then MODE: code, with no documents material', async () => {
    const repo = freshRepo()
    const systems: string[] = []
    const base = createFakeCoursePlayer(repo)
    await runCourse(
      options(repo, engineDir(), (i, p) => {
        systems.push(String(p.system))
        return base(i, p)
      }),
    )
    expect(systems.length).toBeGreaterThan(0)
    for (const s of systems) {
      expect(s.split('\n')[1]).toBe('MODE: code')
      expect(s).not.toContain(SOURCES_HEADER)
      expect(s).not.toContain('RULES FOR')
    }
  })
})
