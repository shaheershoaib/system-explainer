/**
 * Bundle assembler CLI.  `npm run generate -- --system <name> [--kb <dir>]`
 *
 * Reads the Claude-authored content module (generator/authored/<system>.ts),
 * stamps generatedAt + provenance hashes, VALIDATES (refuses to emit on failure),
 * and writes bundles/<system>/bundle.json — the artifact the SPA loads.
 *
 * The authoring of <system>.ts is the build-time, Claude-in-the-loop step described
 * in the system-explainer "Onboarding App Generation" phase. This CLI is the
 * deterministic guard rail around it.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync, statSync, cpSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateBundle } from './validate'
import { verifyGrounding, summarize, collectOpenQuestions, type FileReader } from './verify-grounding'
import { BUNDLE_SCHEMA_VERSION, type OnboardingBundle, type Provenance } from '../schema/bundle'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function buildProvenance(kbDir?: string): Provenance | undefined {
  if (!kbDir || !existsSync(kbDir)) return undefined
  const candidates = ['one-job.md', 'actors.md', 'entities.md', 'verbs.md', 'gotchas.md', 'learning-log.md']
  const sources = candidates
    .map((f) => path.join(kbDir, f))
    .filter((p) => existsSync(p))
    .map((p) => ({
      path: p,
      sha256: createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16),
      lastModified: statSync(p).mtime.toISOString(),
    }))
  return sources.length ? { sources, generatorVersion: BUNDLE_SCHEMA_VERSION } : undefined
}

/** Best-effort "name@shortsha" for the verified-against badge; falls back to the dir name. */
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

async function main() {
  const system = arg('system')
  if (!system) {
    console.error('Usage: npm run generate -- --system <name> [--kb <knowledge-base-dir>]')
    process.exit(1)
  }

  const authoredPath = path.join(here, 'authored', `${system}.ts`)
  if (!existsSync(authoredPath)) {
    console.error(`✗ No authored content at ${path.relative(root, authoredPath)}`)
    console.error('  Author it first (system-explainer "Onboarding App Generation" phase).')
    process.exit(1)
  }

  const mod = await import(pathToFileURL(authoredPath).href)
  const authored: OnboardingBundle | undefined = mod.default ?? mod.bundle
  if (!authored) {
    console.error(`✗ ${path.relative(root, authoredPath)} must \`export default\` an OnboardingBundle.`)
    process.exit(1)
  }

  const stamped: OnboardingBundle = {
    ...authored,
    schemaVersion: authored.schemaVersion || BUNDLE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    provenance: authored.provenance ?? buildProvenance(arg('kb')),
  }

  // — Grounding verification (the trust gate): diff every cited snippet against the real repo —
  let groundingLine = ''
  const repo = arg('repo')
  if (repo) {
    if (!existsSync(repo)) {
      console.error(`✗ --repo path does not exist: ${repo}`)
      process.exit(1)
    }
    const read: FileReader = (sp) => {
      const fp = path.join(repo, sp)
      return existsSync(fp) ? readFileSync(fp, 'utf8') : null
    }
    const results = verifyGrounding(stamped, read)
    for (const r of results) {
      const lesson = stamped.modules.find((x) => x.id === r.ref.moduleId)?.lessons.find((l) => l.id === r.ref.lessonId)
      const blk = lesson?.blocks[r.ref.blockIndex]
      if (blk?.type === 'code') {
        blk.verified = r.status
        if (r.lineRange) blk.lineRange = r.lineRange // exact matches deep-link to #L<start>-L<end>
      }
    }
    const s = summarize(results)
    stamped.provenance = {
      ...(stamped.provenance ?? { sources: [] }),
      grounding: {
        repoRef: repoRef(repo),
        verifiedAt: new Date().toISOString(),
        total: s.total, verified: s.verified, partial: s.partial, drifted: s.drifted, missingFile: s.missingFile, exact: s.exact,
      },
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

  // — Review pass: surface SME open questions; stamp the human-reviewed badge when asserted —
  const reviewedBy = arg('reviewed-by')
  const openQuestions = collectOpenQuestions(stamped)
  if (openQuestions.length || reviewedBy) {
    stamped.provenance = {
      ...(stamped.provenance ?? { sources: [] }),
      review: { ...(reviewedBy ? { reviewedBy, reviewedAt: new Date().toISOString() } : {}), openQuestions },
    }
  }

  const result = validateBundle(stamped)
  if (!result.ok) {
    console.error(`✗ Bundle for "${system}" failed validation (${result.errors.length} error(s)):`)
    for (const e of result.errors) console.error(`   • ${e}`)
    process.exit(1)
  }

  const outDir = path.join(root, 'bundles', system)
  mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, 'bundle.json')
  writeFileSync(outPath, JSON.stringify(result.bundle, null, 2))

  // Publish as the "active" bundle the dev server / this deployment serves at /bundle.json.
  const publicDir = path.join(root, 'public')
  mkdirSync(publicDir, { recursive: true })
  writeFileSync(path.join(publicDir, 'bundle.json'), JSON.stringify(result.bundle, null, 2))

  // Copy authored assets (captured screenshots, etc.) so both the dev server and the
  // archived bundle serve them at /assets/...
  const assetsSrc = path.join(here, 'authored', system, 'assets')
  if (existsSync(assetsSrc)) {
    for (const dest of [path.join(publicDir, 'assets'), path.join(outDir, 'assets')]) {
      mkdirSync(dest, { recursive: true })
      cpSync(assetsSrc, dest, { recursive: true })
    }
  }

  // Workspace output — the canonical copy for the USER'S project, outside this engine dir.
  // The engine install stays replaceable (plugin-safe); bundles/ + public/ act as serving caches.
  const workspaceOut = arg('out')
  if (workspaceOut) {
    const wsDir = path.resolve(workspaceOut)
    mkdirSync(wsDir, { recursive: true })
    writeFileSync(path.join(wsDir, 'bundle.json'), JSON.stringify(result.bundle, null, 2))
    if (existsSync(assetsSrc)) {
      mkdirSync(path.join(wsDir, 'assets'), { recursive: true })
      cpSync(assetsSrc, path.join(wsDir, 'assets'), { recursive: true })
    }
  }

  const b = result.bundle
  const quizCount = b.modules.reduce((n, m) => n + m.quiz.length, 0)
  console.log(`✓ ${b.system.name}  (${b.system.audience ?? 'developer'} · ${b.system.depth ?? 'depth n/a'})`)
  console.log(`  ${b.modules.length} module(s) · ${b.entities.length} entit(ies) · ${b.actors.length} actor(s) · ${quizCount} quiz item(s)`)
  if (groundingLine) console.log(groundingLine)
  if (b.provenance?.review?.reviewedBy) console.log(`  reviewed by ${b.provenance.review.reviewedBy}`)
  else if (b.provenance?.review?.openQuestions?.length)
    console.log(`  ${b.provenance.review.openQuestions.length} open SME question(s) — human review pass pending`)
  if (b.provenance?.sourceLicense) console.log(`  source license: ${b.provenance.sourceLicense}`)
  console.log(`  → ${path.relative(root, outPath)}`)
  if (workspaceOut) console.log(`  → ${path.join(path.resolve(workspaceOut), 'bundle.json')} (workspace copy)`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
