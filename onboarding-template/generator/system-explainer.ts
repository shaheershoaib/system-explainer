/**
 * system-explainer CLI: author a grounded course from a repository, prove it, re-check it, view it.
 *
 *   system-explainer course <repo>     author (needs ANTHROPIC_API_KEY, or --fake)
 *   system-explainer prove <repo>      adversarial verify + learner lift (needs ANTHROPIC_API_KEY, or --fake)
 *   system-explainer reverify <repo>   free grounding re-check against HEAD (no API)
 *   system-explainer serve [<repo>]    serve the generated course locally
 *   system-explainer smoke             course + prove + reverify offline on the bundled fixture (no API)
 *
 * Everything a run produces lives under <repo>/.system-explainer/ (bundles/, proof-runs/, site/, transcripts/).
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type Anthropic from '@anthropic-ai/sdk'
import { createAnthropicClient, type LlmClient } from './llm/client'
import { createFakeClient } from './llm/fake'
import type { AgentUsage } from './llm/agent'
import { runCourse } from './course'
import { runProve } from './prove'
import { printReverify, reverify } from './reverify'
import { createFakeCoursePlayer } from './fake-course-roles'
import { createFakeProofPlayer } from './fake-proof-roles'

const here = path.dirname(fileURLToPath(import.meta.url))
// generator/ and dist-cli/ are both one level below the package root.
const pkgRoot = path.resolve(here, '..')
const DEFAULT_MODEL = 'claude-opus-5'
const EFFORTS = ['low', 'medium', 'high', 'max'] as const
type Effort = (typeof EFFORTS)[number]

const USAGE = `system-explainer <command> [options]

commands
  course <repo>      author a grounded course from a repository
  prove <repo>       adversarially verify the course and measure learner lift (exit 2 when a claim is refuted)
  reverify <repo>    re-check every cited snippet against HEAD, no API call (exit 1 on drift)
  serve [<repo>]     serve the generated course at http://localhost:4173
  smoke              run course + prove + reverify offline on the bundled fixture, no API call

options
  --system <id>          course id (default: the repo's directory name)
  --src <hint>           where the source lives inside the repo (course)
  --model <id>           model for every role (default: ${DEFAULT_MODEL}; env SYSTEM_EXPLAINER_MODEL)
  --model-learner <id>   model for the two learner arms (prove; default: --model)
  --effort <level>       ${EFFORTS.join('|')} (default: high)
  --concurrency <n>      parallel agents (default: 3)
  --rounds <n>           completeness-critic rounds (course; default: 3)
  --modules <a,b>        scope prove to these module ids
  --affected             scope prove to modules whose cited files changed since the pinned sha
  --since <ref>          diff base for reverify (default: the bundle's pinned sha)
  --write                reverify: restamp the bundle at HEAD
  --port <n>             serve: port (default: 4173)
  --out <dir>            course: also copy the bundle here
  --fake                 use the offline scripted model instead of the API
  --json                 print the run's result as JSON on the last line

env   ANTHROPIC_API_KEY (required unless --fake)   ANTHROPIC_BASE_URL (optional)`

interface Args {
  cmd?: string
  positional: string[]
  opts: Record<string, string | true>
}

const BOOLEAN_FLAGS = new Set(['affected', 'write', 'fake', 'json', 'help'])

export function parseArgs(argv: string[]): Args {
  const a: Args = { positional: [], opts: {} }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t === '-h' || t === '--help') a.opts.help = true
    else if (t.startsWith('--')) {
      const eq = t.indexOf('=')
      const name = eq > 0 ? t.slice(2, eq) : t.slice(2)
      if (eq > 0) a.opts[name] = t.slice(eq + 1)
      else if (BOOLEAN_FLAGS.has(name) || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) a.opts[name] = true
      else a.opts[name] = argv[++i]
    } else if (!a.cmd) a.cmd = t
    else a.positional.push(t)
  }
  return a
}

const str = (a: Args, k: string): string | undefined => (typeof a.opts[k] === 'string' ? (a.opts[k] as string) : undefined)
const num = (a: Args, k: string): number | undefined => {
  const v = str(a, k)
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${k} must be a positive integer, got "${v}"`)
  return n
}
const effortOf = (a: Args): Effort => {
  const v = str(a, 'effort') ?? 'high'
  if (!(EFFORTS as readonly string[]).includes(v)) throw new Error(`--effort must be one of ${EFFORTS.join(', ')}, got "${v}"`)
  return v as Effort
}

function requireRepo(a: Args): string {
  const p = a.positional[0]
  if (!p) throw new Error(`missing <repo>\n\n${USAGE}`)
  const abs = path.resolve(p)
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`repo not found: ${abs}`)
  return abs
}

export function defaultSystemId(repo: string): string {
  return path.basename(repo).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'course'
}

const engineRoot = (repo: string) => path.join(repo, '.system-explainer')
const bundleRel = (system: string) => path.join('bundles', system, 'bundle.json')

function roleOf(params: Anthropic.MessageCreateParamsNonStreaming): string {
  const sys = params.system
  const text = typeof sys === 'string' ? sys : (sys ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n')
  return /^ROLE:\s*(\S+)/m.exec(text)?.[1] ?? ''
}

const COURSE_ROLES = new Set(['enumerate', 'data-model', 'author', 'verify', 'critic'])

/** The offline model: one scripted player per role, routed by the ROLE line every runner puts first in its system prompt. */
export function fakeClientFor(repo: string): LlmClient {
  const course = createFakeCoursePlayer(repo)
  const proof = createFakeProofPlayer()
  return createFakeClient((i, params) => (COURSE_ROLES.has(roleOf(params)) ? course : proof)(i, params))
}

