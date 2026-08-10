/**
 * Assemble a validated, grounded OnboardingBundle from the autonomous loop's output.
 *
 *   npm run assemble -- --dir <workDir> --system <id> [--repo <repo-path>] [--out <dir>]   (disk-bus, preferred)
 *   npm run assemble -- --in <loop-output.json> --system <id> [--repo <repo-path>]          (legacy single-JSON)
 *
 * The `auto-course` workflow writes plan.json + datamodel.json + modules/<id>.json to a work
 * directory (the disk-bus — content never routes through the orchestrator's context). This
 * deterministic back half reads those files (or the legacy combined JSON), maps DraftModules
 * to the engine's bundle contract, re-runs the REAL grounding gate against the repo
 * (authoritative, independent of the loop), validates, and writes bundles/<system>/bundle.json
 * + public/bundle.json. It is the product's second half: orchestrated authoring (the loop) →
 * deterministic, verified assembly.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateBundle } from './validate'
import { verifyGrounding, summarize, type FileReader } from './verify-grounding'
import { BUNDLE_SCHEMA_VERSION, type Block, type Entity, type Module, type OnboardingBundle, type QuizItem } from '../schema/bundle'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const arg = (n: string): string | undefined => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const OPT_IDS = ['a', 'b', 'c', 'd', 'e']

/** Map the loop's DraftModule JSON onto the engine's bundle contract (deterministic). */
function buildBundle(out: any, systemId: string): OnboardingBundle {
  const sys = out.system || {}

  // entities = canonical data model (with relationships → ER) + supplementary module concepts
  const entityMap = new Map<string, Entity>()
  for (const e of out.dataModel?.entities || [])
    if (e && e.id && !entityMap.has(e.id))
      entityMap.set(e.id, {
        id: e.id,
        name: e.name || e.id,
        definition: e.definition || '',
        relationships: (e.relationships || []).filter((r: any) => r && r.to && r.cardinality),
      } as Entity)
  for (const m of out.modules || [])
    for (const c of m.concepts || [])
      if (c && c.id && !entityMap.has(c.id)) entityMap.set(c.id, { id: c.id, name: c.name || c.id, definition: c.definition || '' })
  const entities = [...entityMap.values()]
  // prune relationship edges whose target isn't a known entity (or is a self-loop)
  for (const e of entities)
    if (e.relationships) e.relationships = e.relationships.filter((r) => entityMap.has(r.to) && r.to !== e.id)
  const dataModelIds = (out.dataModel?.entities || []).map((e: any) => e.id).filter((id: string) => entityMap.has(id))

  const draftModules: any[] = out.modules || []
  const modules: Module[] = draftModules.map((m, mi) => {
    const lessons = (m.lessons || []).map((l: any, li: number) => {
      const blocks: Block[] = []
      if (l.prose) blocks.push({ type: 'prose', md: String(l.prose) })
      for (const c of l.code || [])
        if (c && c.snippet) blocks.push({ type: 'code', language: c.language || 'text', code: c.snippet, caption: c.caption, sourcePath: c.sourcePath })
      if (l.callout && l.callout.md) blocks.push({ type: 'callout', variant: l.callout.variant || 'note', md: l.callout.md })
      if (!blocks.length) blocks.push({ type: 'prose', md: l.title || '…' })
      return { id: `${m.id}-l${li + 1}`, title: l.title || `Lesson ${li + 1}`, blocks }
    })
    if (!lessons.length) lessons.push({ id: `${m.id}-l1`, title: m.title, blocks: [{ type: 'prose' as const, md: m.objective || '…' }] })

    const quiz: QuizItem[] = []
    ;(m.quiz || []).forEach((q: any, qi: number) => {
      const opts = (q.options || []).filter((o: any) => o && o.text)
      if (opts.length < 2 || !opts.some((o: any) => o.correct)) return // skip malformed
      const options = opts.slice(0, 5).map((o: any, oi: number) => ({ id: OPT_IDS[oi], text: String(o.text), correct: !!o.correct, ifChosen: o.ifChosen }))
      const item: any = { id: `${m.id}-q${qi + 1}`, type: 'mcq', prompt: q.prompt || '', options, explanation: q.explanation || '', difficulty: 'core' }
      if (q.misconception && q.misconception.trap)
        item.misconception = { id: `${m.id}-mc${qi + 1}`, trap: q.misconception.trap, correction: q.misconception.correction || '' }
      quiz.push(item)
    })

    const conceptIds = (m.concepts || []).map((c: any) => c.id).filter((id: string) => entityMap.has(id))
    const mod: any = {
      id: m.id,
      title: m.title,
      order: mi + 1,
      objective: m.objective || '',
      oneJob: m.oneJob,
      estMinutes: Math.min(22, 8 + lessons.length * 3 + quiz.length),
      entitiesIntroduced: conceptIds,
      lessons,
      quiz,
    }
    if (mi > 0) mod.prerequisites = [draftModules[mi - 1].id]
    if (draftModules.length > 1 && mi === draftModules.length - 1) mod.capstone = true
    return mod as Module
  })

  // System-level ER diagram from the canonical data model, as an orientation lesson on module 1.
  const hasRels = entities.some((e) => Array.isArray(e.relationships) && e.relationships.length > 0)
  if (modules.length && dataModelIds.length >= 2 && hasRels) {
    ;(modules[0].lessons as any[]).unshift({
      id: `${modules[0].id}-datamodel`,
      title: 'The data model at a glance',
      blocks: [
        { type: 'prose', md: 'Before the features, here are the core entities these flows operate on and how they relate.' },
        { type: 'diagram', diagram: { kind: 'er', title: 'Data model', scope: dataModelIds } },
      ],
    })
  }

  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    system: {
      id: systemId,
      name: sys.name || systemId,
      oneLiner: sys.oneLiner || '',
      elevatorPitch: sys.elevatorPitch,
      outOfScope: sys.outOfScope,
      depth: sys.depth || 'L3',
      audience: sys.audience || 'developer',
      repoUrl: sys.repoUrl,
    },
    actors: [],
    entities,
    modules,
    glossary: entities.map((e) => ({ term: e.name, definition: e.definition })),
    theme: { accent: '#16a34a' },
  } as OnboardingBundle
}

