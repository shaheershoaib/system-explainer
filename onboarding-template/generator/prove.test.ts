import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type Anthropic from '@anthropic-ai/sdk'
import { createFakeProofPlayer } from './fake-proof-roles'
import { createFakeClient } from './llm/fake'
import { collectCitedPaths, DOCS_TRUTH_SCOPE } from './proof'
import { runProve, SKEPTIC_DOCUMENT_RULES, SKEPTIC_MIXED_RULE, type ProveEvent } from './prove'
import { applyGrounding, summarize, verifyGrounding } from './verify-grounding'

type Params = Anthropic.MessageCreateParamsNonStreaming

const here = path.dirname(fileURLToPath(import.meta.url))
const ZUSTAND_BUNDLE = path.resolve(here, '..', 'bundles', 'zustand', 'bundle.json')
const BUNDLE_REL = 'bundles/zustand/bundle.json'

const tmp: string[] = []
const scratch = (label: string) => {
  const d = mkdtempSync(path.join(tmpdir(), `prove-${label}-`))
  tmp.push(d)
  return d
}
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true })
})

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'))

/** A temp engine root holding a copy of the real zustand bundle (4 validated modules with cited paths), optionally edited. */
function engineRoot(edit?: (bundle: any) => void): string {
  const root = scratch('root')
  const bundle = readJson(ZUSTAND_BUNDLE)
  edit?.(bundle)
  mkdirSync(path.join(root, 'bundles', 'zustand'), { recursive: true })
  writeFileSync(path.join(root, BUNDLE_REL), JSON.stringify(bundle))
  return root
}

/** Empty placeholder files at every path the bundle cites: the fake skeptic only needs them to exist. */
function placeholderRepo(bundle: any): string {
  const repo = scratch('repo')
  for (const m of bundle.modules)
    for (const p of collectCitedPaths(m, bundle.traces)) {
      mkdirSync(path.dirname(path.join(repo, p)), { recursive: true })
      writeFileSync(path.join(repo, p), '')
    }
  return repo
}

const systemOf = (p: Params) => String(p.system)
const userOf = (p: Params) => String(p.messages[0].content)
const toolNames = (p: Params) => ((p.tools ?? []) as Anthropic.Tool[]).map((t) => t.name)

