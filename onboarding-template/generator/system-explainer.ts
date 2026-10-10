/**
 * system-explainer CLI: build a grounded course from any sources, prove it, re-check it, view it.
 *
 *   system-explainer course <source...>   author (needs ANTHROPIC_API_KEY, or --fake)
 *   system-explainer ingest <source...>   read the sources into a corpus and report what could not be read
 *   system-explainer sources              what this machine can read, and the credential names it sees
 *   system-explainer prove [<workspace>]  adversarial verify + learner lift (needs ANTHROPIC_API_KEY, or --fake)
 *   system-explainer reverify [<workspace>]  free re-check of every snippet and quote (no model call)
 *   system-explainer serve [<workspace>]  serve the generated course locally
 *   system-explainer smoke                every path offline on the bundled fixtures (no API)
 *
 * A source is anything: a repo, a folder, a file in any common format, a URL, or a reference in
 * words. The code reads formats; whatever it cannot read goes to an access agent that reasons about
 * how to reach it, and anything still unreachable stops the run loudly (exit 3) before the course
 * loop spends anything. Everything a run produces lives under <workspace>/.system-explainer/.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
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
import { defaultWhich, formatProblems, ingest, redactUserInfo, sourceCatalog, type IngestResult } from './ingest'
import { credentialNames } from './ingest/report'
import { createFakeAccessPlayer } from './ingest/fake-access'
import { RUN_OUTPUT_DIRS, type CourseMode, type CredentialGrant, type RunConfig } from './ingest/types'
import { estimateCostUsd } from './llm/cost'

const here = path.dirname(fileURLToPath(import.meta.url))
// generator/ and dist-cli/ are both one level below the package root.
const pkgRoot = path.resolve(here, '..')
const DEFAULT_MODEL = 'claude-opus-5'
const EFFORTS = ['low', 'medium', 'high', 'max'] as const
type Effort = (typeof EFFORTS)[number]
/** Exit code for "a source could not be read": distinct from 1 (error or drift) and 2 (a claim was refuted). */
export const EXIT_UNREACHABLE = 3

const USAGE = `system-explainer <command> [options]

commands
  course <source...>       build a grounded course from any sources: a repo, a folder, files (Markdown,
                           text, HTML, PDF, Word, PowerPoint, transcripts, email, CSV, JSON), URLs, or a
                           reference in words; whatever the format layer cannot read, an access agent
                           works out how to reach (exit 3 when a source still cannot be read)
  ingest <source...>       read the sources into .system-explainer/corpus and report what could not be read
  sources                  what this machine can read, and the credential names the access agent can use
  prove [<workspace>]      adversarially verify the course and measure learner lift (exit 2 when a claim is refuted)
  reverify [<workspace>]   re-read the sources and re-check every snippet and quote, no model call (exit 1 on drift)
  serve [<workspace>]      serve the generated course at http://localhost:4173
  smoke                    run every path offline on the bundled fixtures, no API call

options
  --system <id>          course id (default: the workspace directory name)
  --workspace <dir>      where .system-explainer/ lives (default: the one repo or folder given, else the current directory)
  --grant <VAR>=<host>   let the access agent send environment variable VAR to that https host (repeatable; remembered)
  --allow-partial        build without the sources that cannot be read; the course and proof report list them
  --transcribe           let the model transcribe scanned PDFs and images (costs tokens; marked as transcribed)
  --audience <who>       developer|non-technical (default: non-technical for documents only, else developer)
  --src <hint>           where the source lives inside the repo (course, code)
  --model <id>           model for every role (default: ${DEFAULT_MODEL}; env SYSTEM_EXPLAINER_MODEL)
  --model-learner <id>   model for the two learner arms (prove; default: --model)
  --effort <level>       ${EFFORTS.join('|')} (default: high)
  --concurrency <n>      parallel agents (default: 3)
  --rounds <n>           completeness-critic rounds (course; default: 3)
  --modules <a,b>        scope prove to these module ids
  --affected             scope prove to modules whose cited files or documents changed
  --since <ref>          diff base for reverify of code (default: the bundle's pinned sha)
  --write                reverify: restamp the bundle at the current state
  --port <n>             serve: port (default: 4173)
  --out <dir>            course: also copy the bundle here
  --fake                 use the offline scripted model instead of the API
  --json                 print the run's result as JSON on the last line

env   ANTHROPIC_API_KEY (required unless --fake)   ANTHROPIC_BASE_URL (optional)
      any credential the access agent may use, by name (values are never shown to the model)`