/** Best-effort "name@shortsha" for the verified-against badge. */
function repoRef(repo: string): string {
  const name = path.basename(repo)
  try {
    const head = readFileSync(path.join(repo, '.git', 'HEAD'), 'utf8').trim()
    const m = head.match(/^ref:\s*(.+)$/)
    const sha = m ? readFileSync(path.join(repo, '.git', m[1]), 'utf8').trim() : head
    return `${name}@${sha.slice(0, 7)}`
  } catch {
    return name
  }
}

/** First meaningful line of the source repo's LICENSE — embedded verbatim snippets must carry the notice. */
function sourceLicenseOf(read: FileReader): string | undefined {
  for (const f of ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'LICENSE.rst', 'COPYING']) {
    const text = read(f)
    if (!text) continue
    const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
    if (line) return line.slice(0, 120)
  }
  return undefined
}

/** Read a disk-bus work directory (plan.json + datamodel.json + modules/*.json) into the
 *  same { system, dataModel, modules } shape the legacy combined JSON used. Module order
 *  follows plan.json's domain order; unparseable module files fail LOUDLY (never skipped
 *  silently — a corrupt agent write must not shrink the course unnoticed). */
export function readWorkDir(dir: string): any {
  const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'))
  const plan = existsSync(path.join(dir, 'plan.json')) ? readJson(path.join(dir, 'plan.json')) : {}
  const dataModel = existsSync(path.join(dir, 'datamodel.json')) ? readJson(path.join(dir, 'datamodel.json')) : { entities: [] }
  const modDir = path.join(dir, 'modules')
  if (!existsSync(modDir)) throw new Error(`no modules/ under ${dir} — did the loop finish?`)
  const files = readdirSync(modDir).filter((f) => f.endsWith('.json'))
  if (!files.length) throw new Error(`modules/ is empty under ${dir}`)
  const byId = new Map<string, any>()
  const broken: string[] = []
  for (const f of files) {
    try {
      const m = readJson(path.join(modDir, f))
      if (!m || !m.id) throw new Error('missing id')
      byId.set(m.id, m)
    } catch (e: any) {
      broken.push(`${f}: ${e.message}`)
    }
  }
  if (broken.length) throw new Error(`unparseable module file(s) — fix or re-run their author/verify agents:\n  ${broken.join('\n  ')}`)
  // plan.json's domain order is the course order; unplanned modules (critic additions) follow alphabetically
  const planned: string[] = (plan.domains || []).map((d: any) => d.id).filter((id: string) => byId.has(id))
  const extras = [...byId.keys()].filter((id) => !planned.includes(id)).sort()
  const modules = [...planned, ...extras].map((id) => byId.get(id))
  return {
    system: {
      name: plan.systemName,
      oneLiner: plan.oneLiner,
      elevatorPitch: plan.elevatorPitch,
      outOfScope: plan.outOfScope || [],
      audience: plan.audience,
      depth: plan.depth,
      repoUrl: plan.repoUrl || undefined,
    },
    dataModel,
    modules,
  }
}

