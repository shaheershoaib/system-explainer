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

/** "name@sha" -> sha (the bundle's pinned verification commit). */
export function pinnedSha(bundle: any): string | undefined {
  const ref: string | undefined = bundle?.provenance?.grounding?.repoRef
  const sha = ref?.split('@')[1]
  return sha && sha.length >= 7 ? sha : undefined
}

function repoRefOf(repo: string): string {
  const name = path.basename(repo)
  try {
    const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    return `${name}@${sha.slice(0, 7)}`
  } catch {
    return name
  }
}

function main() {
  const system = arg('system')
  const bundlePath = arg('bundle')
  const repo = arg('repo')
  if (!system || !bundlePath || !repo) {
    console.error('Usage: npm run reverify -- --system <id> --bundle <bundle.json> --repo <repo-path> [--since <ref>] [--write]')
    process.exit(1)
  }
  const absBundle = path.resolve(root, bundlePath)
  const bundle = JSON.parse(readFileSync(absBundle, 'utf8'))
  const base = arg('since') || pinnedSha(bundle)
  if (!base) {
    console.error('✗ no pinned sha on the bundle (provenance.grounding.repoRef) and no --since given — cannot scope the diff')
    process.exit(1)
  }

  // 1) the diff since the verified commit
  let changed: Set<string>
  try {
    changed = parseChangedFiles(execFileSync('git', ['-C', repo, 'diff', '--name-only', base, 'HEAD'], { encoding: 'utf8' }))
  } catch (e: any) {
    console.error(`✗ git diff ${base}..HEAD failed in ${repo} (shallow clone or unknown ref?) — pass --since <ref>\n  ${e.message}`)
    process.exit(1)
  }

  // 2) diff -> affected modules (the scoped re-author worklist)
  const affected = affectedModules(bundle, changed)
  console.log(`reverify ${system}: ${changed.size} file(s) changed since ${base.slice(0, 7)}`)
  if (affected.length) {
    console.log(`  ${affected.length} module(s) cite changed files:`)
    for (const a of affected) console.log(`   • ${a.moduleId} ("${a.title}") — ${a.blocks} block(s): ${a.files.join(', ')}`)
  } else {
    console.log('  no module cites a changed file — course content untouched by this diff')
  }

  // 3) re-run the authoritative grounding gate against HEAD
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
      if (r.lineRange) blk.lineRange = r.lineRange
      else if (!r.exact) delete blk.lineRange // stale line anchors must not survive a drifted re-verify
    }
  }
  const s = summarize(results)
  const bad = results.filter((r) => r.status === 'drifted' || r.status === 'missing-file')
  console.log(`  grounding @ HEAD: ${s.verified}/${s.total} verified, ${s.exact} exact${s.drifted ? `, ${s.drifted} DRIFTED ⚠` : ''}${s.missingFile ? `, ${s.missingFile} missing-file ⚠` : ''}`)
  for (const r of bad) console.log(`   ⚠ ${r.status}: module ${r.ref.moduleId} · ${r.ref.sourcePath} — re-author this block`)

  // 4) restamp + write (opt-in, so a dry run never mutates)
  if (flag('write')) {
    bundle.provenance = {
      ...(bundle.provenance ?? { sources: [] }),
      grounding: { repoRef: repoRefOf(repo), verifiedAt: new Date().toISOString(), total: s.total, verified: s.verified, partial: s.partial, drifted: s.drifted, missingFile: s.missingFile, exact: s.exact },
    }
    writeFileSync(absBundle, JSON.stringify(bundle, null, 2))
    const pub = path.join(root, 'public', 'bundle.json')
    if (existsSync(pub)) {
      const active = JSON.parse(readFileSync(pub, 'utf8'))
      if (active?.system?.id === bundle?.system?.id) writeFileSync(pub, JSON.stringify(bundle, null, 2))
    }
    console.log(`  ✓ restamped ${path.relative(root, absBundle)} @ ${bundle.provenance.grounding.repoRef}`)
  } else {
    console.log('  (dry run — pass --write to restamp the bundle at HEAD)')
  }

  process.exit(bad.length ? 1 : 0)
}

// Only run the CLI when executed directly (not when imported by the test).
const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) main()
