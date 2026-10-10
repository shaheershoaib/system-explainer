/**
 * reverify — commit-scoped incremental re-verification (the staleness moat, operationalized).
 *
 *   npm run reverify -- --system <id> --bundle <bundle.json> --repo <repo-path> [--since <ref>] [--write]
 *
 * The bundle is pinned to a commit (provenance.grounding.repoRef = "name@sha"). This tool:
 *   1. diffs the repo from that pinned sha (or --since) to HEAD,
 *   2. maps changed files -> the modules whose code blocks cite them (sourcePath), so you know
 *      exactly WHICH modules a change touches — the re-author worklist is diff-scoped, never
 *      "regenerate the whole course",
 *   3. re-runs the full grounding gate against HEAD (local + fast) and, with --write, restamps
 *      the bundle (verified/lineRange per block + a fresh provenance.grounding @ new sha).
 *
 * A documents course (provenance.corpus.mode) has no history to diff: step 1 compares each corpus
 * document's bytes with the sha256 recorded in provenance.sources instead, and --repo is the corpus
 * directory. A mixed course does both and takes the union.
 *
 * Exit code: 0 = still fully verified; 1 = drift/missing-file found (re-author the listed
 * modules) or the diff could not be computed. Hook-friendly:
 *   echo 'npm --prefix <template> run reverify -- --system <id> --bundle bundles/<id>/bundle.json --repo . --write' >> .git/hooks/post-commit
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CourseMode } from './ingest/types'
import { applyGrounding, verifyGrounding, summarize, type FileReader } from './verify-grounding'
import { repoRefOf } from './repo-ref'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const arg = (n: string): string | undefined => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (n: string): boolean => process.argv.includes(`--${n}`)

/** git diff --name-only output -> a set of repo-relative paths. */
export function parseChangedFiles(diffOutput: string): Set<string> {
  return new Set(
    diffOutput
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  )
}

export interface AffectedModule {
  moduleId: string
  title: string
  /** the changed files this module cites */
  files: string[]
  /** how many of the module's code and quote blocks cite a changed file */
  blocks: number
}

/** Map changed files onto the modules whose code or quote blocks cite them. */
export function affectedModules(bundle: any, changed: Set<string>): AffectedModule[] {
  const out: AffectedModule[] = []
  for (const m of bundle.modules || []) {
    const hit = new Set<string>()
    let blocks = 0
    for (const l of m.lessons || [])
      for (const b of l.blocks || [])
        if ((b.type === 'code' || b.type === 'quote') && b.sourcePath && changed.has(b.sourcePath)) {
          hit.add(b.sourcePath)
          blocks++
        }
    if (hit.size) out.push({ moduleId: m.id, title: m.title, files: [...hit].sort(), blocks })
  }
  return out
}

/** Repo-relative paths changed between `base` and HEAD (git diff --name-only). Throws when the diff cannot be computed. */
export function changedFilesSince(repo: string, base: string): Set<string> {
  return parseChangedFiles(execFileSync('git', ['-C', repo, 'diff', '--name-only', base, 'HEAD'], { encoding: 'utf8' }))
}

/** "name@sha" -> sha (the bundle's pinned verification commit). */
export function pinnedSha(bundle: any): string | undefined {
  const ref: string | undefined = bundle?.provenance?.grounding?.repoRef
  const sha = ref?.split('@')[1]
  return sha && sha.length >= 7 ? sha : undefined
}

/** The course's mode as recorded on the bundle; a bundle without a corpus summary is a code course. */
export function courseModeOf(bundle: any): CourseMode {
  return bundle?.provenance?.corpus?.mode ?? 'code'
}

const SHA256 = /^[0-9a-f]{64}$/
const sha256Of = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

/**
 * Grounding-root-relative paths of the corpus documents whose bytes no longer match the sha256
 * recorded at course time, or that are gone. Only full 64-hex hashes are corpus records: the legacy
 * knowledge-base provenance carries a 16-char prefix of a file outside the course and is skipped.
 */
export function changedCorpusDocs(bundle: any, root: string): Set<string> {
  const out = new Set<string>()
  for (const s of bundle?.provenance?.sources ?? []) {
    if (typeof s?.sha256 !== 'string' || !SHA256.test(s.sha256)) continue
    const file = path.join(root, s.path)
    if (!existsSync(file) || sha256Of(file) !== s.sha256) out.add(s.path)
  }
  return out
}

export interface ReverifyOptions {
  system: string
  bundlePath: string
  /** The grounding root: the repo (code, mixed) or the corpus directory (documents). */
  repo: string
  /** Diff base; defaults to the bundle's pinned sha. Ignored for a documents course. */
  since?: string
  /** Restamp the bundle (and the active public copy) at HEAD. */
  write?: boolean
  /** Engine dir the bundle path is resolved against (default: this package). */
  root?: string
}

export interface ReverifyResult {
  mode: CourseMode
  /** code and mixed: the diff base sha; documents: the bundle's corpus repoRef */
  base: string
  /** files (code) or documents (corpus) that changed, deduplicated across both in mixed mode */
  changed: number
  /** documents and mixed: how many of `changed` are corpus documents changed or gone since the course was built */
  changedDocs?: number
  affected: AffectedModule[]
  summary: ReturnType<typeof summarize>
  bad: { status: string; moduleId: string; sourcePath?: string }[]
  restamped?: string
}