function clientFor(a: Args, repo: string): LlmClient {
  if (a.opts.fake) return fakeClientFor(repo)
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set. Export your Anthropic API key (https://console.anthropic.com/) or pass --fake for the offline scripted model.')
  }
  return createAnthropicClient({ apiKey: process.env.ANTHROPIC_API_KEY, baseURL: process.env.ANTHROPIC_BASE_URL })
}

const modelOf = (a: Args) => str(a, 'model') ?? process.env.SYSTEM_EXPLAINER_MODEL ?? DEFAULT_MODEL

function logEvent(e: { type: string; label: string; detail?: string }) {
  console.log(`  [${e.label}] ${e.type}${e.detail ? ` ${e.detail}` : ''}`)
}

function usageLine(usage: AgentUsage, costUsd: number | null, seconds: number, agents: number) {
  const cost = costUsd === null ? 'cost n/a for this model' : `est. $${costUsd.toFixed(2)}`
  return `${agents} agent run(s) · ${usage.input_tokens.toLocaleString()} in / ${usage.output_tokens.toLocaleString()} out tokens (${usage.cache_read_input_tokens.toLocaleString()} cache reads) · ${cost} · ${Math.round(seconds)}s`
}

/** Copies the prebuilt viewer next to the bundle so `serve` needs no build step. Returns null when the package has no dist/. */
function writeSite(root: string, bundleAbs: string): string | null {
  const dist = path.join(pkgRoot, 'dist')
  if (!existsSync(path.join(dist, 'index.html'))) return null
  const site = path.join(root, 'site')
  cpSync(dist, site, { recursive: true })
  writeFileSync(path.join(site, 'bundle.json'), readFileSync(bundleAbs))
  return site
}

function pickSystem(a: Args, root: string): string {
  const explicit = str(a, 'system')
  if (explicit) return explicit
  const dir = path.join(root, 'bundles')
  const ids = existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(path.join(dir, d, 'bundle.json'))) : []
  if (ids.length === 1) return ids[0]
  if (ids.length === 0) throw new Error(`no course under ${dir}; run \`system-explainer course <repo>\` first`)
  throw new Error(`several courses under ${dir} (${ids.join(', ')}); pass --system <id>`)
}