interface Args {
  cmd?: string
  positional: string[]
  opts: Record<string, string | true>
  /** Repeatable flags (--grant). */
  multi: Record<string, string[]>
}

const BOOLEAN_FLAGS = new Set(['affected', 'write', 'fake', 'json', 'help', 'allow-partial', 'transcribe'])
const REPEATABLE = new Set(['grant'])

export function parseArgs(argv: string[]): Args {
  const a: Args = { positional: [], opts: {}, multi: {} }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t === '-h' || t === '--help') a.opts.help = true
    else if (t.startsWith('--')) {
      const eq = t.indexOf('=')
      const name = eq > 0 ? t.slice(2, eq) : t.slice(2)
      let value: string | true
      if (eq > 0) value = t.slice(eq + 1)
      else if (BOOLEAN_FLAGS.has(name) || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) value = true
      else value = argv[++i]
      if (REPEATABLE.has(name) && typeof value === 'string') (a.multi[name] ??= []).push(value)
      else a.opts[name] = value
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

/** A course built only from documents is for whoever reads them, so it defaults to plain English; anything with code defaults to developers. */
function audienceOf(a: Args, mode: CourseMode): 'developer' | 'non-technical' {
  const v = str(a, 'audience') ?? (mode === 'documents' ? 'non-technical' : 'developer')
  if (v !== 'developer' && v !== 'non-technical') throw new Error(`--audience must be developer or non-technical, got "${v}"`)
  return v
}

export function defaultSystemId(dir: string): string {
  return path.basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'course'
}

const bundleRel = (system: string) => path.join('bundles', system, 'bundle.json')

/**
 * Where .system-explainer/ goes: --workspace, else the one local repo among the sources (so a
 * code course stays beside its code), else the one local folder when it is the only source, else
 * the current directory.
 */
export function resolveWorkspace(sources: string[], cwd: string, explicit?: string): string {
  if (explicit) return path.resolve(cwd, explicit)
  const dirs = sources.map((s) => path.resolve(cwd, s)).filter((p) => existsSync(p) && statSync(p).isDirectory())
  const repos = dirs.filter((p) => existsSync(path.join(p, '.git')))
  if (repos.length === 1) return repos[0]
  if (sources.length === 1 && dirs.length === 1) return dirs[0]
  return cwd
}

function roleOf(params: Anthropic.MessageCreateParamsNonStreaming): string {
  const sys = params.system
  const text = typeof sys === 'string' ? sys : (sys ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n')
  return /^ROLE:\s*(\S+)/m.exec(text)?.[1] ?? ''
}

const COURSE_ROLES = new Set(['enumerate', 'data-model', 'author', 'verify', 'critic'])
const hasMedia = (params: Anthropic.MessageCreateParamsNonStreaming) =>
  params.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'image' || b.type === 'document'))
const FAKE_TRANSCRIPT = `[offline fake transcription: the --fake model does not read images or PDFs]

Whiteboard from the planning session: three columns, Now, Next and Later, with sticky notes under each.`

/** The offline model: one scripted player per role, routed by the ROLE line every runner puts first in its system prompt. */
export function fakeClientFor(dir: string): LlmClient {
  const course = createFakeCoursePlayer(dir)
  const proof = createFakeProofPlayer()
  const access = createFakeAccessPlayer()
  return createFakeClient((i, params) => {
    const role = roleOf(params)
    if (role === 'access') return access(i, params)
    if (COURSE_ROLES.has(role)) return course(i, params)
    if (!role && hasMedia(params)) return { text: FAKE_TRANSCRIPT }
    return proof(i, params)
  })
}

