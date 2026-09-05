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
 * Exit code: 0 = still fully verified; 1 = drift/missing-file found (re-author the listed
 * modules) or the diff could not be computed. Hook-friendly:
 *   echo 'npm --prefix <template> run reverify -- --system <id> --bundle bundles/<id>/bundle.json --repo . --write' >> .git/hooks/post-commit
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyGrounding, summarize, type FileReader } from './verify-grounding'
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
  /** how many of the module's code blocks cite a changed file */
  blocks: number
}

/** Map changed files onto the modules whose code blocks cite them. */
export function affectedModules(bundle: any, changed: Set<string>): AffectedModule[] {
  const out: AffectedModule[] = []
  for (const m of bundle.modules || []) {
    const hit = new Set<string>()
    let blocks = 0
    for (const l of m.lessons || [])
      for (const b of l.blocks || [])
        if (b.type === 'code' && b.sourcePath && changed.has(b.sourcePath)) {
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


export interface ReverifyOptions {
  system: string
  bundlePath: string
  repo: string
  /** Diff base; defaults to the bundle's pinned sha. */
  since?: string
  /** Restamp the bundle (and the active public copy) at HEAD. */
  write?: boolean
  /** Engine dir the bundle path is resolved against (default: this package). */
  root?: string
}

export interface ReverifyResult {
  base: string
  changed: number
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
  const base = o.since || pinnedSha(bundle)
  if (!base) throw new Error('no pinned sha on the bundle (provenance.grounding.repoRef) and no --since given; cannot scope the diff')

  // 1) the diff since the verified commit
  let changed: Set<string>
  try {
    changed = changedFilesSince(o.repo, base)
  } catch (e: any) {
    throw new Error(`git diff ${base}..HEAD failed in ${o.repo} (shallow clone or unknown ref?); pass --since <ref>\n  ${e.message}`)
  }

  // 2) diff -> affected modules (the scoped re-author worklist)
  const affected = affectedModules(bundle, changed)

  // 3) re-run the authoritative grounding gate against HEAD
  const read: FileReader = (sp) => {
    const fp = path.join(o.repo, sp)
    return existsSync(fp) ? readFileSync(fp, 'utf8') : null
  }
  const results = verifyGrounding(bundle, read)
  for (const r of results) {
    const lesson = bundle.modules.find((x: any) => x.id === r.ref.moduleId)?.lessons.find((l: any) => l.id === r.ref.lessonId)
    const blk = lesson?.blocks[r.ref.blockIndex]
    if (blk && blk.type === 'code') {
      blk.verified = r.status
      if (r.lineRange) blk.lineRange = r.lineRange
      else if (!r.exact) delete blk.lineRange // stale line anchors must not survive a drifted re-verify
    }
  }
  const s = summarize(results)
  const bad = results
    .filter((r) => r.status === 'drifted' || r.status === 'missing-file')
    .map((r) => ({ status: r.status, moduleId: r.ref.moduleId, sourcePath: r.ref.sourcePath }))

  // 4) restamp + write (opt-in, so a dry run never mutates)
  let restamped: string | undefined
  if (o.write) {
    bundle.provenance = {
      ...(bundle.provenance ?? { sources: [] }),
      grounding: { repoRef: repoRefOf(o.repo), verifiedAt: new Date().toISOString(), total: s.total, verified: s.verified, partial: s.partial, drifted: s.drifted, missingFile: s.missingFile, exact: s.exact },
    }
    writeFileSync(absBundle, JSON.stringify(bundle, null, 2))
    const pub = path.join(base_, 'public', 'bundle.json')
    if (existsSync(pub)) {
      const active = JSON.parse(readFileSync(pub, 'utf8'))
      if (active?.system?.id === bundle?.system?.id) writeFileSync(pub, JSON.stringify(bundle, null, 2))
    }
    restamped = bundle.provenance.grounding.repoRef
  }
  return { base, changed: changed.size, affected, summary: s, bad, restamped }
}

/** Console rendering shared by `npm run reverify` and the `system-explainer reverify` command. */
export function printReverify(system: string, bundlePath: string, r: ReverifyResult, write: boolean) {
  console.log(`reverify ${system}: ${r.changed} file(s) changed since ${r.base.slice(0, 7)}`)
  if (r.affected.length) {
    console.log(`  ${r.affected.length} module(s) cite changed files:`)
    for (const a of r.affected) console.log(`   • ${a.moduleId} ("${a.title}") — ${a.blocks} block(s): ${a.files.join(', ')}`)
  } else {
    console.log('  no module cites a changed file — course content untouched by this diff')
  }
  const s = r.summary
  console.log(`  grounding @ HEAD: ${s.verified}/${s.total} verified, ${s.exact} exact${s.drifted ? `, ${s.drifted} DRIFTED ⚠` : ''}${s.missingFile ? `, ${s.missingFile} missing-file ⚠` : ''}`)
  for (const b of r.bad) console.log(`   ⚠ ${b.status}: module ${b.moduleId} · ${b.sourcePath} — re-author this block`)
  if (write) console.log(`  ✓ restamped ${bundlePath} @ ${r.restamped}`)
  else console.log('  (dry run — pass --write to restamp the bundle at HEAD)')
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