describe('runProve', () => {
  it('drives skeptic, quizgen and both learners per module through the fake client and renders the report', async () => {
    const root = engineRoot()
    const repoPath = placeholderRepo(readJson(ZUSTAND_BUNDLE))
    const modules = ['vanilla-store', 'react-binding']
    const seen: Params[] = []
    const events: ProveEvent[] = []
    const player = createFakeProofPlayer()
    const client = createFakeClient((i, params) => {
      seen.push(params)
      return player(i, params)
    })

    const res = await runProve({ client, model: 'claude-sonnet-4-6', system: 'zustand', bundlePath: BUNDLE_REL, repoPath, root, modules, onEvent: (e) => events.push(e) })
    const run = path.join(root, 'proof-runs', 'zustand')

    expect(res.skipped).toBeUndefined()
    expect(res.modules).toEqual(modules)
    for (const id of modules) {
      const input = readJson(path.join(run, 'inputs', `${id}.claims.json`))
      const adv = readJson(path.join(run, 'adversarial', `${id}.json`))
      expect(adv.moduleId).toBe(id)
      expect(adv.claims.length).toBeGreaterThan(0)
      expect(adv.claims).toHaveLength(input.claims.length)
      expect(adv.claims.every((c: any) => c.verdict === 'supported')).toBe(true)
      expect(adv.claims[0].evidence).toContain(input.citedPaths[0])

      expect(readJson(path.join(run, 'genraw', `${id}.json`)).items).toHaveLength(5)
      const quiz = readJson(path.join(run, 'genquiz', `${id}.quiz.json`))
      const itemIds = quiz.quiz.map((q: any) => q.id)
      expect(itemIds).toEqual(['g1', 'g2', 'g3', 'g4', 'g5'])
      const taught = readJson(path.join(run, 'learner-gen', `${id}.json`))
      const cold = readJson(path.join(run, 'learner-gen-cold', `${id}.json`))
      expect(taught).toMatchObject({ moduleId: id, mode: 'taught' })
      expect(cold).toMatchObject({ moduleId: id, mode: 'cold' })
      expect(taught.answers.map((a: any) => a.id)).toEqual(itemIds)
      expect(cold.answers.map((a: any) => a.id)).toEqual(itemIds)
    }

    expect(res.reportPath).toBe(path.join(run, 'PROOF_REPORT.md'))
    const md = readFileSync(res.reportPath!, 'utf8')
    expect(md).toContain('## Layer 2')
    expect(md).toContain('modules covered: 2/4')
    expect(res.adversarial).toMatchObject({ refuted: 0, unverifiable: 0 })
    expect(res.adversarial!.supported).toBe(res.adversarial!.total)
    expect(res.effectiveness).toEqual({ taughtOverall: expect.any(Number), coldOverall: expect.any(Number) })
    // every learner covered every item, so the report excluded no run as invalid
    expect(readJson(path.join(run, 'proof-report.json')).effectiveness.invalidRuns).toEqual([])

    expect(res.agents).toHaveLength(8)
    expect(res.agents.map((a) => a.label).sort()).toEqual(modules.flatMap((id) => [`verify:${id}`, `quizgen:${id}`, `learn:taught:${id}`, `learn:cold:${id}`]).sort())
    expect(res.agents.every((a) => a.stopReason === 'submitted')).toBe(true)
    expect(res.usage.input_tokens).toBeGreaterThan(0)
    expect(res.usage.input_tokens).toBe(res.agents.reduce((n, a) => n + a.usage.input_tokens, 0))
    expect(res.estimatedCostUsd).toBeGreaterThan(0)
    expect(res.seconds).toBeGreaterThanOrEqual(0)

    // wiring: every system prompt leads with ROLE:, the skeptics read a real file through the repo
    // sandbox, the learners had no tools at all, and only the taught learner saw the lesson
    expect(seen.every((p) => systemOf(p).startsWith('ROLE: '))).toBe(true)
    const byRole = (role: string) => seen.filter((p) => systemOf(p).startsWith(`ROLE: ${role}\n`))
    expect(byRole('skeptic').every((p) => toolNames(p).includes('read_file'))).toBe(true)
    const reads = events.filter((e) => e.type === 'tool')
    expect(reads).toHaveLength(2)
    expect(reads.every((e) => e.label === 'read_file' && !e.detail?.includes('error'))).toBe(true)
    expect(byRole('learner-taught')).toHaveLength(2)
    expect(byRole('learner-taught').every((p) => toolNames(p).join() === 'submit_result' && userOf(p).includes('<lesson>'))).toBe(true)
    expect(byRole('learner-cold')).toHaveLength(2)
    expect(byRole('learner-cold').every((p) => toolNames(p).join() === 'submit_result' && !userOf(p).includes('<lesson>'))).toBe(true)
    expect(events.filter((e) => e.type === 'phase').map((e) => e.label)).toEqual(['Prep', 'Verify-true', 'Quizgen', 'Effective', 'Report'])
  })

  it('with affected: true and no cited file changed since the pinned sha, returns nothing-affected without an agent or a run dir', async () => {
    const repoPath = scratch('git')
    const git = (...args: string[]) => execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    writeFileSync(path.join(repoPath, 'README.md'), '# fixture\n')
    git('init', '-q')
    git('add', '-A')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initial')
    const sha = git('rev-parse', 'HEAD').trim()
    const root = engineRoot((b) => {
      b.provenance.grounding.repoRef = `x@${sha}`
    })
    let calls = 0
    const player = createFakeProofPlayer()
    const client = createFakeClient((i, params) => {
      calls++
      return player(i, params)
    })

    const res = await runProve({ client, model: 'claude-sonnet-4-6', system: 'zustand', bundlePath: BUNDLE_REL, repoPath, root, affected: true })

    expect(res).toMatchObject({ skipped: 'nothing-affected', modules: [], agents: [], estimatedCostUsd: 0 })
    expect(res.usage.input_tokens).toBe(0)
    expect(calls).toBe(0)
    expect(existsSync(path.join(root, 'proof-runs'))).toBe(false)
  })
})