/** The model client, or null when there is no key and no --fake (only the free format layer can run then). */
function optionalClient(a: Args, dir: string): LlmClient | null {
  if (a.opts.fake) return fakeClientFor(dir)
  if (!process.env.ANTHROPIC_API_KEY) return null
  return createAnthropicClient({ apiKey: process.env.ANTHROPIC_API_KEY, baseURL: process.env.ANTHROPIC_BASE_URL })
}

function clientFor(a: Args, dir: string): LlmClient {
  const c = optionalClient(a, dir)
  if (!c) throw new Error('ANTHROPIC_API_KEY is not set. Export your Anthropic API key (https://console.anthropic.com/) or pass --fake for the offline scripted model.')
  return c
}

const modelOf = (a: Args) => str(a, 'model') ?? process.env.SYSTEM_EXPLAINER_MODEL ?? DEFAULT_MODEL

// ── grants: which credential NAME may go to which host (values never stored) ───────────────────────

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const HOST = /^[a-z0-9.-]+(?::\d+)?$/i

export function parseGrant(raw: string): CredentialGrant {
  const eq = raw.indexOf('=')
  const env = raw.slice(0, eq)
  const host = raw.slice(eq + 1).replace(/^https:\/\//i, '').replace(/\/.*$/, '').toLowerCase()
  if (eq <= 0 || !ENV_NAME.test(env) || !HOST.test(host)) throw new Error(`--grant must look like VAR=host (for example --grant MY_TOKEN=api.example.com), got "${raw}"`)
  return { env, host }
}

const grantsFile = (root: string) => path.join(root, 'access.json')

function loadGrants(root: string, a: Args): CredentialGrant[] {
  const saved: CredentialGrant[] = existsSync(grantsFile(root)) ? (JSON.parse(readFileSync(grantsFile(root), 'utf8')).grants ?? []) : []
  return dedupeGrants([...saved.filter((g) => ENV_NAME.test(g.env) && HOST.test(g.host)), ...(a.multi.grant ?? []).map(parseGrant)])
}

function saveGrants(root: string, grants: CredentialGrant[]) {
  if (!grants.length) return
  mkdirSync(root, { recursive: true })
  writeFileSync(grantsFile(root), JSON.stringify({ note: 'Credential NAMES and the hosts they may be sent to. Values are never stored.', grants: dedupeGrants(grants) }, null, 2) + '\n')
}

const dedupeGrants = (gs: CredentialGrant[]) => gs.filter((g, i) => gs.findIndex((x) => x.env === g.env && x.host === g.host) === i)

async function confirmTty(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} `)).trim())
  } finally {
    rl.close()
  }
}

// ── reading the sources ───────────────────────────────────────────────────────────────────────────

interface Placed {
  ing: IngestResult
  mode: CourseMode
  repo?: string
  corpusDir: string
  /** The corpus path relative to the grounding root ('' in documents mode). */
  relPath: string
  groundingRoot: string
}

/**
 * Runs ingest and prints what it read. Returns null when sources are unreachable and the run must
 * stop (no --allow-partial). The corpus of a mixed course must live inside the repo, because every
 * citation is relative to the repo; a cloned repo gets a copy.
 */
async function readSources(
  a: Args,
  sources: string[],
  root: string,
  client: LlmClient | null,
  opts: { replay?: boolean; partial?: boolean; /** sources the course already records as built without: reminded, not re-alarmed */ known?: Set<string> } = {},
): Promise<Placed | null> {
  const corpusDir = path.join(root, 'corpus')
  const grants = loadGrants(root, a)
  const model = modelOf(a)
  const interactive = !a.opts.json && !!process.stdin.isTTY && !!process.stdout.isTTY
  const partial = opts.partial ?? !!a.opts['allow-partial']
  const ing = await ingest({
    sources,
    corpusDir,
    cwd: process.cwd(),
    transcribe: a.opts.transcribe && client ? { client, model } : undefined,
    access: client && !opts.replay ? { client, model, effort: effortOf(a), grants, confirm: interactive ? confirmTty : undefined, transcriptDir: path.join(root, 'transcripts', 'access') } : undefined,
    grants,
    replay: opts.replay,
    allowPartial: partial,
    onEvent: logEvent,
  })
  saveGrants(root, [...grants, ...ing.grantsUsed])
  const usedApi = ing.usage.input_tokens > 0
  const read = ing.manifest.docs.length
  console.log(`  read ${read} document(s) from ${sources.length} source(s)${ing.repo ? ` + repository ${ing.repo}` : ''} · mode ${ing.mode}${usedApi ? ` · access reasoning ${usageShort(ing.usage, model)}` : ''}`)
  const known = ing.problems.filter((p) => opts.known?.has(p.source))
  const fresh = ing.problems.filter((p) => !opts.known?.has(p.source))
  if (known.length) console.log(`  still built without (as the course records): ${known.map((p) => p.source).join(', ')}`)
  if (fresh.length) {
    // Files inside a folder count as their own sources here, so "N of M" adds up.
    console.error('\n' + formatProblems(fresh, { partial, total: ing.manifest.sources.length, usedApi }))
    if (!partial) return null
  }
  let placedCorpus = corpusDir
  let relPath = ''
  if (ing.mode === 'mixed' && ing.repo) {
    const inside = path.join(ing.repo, '.system-explainer', 'corpus')
    if (path.resolve(inside) !== path.resolve(corpusDir)) {
      rmSync(inside, { recursive: true, force: true })
      cpSync(corpusDir, inside, { recursive: true })
    }
    placedCorpus = inside
    relPath = '.system-explainer/corpus'
  }
  const groundingRoot = ing.mode === 'documents' ? placedCorpus : ing.repo!
  return { ing, mode: ing.mode, repo: ing.repo, corpusDir: placedCorpus, relPath, groundingRoot }
}

function usageShort(u: AgentUsage, model: string): string {
  const cost = estimateCostUsd(model, u)
  return `${u.input_tokens.toLocaleString()} in / ${u.output_tokens.toLocaleString()} out tokens${cost === null ? '' : ` (est. $${cost.toFixed(2)})`}`
}

const runFile = (root: string) => path.join(root, 'run.json')

function loadRun(root: string): RunConfig | null {
  return existsSync(runFile(root)) ? (JSON.parse(readFileSync(runFile(root), 'utf8')) as RunConfig) : null
}

/** A source argument as recorded for reruns: local paths absolute (reverify may run from elsewhere), URLs as given minus any password. */
function recordSource(raw: string, cwd: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return redactUserInfo(raw)
  const abs = path.resolve(cwd, raw)
  return existsSync(abs) ? abs : raw
}

/** The workspace a command after `course` acts on: the argument, else the current directory. */
function workspaceArg(a: Args): { dir: string; root: string; run: RunConfig | null } {
  const dir = path.resolve(a.positional[0] ?? process.cwd())
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`workspace not found: ${dir}`)
  const root = path.join(dir, '.system-explainer')
  return { dir, root, run: loadRun(root) }
}

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

function pickSystem(a: Args, root: string, run: RunConfig | null): string {
  const explicit = str(a, 'system') ?? run?.system
  if (explicit) return explicit
  const dir = path.join(root, 'bundles')
  const ids = existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(path.join(dir, d, 'bundle.json'))) : []
  if (ids.length === 1) return ids[0]
  if (ids.length === 0) throw new Error(`no course under ${dir}; run \`system-explainer course <source...>\` first`)
  throw new Error(`several courses under ${dir} (${ids.join(', ')}); pass --system <id>`)
}