async function course(a: Args): Promise<number> {
  const repo = requireRepo(a)
  const system = str(a, 'system') ?? defaultSystemId(repo)
  const root = engineRoot(repo)
  mkdirSync(root, { recursive: true })
  const client = clientFor(a, repo)
  const model = modelOf(a)
  console.log(`course ${system} ← ${repo}\n  model ${model}${a.opts.fake ? ' (offline fake)' : ''} · effort ${effortOf(a)} · output ${root}`)
  const r = await runCourse({
    client,
    model,
    repoPath: repo,
    systemName: system,
    srcHint: str(a, 'src'),
    repoUrl: str(a, 'repo-url'),
    workDir: path.join(root, 'auto-course', system),
    concurrency: num(a, 'concurrency'),
    maxRounds: num(a, 'rounds'),
    effort: effortOf(a),
    root,
    out: str(a, 'out'),
    onEvent: logEvent,
    transcriptDir: path.join(root, 'transcripts', system),
  })
  const site = writeSite(root, r.bundlePath)
  const g = r.grounding
  console.log(`\n✓ course ${system}: ${r.modules.length} module(s), ${r.dataModelEntities} entities → ${r.bundlePath}`)
  if (g) console.log(`  grounding: ${g.verified}/${g.total} snippets verified against the repo, ${g.exact} exact${g.drifted || g.missingFile ? ` · ${g.drifted} drifted, ${g.missingFile} missing-file (re-author those)` : ''}`)
  const failed = r.agents.filter((x) => x.stopReason !== 'submitted')
  if (failed.length) console.log(`  ⚠ ${failed.length} agent run(s) did not submit: ${failed.map((x) => `${x.label} (${x.stopReason})`).join(', ')}`)
  console.log(`  ${usageLine(r.usage, r.estimatedCostUsd, r.seconds, r.agents.length)}`)
  console.log(site ? `\nView it:   system-explainer serve ${repo}` : `\nView it:   build the viewer once (npm run build) then: system-explainer serve ${repo}`)
  console.log(`Prove it:  system-explainer prove ${repo}`)
  if (a.opts.json) console.log(JSON.stringify(r))
  return 0
}

async function prove(a: Args): Promise<number> {
  const repo = requireRepo(a)
  const root = engineRoot(repo)
  const system = pickSystem(a, root)
  const bundlePath = bundleRel(system)
  if (!existsSync(path.join(root, bundlePath))) throw new Error(`no bundle at ${path.join(root, bundlePath)}; run \`system-explainer course ${repo} --system ${system}\` first`)
  const client = clientFor(a, repo)
  const model = modelOf(a)
  const modelLearner = str(a, 'model-learner') ?? model
  console.log(`prove ${system} ← ${repo}\n  model ${model}${modelLearner !== model ? ` · learners ${modelLearner}` : ''}${a.opts.fake ? ' (offline fake)' : ''} · effort ${effortOf(a)}${a.opts.affected ? ' · scope: affected modules' : ''}`)
  const r = await runProve({
    client,
    model,
    modelLearner,
    system,
    bundlePath,
    repoPath: repo,
    root,
    modules: str(a, 'modules')?.split(',').map((s) => s.trim()).filter(Boolean),
    affected: !!a.opts.affected,
    concurrency: num(a, 'concurrency'),
    effort: effortOf(a),
    onEvent: logEvent,
    transcriptDir: path.join(root, 'transcripts', system),
  })
  if (r.skipped) {
    console.log(`✓ nothing to prove: no module cites a file changed since the bundle's pinned sha`)
    if (a.opts.json) console.log(JSON.stringify(r))
    return 0
  }
  const adv = r.adversarial
  const eff = r.effectiveness
  console.log(`\n✓ proof report → ${r.reportPath}`)
  if (adv) console.log(`  true: ${adv.supported}/${adv.total} claims survived adversarial review${adv.refuted ? `, ${adv.refuted} REFUTED (fix the lesson, re-run)` : ''}${adv.unverifiable ? `, ${adv.unverifiable} unverifiable` : ''}`)
  if (eff) console.log(`  effective: taught ${Math.round(eff.taughtOverall * 100)}% vs cold ${Math.round(eff.coldOverall * 100)}% on a hardened quiz = ${eff.taughtOverall - eff.coldOverall >= 0 ? '+' : ''}${Math.round((eff.taughtOverall - eff.coldOverall) * 100)} pts`)
  const failed = r.agents.filter((x) => x.stopReason !== 'submitted')
  if (failed.length) console.log(`  ⚠ ${failed.length} agent run(s) did not submit: ${failed.map((x) => `${x.label} (${x.stopReason})`).join(', ')}`)
  console.log(`  ${usageLine(r.usage, r.estimatedCostUsd, r.seconds, r.agents.length)}`)
  if (a.opts.json) console.log(JSON.stringify(r))
  return adv && adv.refuted > 0 ? 2 : 0
}

function reverifyCmd(a: Args): number {
  const repo = requireRepo(a)
  const root = engineRoot(repo)
  const system = pickSystem(a, root)
  const bundlePath = bundleRel(system)
  const write = !!a.opts.write
  const r = reverify({ system, bundlePath, repo, since: str(a, 'since'), write, root })
  printReverify(system, bundlePath, r, write)
  if (write) writeSite(root, path.join(root, bundlePath))
  if (a.opts.json) console.log(JSON.stringify(r))
  return r.bad.length ? 1 : 0
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
}