// ── documents and mixed courses ──────────────────────────────────────────────
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

function writeFiles(dir: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    writeFileSync(path.join(dir, rel), text)
  }
}

/** Stamp the bundle's blocks and grounding record against `dir`, the way the course loop does. */
function ground(bundle: any, dir: string, repoRef: string) {
  const results = verifyGrounding(bundle, (p) => (existsSync(path.join(dir, p)) ? readFileSync(path.join(dir, p), 'utf8') : null))
  applyGrounding(bundle, results)
  bundle.provenance.grounding = { repoRef, ...summarize(results) }
}

/** Records every request and counts calls, while the fake player answers. */
function recordingClient() {
  const seen: Params[] = []
  const player = createFakeProofPlayer()
  const client = createFakeClient((i, params) => {
    seen.push(params)
    return player(i, params)
  })
  return { client, seen }
}

const DOC_BUNDLE = 'bundles/billing-notes/bundle.json'
const CORPUS: Record<string, { text: string; title: string; kind: string; date?: string; transcribedBy?: string }> = {
  'weekly/2026-09-15.md': { title: 'Weekly sync', kind: 'markdown', date: '2026-09-15', text: '# Weekly sync 2026-09-15\n\n- Invoices now go out on the 5th of every month, replacing the 1st.\n' },
  'weekly/2026-09-01.md': { title: 'Weekly sync', kind: 'markdown', date: '2026-09-01', text: '# Weekly sync 2026-09-01\n\n- We decided invoices go out on the 1st of every month.\n' },
  'scans/refund-policy.md': { title: 'Refund policy (scan)', kind: 'pdf', transcribedBy: 'claude-sonnet-4-6', text: 'Refunds above 500 dollars need a second approver before they are sent.\n' },
}
const quote = (sourcePath: string, text: string) => ({ type: 'quote', text, sourcePath, cite: { title: CORPUS[sourcePath].title, kind: CORPUS[sourcePath].kind, date: CORPUS[sourcePath].date } })
const lesson = (title: string, blocks: unknown[]) => [{ id: 'l1', title, blocks }]

/** A documents course: two modules quoting a three-document corpus, grounded against it, built without one unreachable source. */
function documentsCourse(): { root: string; corpus: string } {
  const corpus = scratch('corpus')
  writeFiles(corpus, Object.fromEntries(Object.entries(CORPUS).map(([p, d]) => [p, d.text])))
  const bundle: any = {
    schemaVersion: '1.1.0',
    system: { id: 'billing-notes', name: 'Billing notes', oneLiner: 'What the billing team decided' },
    actors: [],
    entities: [],
    modules: [
      {
        id: 'invoice-cadence',
        title: 'Invoice cadence',
        order: 1,
        objective: 'Know when invoices go out',
        lessons: lesson('When invoices go out', [
          { type: 'prose', md: 'Invoices go out on the 5th of every month; the 1st is the old date.' },
          quote('weekly/2026-09-15.md', 'Invoices now go out on the 5th of every month, replacing the 1st.'),
          { type: 'callout', variant: 'gotcha', md: 'Older notes still say the 1st.' },
        ]),
        quiz: [],
      },
      {
        id: 'refunds',
        title: 'Refunds',
        order: 2,
        objective: 'Know who approves a refund',
        lessons: lesson('Approvals', [
          { type: 'prose', md: 'A refund above 500 dollars needs a second approver.' },
          quote('scans/refund-policy.md', 'Refunds above 500 dollars need a second approver before they are sent.'),
        ]),
        quiz: [],
      },
    ],
    provenance: {
      sources: Object.entries(CORPUS).map(([p, d]) => ({ path: p, sha256: sha256(d.text), title: d.title, kind: d.kind, date: d.date, transcribedBy: d.transcribedBy })),
      corpus: { mode: 'documents', docs: 3, unreachable: [{ source: 'https://www.notion.so/acme/Roadmap-0123', why: 'NOTION_TOKEN is not set, so the Notion API cannot be called.' }] },
    },
  }
  ground(bundle, corpus, 'corpus@9c1d2e3f')
  const root = scratch('docroot')
  writeFiles(root, { [DOC_BUNDLE]: JSON.stringify(bundle) })
  return { root, corpus }
}