async function course(a: Args): Promise<number> {
  const sources = a.positional
  if (!sources.length) throw new Error(`missing <source...>\n\n${USAGE}`)
  const cwd = process.cwd()
  const ws = resolveWorkspace(sources, cwd, str(a, 'workspace'))
  const root = path.join(ws, '.system-explainer')
  mkdirSync(root, { recursive: true })
  const client = clientFor(a, ws)
  const model = modelOf(a)
  console.log(`course ← ${sources.join(' ')}\n  model ${model}${a.opts.fake ? ' (offline fake)' : ''} · effort ${effortOf(a)} · output ${root}`)
  const placed = await readSources(a, sources, root, client)
  if (!placed) return EXIT_UNREACHABLE
  const system = str(a, 'system') ?? defaultSystemId(placed.mode === 'documents' ? ws : placed.repo ?? ws)
  const run: RunConfig = { version: 1, system, mode: placed.mode, sources: sources.map((s) => recordSource(s, cwd)), repo: placed.repo, groundingRoot: placed.groundingRoot }
  writeFileSync(runFile(root), JSON.stringify(run, null, 2) + '\n')
  const r = await runCourse({
    client,
    model,
    repoPath: placed.groundingRoot,
    systemName: system,
    srcHint: str(a, 'src'),
    repoUrl: str(a, 'repo-url'),
    audience: audienceOf(a, placed.mode),
    mode: placed.mode,
    corpus: placed.mode === 'code' ? undefined : { dir: placed.corpusDir, manifest: placed.ing.manifest, relPath: placed.relPath },
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
  const evidence = placed.mode === 'code' ? 'snippets verified against the repo' : placed.mode === 'documents' ? 'quotes verified against the source documents' : 'snippets and quotes verified against the repo and documents'
  console.log(`\n✓ course ${system}: ${r.modules.length} module(s), ${r.dataModelEntities} entities → ${r.bundlePath}`)
  if (g) console.log(`  grounding: ${g.verified}/${g.total} ${evidence}, ${g.exact} exact${g.drifted || g.missingFile ? ` · ${g.drifted} drifted, ${g.missingFile} missing-file (re-author those)` : ''}`)
  if (placed.ing.problems.length) console.log(`  ⚠ built without ${placed.ing.problems.length} source(s) that could not be read; the course and the proof report list them`)
  const failed = r.agents.filter((x) => x.stopReason !== 'submitted')
  if (failed.length) console.log(`  ⚠ ${failed.length} agent run(s) did not submit: ${failed.map((x) => `${x.label} (${x.stopReason})`).join(', ')}`)
  console.log(`  ${usageLine(r.usage, r.estimatedCostUsd, r.seconds, r.agents.length)}`)
  console.log(site ? `\nView it:   system-explainer serve ${ws}` : `\nView it:   build the viewer once (npm run build) then: system-explainer serve ${ws}`)
  console.log(`Prove it:  system-explainer prove ${ws}`)
  if (a.opts.json) console.log(JSON.stringify(r))
  return 0
}

async function ingestCmd(a: Args): Promise<number> {
  const sources = a.positional
  if (!sources.length) throw new Error(`missing <source...>\n\n${USAGE}`)
  const ws = resolveWorkspace(sources, process.cwd(), str(a, 'workspace'))
  const root = path.join(ws, '.system-explainer')
  mkdirSync(root, { recursive: true })
  const client = optionalClient(a, ws)
  console.log(`ingest ← ${sources.join(' ')}\n  corpus ${path.join(root, 'corpus')}${client ? '' : ' · no model key: only the format layer runs (set ANTHROPIC_API_KEY so the access agent can reach the rest)'}`)
  const placed = await readSources(a, sources, root, client)
  const res = placed?.ing
  if (res) for (const d of res.manifest.docs) console.log(`   ${d.date ?? 'undated   '}  ${d.title}  (${d.service ?? d.kind}${d.via ? `, ${d.via}` : ''}) → ${d.path}`)
  if (a.opts.json && res) console.log(JSON.stringify({ mode: res.mode, repo: res.repo, docs: res.manifest.docs, problems: res.problems }))
  return placed && !(res!.problems.length && !a.opts['allow-partial']) ? 0 : EXIT_UNREACHABLE
}

function sourcesCmd(a: Args): number {
  const rows = sourceCatalog(process.env, defaultWhich)
  console.log('What this machine can read directly (anything else goes to the access agent):\n')
  for (const r of rows) {
    console.log(`  ${r.reachableNow ? '✓' : '✗'} ${r.label}  ${r.examples.length ? `(${r.examples.join(', ')})` : ''}`)
    console.log(`      ${r.status}`)
    for (const f of r.fixes) console.log(`      fix: ${f}`)
  }
  const names = credentialNames(process.env)
  console.log(`\nCredential NAMES the access agent may ask to use: ${names.length ? names.join(', ') : 'none set'}`)
  const ws = path.resolve(str(a, 'workspace') ?? process.cwd())
  const grants = loadGrants(path.join(ws, '.system-explainer'), a)
  console.log(`Grants (name → host it may be sent to): ${grants.length ? grants.map((g) => `${g.env} → ${g.host}`).join(', ') : 'none (add with --grant VAR=host)'}`)
  if (a.opts.json) console.log(JSON.stringify({ rows, credentialNames: names, grants }))
  return 0
}

async function prove(a: Args): Promise<number> {
  const { dir, root, run } = workspaceArg(a)
  const system = pickSystem(a, root, run)
  const bundlePath = bundleRel(system)
  if (!existsSync(path.join(root, bundlePath))) throw new Error(`no bundle at ${path.join(root, bundlePath)}; run \`system-explainer course <source...>\` first`)
  const groundingRoot = run?.groundingRoot ?? dir
  const mode: CourseMode = run?.mode ?? 'code'
  const client = clientFor(a, groundingRoot)
  const model = modelOf(a)
  const modelLearner = str(a, 'model-learner') ?? model
  console.log(`prove ${system} (${mode}) ← ${groundingRoot}\n  model ${model}${modelLearner !== model ? ` · learners ${modelLearner}` : ''}${a.opts.fake ? ' (offline fake)' : ''} · effort ${effortOf(a)}${a.opts.affected ? ' · scope: affected modules' : ''}`)
  const r = await runProve({
    client,
    model,
    modelLearner,
    system,
    bundlePath,
    repoPath: groundingRoot,
    root,
    mode,
    hidden: mode === 'mixed' ? RUN_OUTPUT_DIRS.map((d) => `.system-explainer/${d}`) : undefined,
    modules: str(a, 'modules')?.split(',').map((s) => s.trim()).filter(Boolean),
    affected: !!a.opts.affected,
    concurrency: num(a, 'concurrency'),
    effort: effortOf(a),
    onEvent: logEvent,
    transcriptDir: path.join(root, 'transcripts', system),
  })
  if (r.skipped) {
    console.log(`✓ nothing to prove: no module cites a file or document that changed since the course was built`)
    if (a.opts.json) console.log(JSON.stringify(r))
    return 0
  }
  const adv = r.adversarial
  const eff = r.effectiveness
  console.log(`\n✓ proof report → ${r.reportPath}`)
  if (adv) console.log(`  ${mode === 'code' ? 'true' : 'true to the sources'}: ${adv.supported}/${adv.total} claims survived adversarial review${adv.refuted ? `, ${adv.refuted} REFUTED (fix the lesson, re-run)` : ''}${adv.unverifiable ? `, ${adv.unverifiable} unverifiable` : ''}`)
  if (eff) console.log(`  effective: taught ${Math.round(eff.taughtOverall * 100)}% vs cold ${Math.round(eff.coldOverall * 100)}% on a hardened quiz = ${eff.taughtOverall - eff.coldOverall >= 0 ? '+' : ''}${Math.round((eff.taughtOverall - eff.coldOverall) * 100)} pts`)
  const failed = r.agents.filter((x) => x.stopReason !== 'submitted')
  if (failed.length) console.log(`  ⚠ ${failed.length} agent run(s) did not submit: ${failed.map((x) => `${x.label} (${x.stopReason})`).join(', ')}`)
  console.log(`  ${usageLine(r.usage, r.estimatedCostUsd, r.seconds, r.agents.length)}`)
  if (a.opts.json) console.log(JSON.stringify(r))
  return adv && adv.refuted > 0 ? 2 : 0
}

/**
 * The free half of the gate. Code: git diff since the pinned commit. Documents: the sources are
 * re-read (agent-reached ones replay their saved recipe, no model), and each file's sha256 is
 * compared with the bundle's record. Then every snippet and quote is re-checked.
 */
async function reverifyCmd(a: Args): Promise<number> {
  const { dir, root, run } = workspaceArg(a)
  const system = pickSystem(a, root, run)
  const bundlePath = bundleRel(system)
  let groundingRoot = run?.groundingRoot ?? dir
  let unreachable = 0
  if (run && run.mode !== 'code') {
    const bundle = JSON.parse(readFileSync(path.join(root, bundlePath), 'utf8'))
    const known = new Set<string>((bundle.provenance?.corpus?.unreachable ?? []).map((u: { source: string }) => u.source))
    console.log(`re-reading ${run.sources.length} source(s) (saved access recipes and transcriptions are reused; no model call)`)
    const placed = await readSources(a, run.sources, root, null, { replay: true, partial: true, known })
    unreachable = placed?.ing.problems.filter((p) => !known.has(p.source)).length ?? 0
    if (placed) groundingRoot = placed.groundingRoot
  }
  const write = !!a.opts.write
  const r = reverify({ system, bundlePath, repo: groundingRoot, since: str(a, 'since'), write, root })
  printReverify(system, bundlePath, r, write)
  if (write) writeSite(root, path.join(root, bundlePath))
  if (a.opts.json) console.log(JSON.stringify(r))
  return unreachable ? EXIT_UNREACHABLE : r.bad.length ? 1 : 0
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
  const { root, run } = workspaceArg(a)
  const system = pickSystem(a, root, run)
  const site = writeSite(root, path.join(root, bundleRel(system)))
  if (!site) throw new Error(`the viewer is not built: run \`npm run build\` in ${pkgRoot} once, then serve again`)
  const port = num(a, 'port') ?? 4173
  await serveDir(site, port)
  console.log(`serving ${system} at http://localhost:${port}/  (Ctrl-C to stop)`)
  return new Promise(() => {}) // runs until interrupted
}

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

const fakeArgs = (positional: string[], extra: Record<string, string | true> = {}): Args => ({ cmd: undefined, positional, opts: { fake: true, ...extra }, multi: {} })

function check(cond: unknown, what: string) {
  if (!cond) throw new Error(`smoke: ${what}`)
}

const bundleOf = (ws: string) => {
  const root = path.join(ws, '.system-explainer')
  const run = loadRun(root)!
  return JSON.parse(readFileSync(path.join(root, bundleRel(run.system)), 'utf8'))
}

/** The whole pipeline, offline, on the bundled fixtures: code, documents (incl. the loud stop) and mixed. Exit 0 only when every stage produced what the next one reads. */
async function smoke(_a: Args): Promise<number> {
  const fixtures = path.join(pkgRoot, 'fixtures')
  for (const f of ['mini-repo', 'mini-docs']) if (!existsSync(path.join(fixtures, f))) throw new Error(`fixture missing: ${path.join(fixtures, f)}`)
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'system-explainer-smoke-'))
  const t0 = Date.now()

  // 1. code: a repository
  const repo = path.join(tmp, 'mini-repo')
  cpSync(path.join(fixtures, 'mini-repo'), repo, { recursive: true })
  git(repo, ['init', '-q'])
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'fixture'])
  console.log(`smoke: fixtures copied to ${tmp}\n\n== code: course ==`)
  check((await course(fakeArgs([repo]))) === 0, 'code course failed')
  console.log('\n== code: prove ==')
  check((await prove(fakeArgs([repo]))) === 0, 'code prove failed')
  console.log('\n== code: reverify (clean tree) ==')
  check((await reverifyCmd(fakeArgs([repo]))) === 0, 'code reverify reported drift on an unchanged tree')
  console.log('\n== code: reverify + prove --affected after a source change ==')
  appendFileSync(path.join(repo, 'src', 'events.ts'), '\n// smoke: appended after the course was pinned\n')
  git(repo, ['commit', '-q', '-am', 'touch events'])
  await reverifyCmd(fakeArgs([repo]))
  check((await prove(fakeArgs([repo], { affected: true }))) === 0, 'code prove --affected failed')

  // 2. documents: meeting notes, a transcript that reverses a decision, HTML, text, Word, PowerPoint, PDF, an image, a recording
  const docs = path.join(tmp, 'larkspur-docs')
  cpSync(path.join(fixtures, 'mini-docs'), docs, { recursive: true })
  rmSync(path.join(docs, 'README.md'), { force: true })
  writeFileSync(path.join(docs, 'standup-recording.mp4'), Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]))
  console.log('\n== documents: course stops loudly on what it cannot read ==')
  check((await course(fakeArgs([docs]))) === EXIT_UNREACHABLE, 'documents course should exit 3 on unreadable sources')
  check(!existsSync(path.join(docs, '.system-explainer', 'bundles')), 'no course may be built after the loud stop')
  console.log('\n== documents: course --allow-partial --transcribe ==')
  check((await course(fakeArgs([docs], { 'allow-partial': true, transcribe: true }))) === 0, 'documents course failed')
  const db = bundleOf(docs)
  const quotes = db.modules.flatMap((m: any) => m.lessons.flatMap((l: any) => l.blocks.filter((b: any) => b.type === 'quote')))
  check(db.provenance?.corpus?.mode === 'documents', 'bundle is not marked as a documents course')
  check(quotes.length > 0 && quotes.every((q: any) => q.verified === 'verified'), 'documents course has unverified or no quotes')
  check((db.provenance.corpus.unreachable ?? []).some((u: any) => /standup-recording/.test(u.source)), 'the recording is not listed as built without')
  console.log('\n== documents: prove ==')
  check((await prove(fakeArgs([docs]))) === 0, 'documents prove failed')
  const report = readFileSync(path.join(docs, '.system-explainer', 'proof-runs', loadRun(path.join(docs, '.system-explainer'))!.system, 'PROOF_REPORT.md'), 'utf8')
  check(/True to the sources/.test(report) && /Built without/.test(report), 'documents proof report is missing its honest labels')
  console.log('\n== documents: reverify (unchanged) ==')
  check((await reverifyCmd(fakeArgs([docs]))) === 0, 'documents reverify reported a change on unchanged sources')
  console.log('\n== documents: a source changes, reverify + prove --affected ==')
  appendFileSync(path.join(docs, '2026-09-16-pricing-review.vtt'), '\n00:09:00.000 --> 00:09:05.000\n<v Dana>One more thing: annual plans keep the old price until renewal.\n')
  await reverifyCmd(fakeArgs([docs]))
  check((await prove(fakeArgs([docs], { affected: true }))) === 0, 'documents prove --affected failed')

  // 3. mixed: the repository plus the documents
  const mixedRepo = path.join(tmp, 'mixed-repo')
  cpSync(path.join(fixtures, 'mini-repo'), mixedRepo, { recursive: true })
  git(mixedRepo, ['init', '-q'])
  git(mixedRepo, ['add', '-A'])
  git(mixedRepo, ['commit', '-q', '-m', 'fixture'])
  const notes = path.join(tmp, 'notes')
  mkdirSync(notes)
  for (const f of ['2026-09-02-kickoff-notes.md', '2026-09-16-pricing-review.vtt']) cpSync(path.join(fixtures, 'mini-docs', f), path.join(notes, f))
  console.log('\n== mixed: course (repo + notes) ==')
  check((await course(fakeArgs([mixedRepo, notes]))) === 0, 'mixed course failed')
  const mb = bundleOf(mixedRepo)
  const types = new Set(mb.modules.flatMap((m: any) => m.lessons.flatMap((l: any) => l.blocks.map((b: any) => b.type))))
  check(mb.provenance?.corpus?.mode === 'mixed' && types.has('code') && types.has('quote'), 'mixed course lacks code or quotes')
  console.log('\n== mixed: prove ==')
  check((await prove(fakeArgs([mixedRepo]))) === 0, 'mixed prove failed')

  console.log(`\n✓ smoke passed in ${Math.round((Date.now() - t0) / 1000)}s: code, documents (loud stop, partial build, honest report, change detection) and mixed; fixtures in ${tmp}`)
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
      case 'ingest':
        return await ingestCmd(a)
      case 'sources':
        return sourcesCmd(a)
      case 'prove':
        return await prove(a)
      case 'reverify':
        return await reverifyCmd(a)
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