/** The free half of the proof loop: diff since the pinned sha -> affected modules -> grounding gate at HEAD. Throws when the diff cannot be scoped. */
export function reverify(o: ReverifyOptions): ReverifyResult {
  const base_ = o.root ?? root
  const absBundle = path.resolve(base_, o.bundlePath)
  const bundle = JSON.parse(readFileSync(absBundle, 'utf8'))
  const mode = courseModeOf(bundle)
  const docs = mode === 'code' ? new Set<string>() : changedCorpusDocs(bundle, o.repo)

  // 1) the diff since the verified commit; documents have no history, so their recorded hashes stand in for it
  let base: string
  let changed: Set<string>
  if (mode === 'documents') {
    base = bundle.provenance?.grounding?.repoRef ?? 'corpus'
    changed = docs
  } else {
    const sha = o.since || pinnedSha(bundle)
    if (!sha) throw new Error('no pinned sha on the bundle (provenance.grounding.repoRef) and no --since given; cannot scope the diff')
    base = sha
    try {
      changed = changedFilesSince(o.repo, base)
    } catch (e: any) {
      throw new Error(`git diff ${base}..HEAD failed in ${o.repo} (shallow clone or unknown ref?); pass --since <ref>\n  ${e.message}`)
    }
    if (mode === 'mixed') changed = new Set([...changed, ...docs])
  }

  // 2) diff -> affected modules (the scoped re-author worklist)
  const affected = affectedModules(bundle, changed)

  // 3) re-run the authoritative grounding gate against HEAD
  const read: FileReader = (sp) => {
    const fp = path.join(o.repo, sp)
    return existsSync(fp) ? readFileSync(fp, 'utf8') : null
  }
  const results = verifyGrounding(bundle, read)
  applyGrounding(bundle, results)
  const s = summarize(results)
  const bad = results
    .filter((r) => r.status === 'drifted' || r.status === 'missing-file')
    .map((r) => ({ status: r.status, moduleId: r.ref.moduleId, sourcePath: r.ref.sourcePath }))

  // 4) restamp + write (opt-in, so a dry run never mutates)
  let restamped: string | undefined
  if (o.write) {
    // The documents' new bytes become the baseline, as HEAD does for code; a vanished document keeps its old hash so it stays reported.
    const sources = (bundle.provenance?.sources ?? []).map((src: any) =>
      docs.has(src.path) && existsSync(path.join(o.repo, src.path)) ? { ...src, sha256: sha256Of(path.join(o.repo, src.path)) } : src,
    )
    bundle.provenance = {
      ...(bundle.provenance ?? { sources: [] }),
      ...(docs.size ? { sources } : {}),
      grounding: { repoRef: mode === 'documents' ? base : repoRefOf(o.repo), verifiedAt: new Date().toISOString(), total: s.total, verified: s.verified, partial: s.partial, drifted: s.drifted, missingFile: s.missingFile, exact: s.exact },
    }
    writeFileSync(absBundle, JSON.stringify(bundle, null, 2))
    const pub = path.join(base_, 'public', 'bundle.json')
    if (existsSync(pub)) {
      const active = JSON.parse(readFileSync(pub, 'utf8'))
      if (active?.system?.id === bundle?.system?.id) writeFileSync(pub, JSON.stringify(bundle, null, 2))
    }
    restamped = bundle.provenance.grounding.repoRef
  }
  return { mode, base, changed: changed.size, ...(mode === 'code' ? {} : { changedDocs: docs.size }), affected, summary: s, bad, restamped }
}

/** Console rendering shared by `npm run reverify` and the `system-explainer reverify` command. */
export function printReverify(system: string, bundlePath: string, r: ReverifyResult, write: boolean) {
  const docs = r.mode === 'documents'
  const docsLine = `${r.changedDocs ?? 0} source document(s) changed since the course was built`
  if (docs) console.log(`reverify ${system}: ${docsLine}`)
  else if (r.mode === 'mixed') console.log(`reverify ${system}: ${r.changed - (r.changedDocs ?? 0)} file(s) changed since ${r.base.slice(0, 7)}, ${docsLine}`)
  else console.log(`reverify ${system}: ${r.changed} file(s) changed since ${r.base.slice(0, 7)}`)
  if (r.affected.length) {
    console.log(`  ${r.affected.length} module(s) cite changed ${docs ? 'source documents' : 'files'}:`)
    for (const a of r.affected) console.log(`   • ${a.moduleId} ("${a.title}") — ${a.blocks} block(s): ${a.files.join(', ')}`)
  } else {
    console.log(docs ? '  no module cites a changed source document: course content untouched' : '  no module cites a changed file — course content untouched by this diff')
  }
  const s = r.summary
  console.log(`  grounding @ ${docs ? 'current documents' : 'HEAD'}: ${s.verified}/${s.total} verified, ${s.exact} exact${s.drifted ? `, ${s.drifted} DRIFTED ⚠` : ''}${s.missingFile ? `, ${s.missingFile} missing-file ⚠` : ''}`)
  for (const b of r.bad) console.log(`   ⚠ ${b.status}: module ${b.moduleId} · ${b.sourcePath} — re-author this block`)
  if (write) console.log(`  ✓ restamped ${bundlePath} @ ${r.restamped}`)
  else console.log(`  (dry run — pass --write to restamp the bundle at ${docs ? 'the current documents' : 'HEAD'})`)
}

function main() {
  const system = arg('system')
  const bundlePath = arg('bundle')
  const repo = arg('repo')
  if (!system || !bundlePath || !repo) {
    console.error('Usage: npm run reverify -- --system <id> --bundle <bundle.json> --repo <repo-path> [--since <ref>] [--write]')
    process.exit(1)
  }
  let r: ReverifyResult
  try {
    r = reverify({ system, bundlePath, repo, since: arg('since'), write: flag('write') })
  } catch (e: any) {
    console.error(`✗ ${e.message}`)
    process.exit(1)
  }
  printReverify(system, path.relative(root, path.resolve(root, bundlePath)), r, flag('write'))
  process.exit(r.bad.length ? 1 : 0)
}

// Only run the CLI when executed directly (not when imported by the test).
const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) main()