const between = (text: string, tag: string) => new RegExp(`^<${tag}>\\n([\\s\\S]*?)\\n</${tag}>$`, 'm').exec(text)?.[1]

describe('runProve on a documents course', () => {
  it('checks claims against the corpus with MODE: documents prompts, and labels the report by what it proves', async () => {
    const { root, corpus } = documentsCourse()
    const { client, seen } = recordingClient()
    const events: ProveEvent[] = []
    const res = await runProve({ client, model: 'claude-sonnet-4-6', system: 'billing-notes', bundlePath: DOC_BUNDLE, repoPath: corpus, root, onEvent: (e) => events.push(e) })
    const run = path.join(root, 'proof-runs', 'billing-notes')

    expect(res).toMatchObject({ mode: 'documents', modules: ['invoice-cadence', 'refunds'] })
    expect(res.agents).toHaveLength(8)
    expect(res.agents.every((a) => a.stopReason === 'submitted')).toBe(true)
    expect(seen.every((p) => /^ROLE: \S+\nMODE: documents\n/.test(systemOf(p)))).toBe(true)

    // skeptics: the document rules, the SOURCES list oldest first (undated last), and a real read of the quoted document
    const byRole = (role: string) => seen.filter((p) => systemOf(p).startsWith(`ROLE: ${role}\n`))
    const skeptics = byRole('skeptic').filter((p) => p.messages.length === 1)
    expect(skeptics).toHaveLength(2)
    for (const p of skeptics) {
      expect(userOf(p)).toContain(SKEPTIC_DOCUMENT_RULES)
      expect(userOf(p)).not.toContain(SKEPTIC_MIXED_RULE)
      expect(between(userOf(p), 'sources')?.split('\n')).toEqual([
        'weekly/2026-09-01.md | Weekly sync | markdown | 2026-09-01',
        'weekly/2026-09-15.md | Weekly sync | markdown | 2026-09-15',
        'scans/refund-policy.md | Refund policy (scan) | pdf | -',
      ])
    }
    const reads = events.filter((e) => e.type === 'tool')
    expect(reads).toHaveLength(2)
    expect(reads.every((e) => e.label === 'read_file' && !e.detail?.includes('error'))).toBe(true)
    expect(readJson(path.join(run, 'adversarial', 'invoice-cadence.json')).claims[0].evidence).toBe('weekly/2026-09-15.md: read via read_file, the document states the claim (fake)')

    // the quote is cited (so skeptics and --affected see it), shown to the skeptic as context, and rendered in the lesson
    const claims = readJson(path.join(run, 'inputs', 'invoice-cadence.claims.json'))
    expect(claims.citedPaths).toEqual(['weekly/2026-09-15.md'])
    expect(claims.quotes).toEqual([{ id: 'l1-b1', cite: 'Weekly sync, 2026-09-15; weekly/2026-09-15.md', text: 'Invoices now go out on the 5th of every month, replacing the 1st.' }])
    expect(claims.claims).toHaveLength(2) // prose + callout; a quote is evidence, not a claim
    const quoted = '**Quote** (Weekly sync, 2026-09-15; weekly/2026-09-15.md):\n> Invoices now go out on the 5th of every month, replacing the 1st.'
    expect(readFileSync(path.join(run, 'inputs', 'invoice-cadence.lesson.md'), 'utf8')).toContain(quoted)
    expect(byRole('learner-taught').some((p) => userOf(p).includes(quoted))).toBe(true)
    expect(byRole('learner-cold').some((p) => userOf(p).includes('**Quote**'))).toBe(false)
    expect(userOf(byRole('quizgen')[0])).toContain('a decision a later document superseded (an excellent distractor)')

    const md = readFileSync(res.reportPath!, 'utf8')
    expect(md).toContain('Source of truth: 3 source document(s) (`corpus@9c1d2e3f`)')
    expect(md).toContain('## Built without\n')
    expect(md).toContain('- `https://www.notion.so/acme/Roadmap-0123`: NOTION_TOKEN is not set, so the Notion API cannot be called.')
    expect(md).toContain('## Layer 1 — Faithful: every quote appears verbatim in its source document')
    expect(md).toContain('- `2/2` quotes appear verbatim in their source documents')
    expect(md).toContain('**1 source(s) were transcribed by a model**, not parsed, so quotes from them are checked against the transcription, not the original:')
    expect(md).toContain('- Refund policy (scan) (`scans/refund-policy.md`), transcribed by claude-sonnet-4-6')
    expect(md).toContain('## Layer 2 — True to the sources')
    expect(md).toContain(DOCS_TRUTH_SCOPE)
    expect(md).toContain('It does not check that the sources are right')
    expect(md).toContain('The cold control has never read these documents.')
    expect(md).not.toContain('snippet = source')
    expect(md).not.toContain('code snippets')
    expect(readJson(path.join(run, 'proof-report.json')).mode).toBe('documents')
  })

  it('with affected: true, nothing runs until a document changes, then only the module citing it is proved', async () => {
    const { root, corpus } = documentsCourse()
    const { client, seen } = recordingClient()
    const events: ProveEvent[] = []
    const opts = { client, model: 'claude-sonnet-4-6', system: 'billing-notes', bundlePath: DOC_BUNDLE, repoPath: corpus, root, affected: true, onEvent: (e: ProveEvent) => events.push(e) }

    const untouched = await runProve(opts)
    expect(untouched).toMatchObject({ mode: 'documents', skipped: 'nothing-affected', modules: [], agents: [] })
    expect(seen).toHaveLength(0)
    expect(events.find((e) => e.type === 'skip')?.detail).toBe('no module cites a source document changed since the course was built')

    appendFileSync(path.join(corpus, 'scans/refund-policy.md'), '\nAmended on 2026-10-01.\n')
    const res = await runProve(opts)
    expect(res.modules).toEqual(['refunds'])
    expect(res.agents.map((a) => a.label).sort()).toEqual(['learn:cold:refunds', 'learn:taught:refunds', 'quizgen:refunds', 'verify:refunds'])
    expect(seen.every((p) => userOf(p).includes('refunds') && !userOf(p).includes('"invoice-cadence"'))).toBe(true)
  })

  it('passes `hidden` to the skeptic sandbox: a hidden document reads as not found', async () => {
    const { root, corpus } = documentsCourse()
    const { client } = recordingClient()
    const events: ProveEvent[] = []
    await runProve({ client, model: 'claude-sonnet-4-6', system: 'billing-notes', bundlePath: DOC_BUNDLE, repoPath: corpus, root, hidden: ['weekly'], onEvent: (e) => events.push(e) })
    const reads = events.filter((e) => e.type === 'tool').map((e) => e.detail ?? '')
    expect(reads).toHaveLength(2)
    expect(reads.filter((d) => d.includes('weekly/2026-09-15.md') && d.includes('error'))).toHaveLength(1)
    expect(reads.filter((d) => d.includes('scans/refund-policy.md') && !d.includes('error'))).toHaveLength(1)
  })
})