async function main() {
  const inPath = arg('in')
  const dirPath = arg('dir')
  const system = arg('system')
  const repo = arg('repo')
  if ((!inPath && !dirPath) || !system) {
    console.error('Usage: npm run assemble -- (--dir <workDir> | --in <loop-output.json>) --system <id> [--repo <repo-path>] [--out <dir>]')
    process.exit(1)
  }
  const out = dirPath ? readWorkDir(path.resolve(dirPath)) : JSON.parse(readFileSync(inPath!, 'utf8'))
  const bundle: any = buildBundle(out, system)
  bundle.generatedAt = new Date().toISOString()

  // — Grounding gate: the authoritative snippet-vs-source check (independent of the loop) —
  let groundingLine = ''
  if (repo) {
    if (!existsSync(repo)) {
      console.error(`✗ --repo not found: ${repo}`)
      process.exit(1)
    }
    const read: FileReader = (sp) => {
      const fp = path.join(repo, sp)
      return existsSync(fp) ? readFileSync(fp, 'utf8') : null
    }
    const results = verifyGrounding(bundle, read)
    for (const r of results) {
      const lesson = bundle.modules.find((x: any) => x.id === r.ref.moduleId)?.lessons.find((l: any) => l.id === r.ref.lessonId)
      const blk = lesson?.blocks[r.ref.blockIndex]
      if (blk && blk.type === 'code') {
        blk.verified = r.status
        if (r.lineRange) blk.lineRange = r.lineRange // exact matches deep-link to #L<start>-L<end>
      }
    }
    const s = summarize(results)
    bundle.provenance = {
      sources: [],
      grounding: { repoRef: repoRef(repo), verifiedAt: new Date().toISOString(), total: s.total, verified: s.verified, partial: s.partial, drifted: s.drifted, missingFile: s.missingFile, exact: s.exact },
      sourceLicense: sourceLicenseOf(read),
    }
    groundingLine =
      `  grounding: ${s.verified}/${s.total} verified` +
      (s.exact ? `, ${s.exact} exact-verbatim` : '') +
      (s.partial ? `, ${s.partial} partial` : '') +
      (s.drifted ? `, ${s.drifted} DRIFTED ⚠` : '') +
      (s.missingFile ? `, ${s.missingFile} missing-file ⚠` : '') +
      (s.noSource ? `, ${s.noSource} ungrounded` : '')
  }

  const result = validateBundle(bundle)
  if (!result.ok) {
    console.error(`✗ assembled bundle failed validation (${result.errors.length}):`)
    for (const e of result.errors) console.error('   • ' + e)
    process.exit(1)
  }

  const outDir = path.join(root, 'bundles', system)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, 'bundle.json'), JSON.stringify(result.bundle, null, 2))
  const pub = path.join(root, 'public')
  mkdirSync(pub, { recursive: true })
  writeFileSync(path.join(pub, 'bundle.json'), JSON.stringify(result.bundle, null, 2))

  // Workspace output — the canonical copy for the USER'S project, outside this engine dir
  // (the engine install stays replaceable; bundles/ + public/ act as serving caches).
  const workspaceOut = arg('out')
  if (workspaceOut) {
    const wsDir = path.resolve(workspaceOut)
    mkdirSync(wsDir, { recursive: true })
    writeFileSync(path.join(wsDir, 'bundle.json'), JSON.stringify(result.bundle, null, 2))
  }

  const b = result.bundle
  const quizCount = b.modules.reduce((n, m) => n + m.quiz.length, 0)
  console.log(`✓ assembled ${b.system.name}  (${b.system.audience ?? 'developer'} · ${b.system.depth ?? 'depth n/a'})`)
  console.log(`  ${b.modules.length} module(s) · ${b.entities.length} entit(ies) · ${quizCount} quiz item(s)`)
  if (groundingLine) console.log(groundingLine)
  console.log(`  → ${path.relative(root, path.join(outDir, 'bundle.json'))}`)
}

// Only run the CLI when executed directly (not when imported by the test).
const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain)
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