/** Static server with SPA fallback; the viewer is a client-side router. */
export function serveDir(dir: string, port: number): Promise<http.Server> {
  const index = path.join(dir, 'index.html')
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0])
    const rel = path.normalize(url).replace(/^(\.\.[/\\])+/, '')
    let file = path.join(dir, rel)
    const missing = !file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()
    if (missing && path.extname(rel)) {
      // a missing asset is a 404, not the app shell (an HTML body on a .js URL only produces a confusing MIME error)
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('not found')
    }
    if (missing) file = index
    const ext = path.extname(file)
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(readFileSync(file))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

async function serve(a: Args): Promise<number> {
  const repo = a.positional[0] ? path.resolve(a.positional[0]) : process.cwd()
  const root = engineRoot(repo)
  const system = pickSystem(a, root)
  const site = writeSite(root, path.join(root, bundleRel(system)))
  if (!site) throw new Error(`the viewer is not built: run \`npm run build\` in ${pkgRoot} once, then serve again`)
  const port = num(a, 'port') ?? 4173
  await serveDir(site, port)
  console.log(`serving ${system} at http://localhost:${port}/  (Ctrl-C to stop)`)
  return new Promise(() => {}) // runs until interrupted
}

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** The whole pipeline, offline, on the bundled fixture. Exit 0 only when every stage produced what the next one reads. */
async function smoke(a: Args): Promise<number> {
  const fixture = path.join(pkgRoot, 'fixtures', 'mini-repo')
  if (!existsSync(fixture)) throw new Error(`fixture missing: ${fixture}`)
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'system-explainer-smoke-'))
  const repo = path.join(tmp, 'mini-repo')
  cpSync(fixture, repo, { recursive: true })
  git(repo, ['init', '-q'])
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'fixture'])
  const quiet = { ...a, opts: { ...a.opts, fake: true as const }, positional: [repo] }
  const t0 = Date.now()
  console.log(`smoke: fixture copied to ${repo}\n\n== course ==`)
  const c = await course(quiet)
  if (c !== 0) throw new Error(`course exited ${c}`)
  console.log('\n== prove (all modules) ==')
  const p = await prove(quiet)
  if (p !== 0) throw new Error(`prove exited ${p}`)
  console.log('\n== reverify (clean tree) ==')
  const rv = reverifyCmd(quiet)
  if (rv !== 0) throw new Error(`reverify exited ${rv} on an unchanged tree`)
  console.log('\n== reverify + prove --affected after a source change ==')
  appendFileSync(path.join(repo, 'src', 'events.ts'), '\n// smoke: appended after the course was pinned\n')
  git(repo, ['commit', '-q', '-am', 'touch events'])
  const rv2 = reverifyCmd(quiet) // exit 1 only on drift; an append below the cited lines keeps snippets verified
  const pa = await prove({ ...quiet, opts: { ...quiet.opts, affected: true } })
  if (pa !== 0) throw new Error(`prove --affected exited ${pa}`)
  const root = engineRoot(repo)
  const report = path.join(root, 'proof-runs', pickSystem(quiet, root), 'PROOF_REPORT.md')
  if (!existsSync(report)) throw new Error(`no proof report at ${report}`)
  console.log(`\n✓ smoke passed in ${Math.round((Date.now() - t0) / 1000)}s: course → prove → reverify (${rv2 === 0 ? 'clean' : 'drift reported'}) → prove --affected; report at ${report}`)
  return 0
}

export async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv)
  if (a.opts.help) {
    console.log(USAGE)
    return 0
  }
  if (!a.cmd) {
    console.error(USAGE)
    return 1
  }
  try {
    switch (a.cmd) {
      case 'course':
        return await course(a)
      case 'prove':
        return await prove(a)
      case 'reverify':
        return reverifyCmd(a)
      case 'serve':
        return await serve(a)
      case 'smoke':
        return await smoke(a)
      default:
        console.error(`unknown command "${a.cmd}"\n\n${USAGE}`)
        return 1
    }
  } catch (e: any) {
    console.error(`✗ ${e?.message ?? e}`)
    return 1
  }
}

const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) main(process.argv.slice(2)).then((code) => process.exit(code))