describe('runProve on a mixed course', () => {
  it('checks code first, hides the run output under .system-explainer/ by default, and splits Layer 1 into code and quotes', async () => {
    const repo = scratch('mixed')
    const notes = '.system-explainer/corpus/weekly.md'
    const raw = '.system-explainer/sources/weekly-raw.txt'
    const notesText = '# Weekly\n\n- The remit job runs nightly at 02:00 UTC, after the bank file lands.\n'
    writeFiles(repo, { 'src/remit.ts': 'export function runRemit(batch: Batch) {\n  return settle(batch)\n}\n', [notes]: notesText, [raw]: 'Raw export: the remit job runs nightly at 02:00 UTC, after the bank file lands.\n' })
    const root = path.join(repo, '.system-explainer')
    const bundle: any = {
      schemaVersion: '1.1.0',
      system: { id: 'remit', name: 'Remit', oneLiner: 'x' },
      actors: [],
      entities: [],
      modules: [
        {
          id: 'remit-job',
          title: 'Remit job',
          order: 1,
          objective: 'o',
          lessons: lesson('The job', [
            { type: 'prose', md: 'runRemit settles one batch.' },
            { type: 'code', language: 'ts', code: 'export function runRemit(batch: Batch) {\n  return settle(batch)\n}', sourcePath: 'src/remit.ts' },
            { type: 'quote', text: 'The remit job runs nightly at 02:00 UTC, after the bank file lands.', sourcePath: notes, cite: { title: 'Weekly', date: '2026-09-01' } },
          ]),
          quiz: [],
        },
        {
          // a course that cites the run's own raw download instead of the corpus: its skeptic must not be able to read it
          id: 'schedule',
          title: 'Schedule',
          order: 2,
          objective: 'o',
          lessons: lesson('When', [{ type: 'prose', md: 'It runs at 02:00 UTC.' }, { type: 'quote', text: 'the remit job runs nightly at 02:00 UTC, after the bank file lands.', sourcePath: raw, cite: { title: 'Raw' } }]),
          quiz: [],
        },
      ],
      provenance: { sources: [{ path: notes, sha256: sha256(notesText), title: 'Weekly', kind: 'markdown', date: '2026-09-01' }], corpus: { mode: 'mixed', docs: 1 } },
    }
    ground(bundle, repo, `remit@${'a'.repeat(40)}`)
    writeFiles(root, { 'bundles/remit/bundle.json': JSON.stringify(bundle) })
    const { client, seen } = recordingClient()
    const events: ProveEvent[] = []

    const res = await runProve({ client, model: 'claude-sonnet-4-6', system: 'remit', bundlePath: 'bundles/remit/bundle.json', repoPath: repo, root, onEvent: (e) => events.push(e) })

    expect(res.mode).toBe('mixed')
    expect(seen.every((p) => /^ROLE: \S+\nMODE: mixed\n/.test(systemOf(p)))).toBe(true)
    const skeptic = seen.find((p) => systemOf(p).startsWith('ROLE: skeptic\n') && p.messages.length === 1)!
    expect(systemOf(skeptic)).toContain('.system-explainer/corpus/')
    expect(userOf(skeptic)).toContain(SKEPTIC_DOCUMENT_RULES)
    expect(userOf(skeptic)).toContain(SKEPTIC_MIXED_RULE)
    const reads = events.filter((e) => e.type === 'tool').map((e) => e.detail ?? '')
    expect(reads.find((d) => d.includes('src/remit.ts'))).not.toContain('error')
    expect(reads.find((d) => d.includes(raw))).toContain('error')

    const md = readFileSync(res.reportPath!, 'utf8')
    expect(md).toContain(`Source of truth: the code at \`remit@${'a'.repeat(40)}\` plus 1 source document(s)`)
    expect(md).toContain('- `1/1` code snippets verified against source, **1 exact-verbatim**.')
    expect(md).toContain('- `2/2` quotes appear verbatim in their source documents')
    expect(md).toContain('## Layer 2 — True to the sources')
    expect(md).toContain(DOCS_TRUTH_SCOPE)
    expect(md).not.toContain('## Built without')
    expect(md).not.toContain('transcribed by a model')
    expect(md).not.toContain('The cold control has never read these documents.')
  })
})

describe('code mode and the workflow mirror', () => {
  it('code mode: every system prompt carries MODE: code on its second line', async () => {
    const root = engineRoot()
    const repoPath = placeholderRepo(readJson(ZUSTAND_BUNDLE))
    const { client, seen } = recordingClient()
    const res = await runProve({ client, model: 'claude-sonnet-4-6', system: 'zustand', bundlePath: BUNDLE_REL, repoPath, root, modules: ['vanilla-store'] })
    expect(res.mode).toBe('code')
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((p) => /^ROLE: \S+\nMODE: code\n/.test(systemOf(p)))).toBe(true)
  })

  it('proof.workflow.js carries the skeptic document rules verbatim, and they are ASCII', () => {
    const workflow = readFileSync(path.join(here, 'proof.workflow.js'), 'utf8')
    expect(workflow).toContain(SKEPTIC_DOCUMENT_RULES)
    expect(workflow).toContain(SKEPTIC_MIXED_RULE)
    expect(SKEPTIC_DOCUMENT_RULES + SKEPTIC_MIXED_RULE).toMatch(/^[\x20-\x7E\n]+$/)
  })
})
