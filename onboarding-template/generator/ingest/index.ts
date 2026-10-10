/**
 * ingest: every CLI source becomes markdown files under one corpus directory plus a manifest, or a
 * SourceProblem saying exactly why not and what to do. It never throws because a source failed.
 *
 * Phase 1 is free: local formats, plain GETs, git remotes. Phase 2 costs API money (the access
 * agent, --transcribe) and runs only when phase 1 found no problem, or with allowPartial; so a run
 * that is going to stop on a bad source stops before spending anything.
 */
import { accessSync, constants, promises as fs, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentUsage } from '../llm/agent'
import type { LlmClient } from '../llm/client'
import { replayRecipe, runAccessAgent, type AccessConfig, type AccessRecipe, type AccessRuntimeOptions, type ManifestSourceWithRecipe } from './access'
import { detectSource, isReference } from './detect'
import { renderDoc, sha256, shortHash, slugify, SourceError, type Draft, type Observation } from './frontmatter'
import { readFolder, readLocalFile, type FileResult, type PendingTranscription } from './local'
import { cloneOrRefresh, gitUrlAllowed, isGitRemote, readWebUrl, type NetCtx } from './remote'
import { FIX } from './report'
import { transcribeFile } from './transcribe'
import type { CorpusDoc, CorpusManifest, CourseMode, CredentialGrant, SourceProblem, SourceSpec } from './types'

export { detectSource } from './detect'
export { formatProblems, sourceCatalog, type CatalogRow } from './report'
export { transcribeFile } from './transcribe'
export { replayRecipe, type AccessConfig, type AccessRecipe, type ManifestSourceWithRecipe } from './access'

export interface IngestEvent {
  type: string
  label: string
  detail?: string
}

export interface IngestOptions {
  /** CLI arguments as typed. */
  sources: string[]
  /** Absolute; created if missing; its previous docs are replaced (new files first, then stale ones removed, manifest.json last). */
  corpusDir: string
  /** Resolves relative paths (default process.cwd()). */
  cwd?: string
  /** default process.env. Credential VALUES are read only to send them to a granted host, and scrubbed from all output. */
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
  /** PATH lookup (default: scan process.env.PATH). */
  which?: (bin: string) => string | null
  /** Set only when the user passed --transcribe. */
  transcribe?: { client: LlmClient; model: string }
  /** The access agent, for sources the format layer cannot read. Absent = such sources become problems with generic fixes. */
  access?: AccessConfig
  /** Grants usable without the access agent (replaying recipes); merged with access.grants. */
  grants?: CredentialGrant[]
  /** Re-read agent-reached sources from the recipes in the previous manifest, with no model call. */
  replay?: boolean
  /** --allow-partial: spend on the access agent / transcription even when other sources failed. */
  allowPartial?: boolean
  /** Where git remotes are cloned (default path.join(corpusDir, '..', 'sources')). */
  cloneDir?: string
  now?: () => Date
  /** default setTimeout; tests inject a fast one. */
  sleep?: (ms: number) => Promise<void>
  onEvent?: (e: IngestEvent) => void
  /** Test seam: accept file:// URLs as git remotes. Production accepts https and ssh forms only. */
  allowFileGitUrlsForTests?: boolean
}

export interface IngestResult {
  /** Also written to <corpusDir>/manifest.json. */
  manifest: CorpusManifest & { sources: ManifestSourceWithRecipe[] }
  /** Every unreachable source (and unreadable file inside a folder), in input order. */
  problems: SourceProblem[]
  mode: CourseMode
  /** The one repo (local or cloned) when mode is code | mixed. */
  repo?: string
  /** Summed over every access-agent run. */
  usage: AgentUsage
  /** Grants whose credential was actually sent (to persist for the next run). */
  grantsUsed: CredentialGrant[]
}

interface SourceState {
  spec: SourceSpec
  sourceId: string
  drafts: Draft[]
  problem?: SourceProblem
  fileProblems: SourceProblem[]
  pending: PendingTranscription[]
  access?: Observation | 'reference'
  recipe?: AccessRecipe
  repo?: string
}

const CREDENTIAL_NAME = /(TOKEN|KEY|SECRET|PASSWORD|AUTH|COOKIE|PAT)/i

export function defaultWhich(bin: string): string | null {
  if (!/^[A-Za-z0-9._+-]+$/.test(bin)) return null
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, bin)
    try {
      accessSync(p, constants.X_OK)
      if (statSync(p).isFile()) return p
    } catch {
      // not here
    }
  }
  return null
}

/** Replaces the value of every credential-looking (or granted) environment variable with [redacted]. */
export function makeScrub(env: Record<string, string | undefined>, grants: CredentialGrant[] = []): (s: string) => string {
  const granted = new Set(grants.map((g) => g.env))
  const secrets = Object.entries(env)
    .filter(([k, v]) => v && v.length >= 8 && (CREDENTIAL_NAME.test(k) || granted.has(k)))
    .map(([, v]) => v!)
    .sort((a, b) => b.length - a.length)
  return (s) => secrets.reduce((acc, v) => acc.split(v).join('[redacted]'), s)
}

const zeroUsage = (): AgentUsage => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })

export async function ingest(o: IngestOptions): Promise<IngestResult> {
  const cwd = o.cwd ?? process.cwd()
  const env = o.env ?? process.env
  const which = o.which ?? defaultWhich
  const now = o.now ?? (() => new Date())
  const corpusDir = path.resolve(o.corpusDir)
  const cloneDir = o.cloneDir ?? path.join(corpusDir, '..', 'sources')
  await fs.mkdir(corpusDir, { recursive: true })
  const previous = await readManifest(corpusDir)
  const grants: CredentialGrant[] = []
  for (const g of [...(o.grants ?? []), ...(o.access?.grants ?? [])]) if (!grants.some((x) => x.env === g.env && x.host === g.host)) grants.push(g)
  const scrub = makeScrub(env, grants)
  const emit = (type: string, label: string, detail?: string) => o.onEvent?.({ type, label, ...(detail === undefined ? {} : { detail: scrub(detail) }) })
  const net: NetCtx = { fetch: o.fetch ?? globalThis.fetch, sleep: o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), emit, scrub }
  let tempPath: string | null = null
  const tempDir = async () => (tempPath ??= await fs.mkdtemp(path.join(os.tmpdir(), 'system-explainer-ingest-')))
  const used: CredentialGrant[] = []
  const runtimeFor = (source: string): AccessRuntimeOptions => ({ net, env, grants, used, confirm: o.access?.confirm, which, tempDir, source })
  const usage = zeroUsage()
  const states: SourceState[] = []
  const prevSources = [...((previous?.sources ?? []) as ManifestSourceWithRecipe[])]
  const reuse = reuseTranscription(corpusDir, previous)

  try {
    // ── phase 1: free reads ──
    let repo: string | undefined
    for (const typed of o.sources) {
      let spec = detectSource(typed, cwd)
      if (o.allowFileGitUrlsForTests && /^file:\/\//i.test(typed.trim())) spec = { raw: typed, kind: 'git-remote', target: typed.trim() }
      // The argument is echoed into the manifest, problems and events: never with a password in it.
      const raw = redactUserInfo(typed)
      spec.raw = raw
      const s: SourceState = { spec, sourceId: sourceIdFor(spec), drafts: [], fileProblems: [], pending: [] }
      states.push(s)
      emit('read', spec.kind, raw)
      const prev = o.replay ? takeRecipe(prevSources, raw) : undefined
      try {
        if (prev) {
          emit('replay', spec.kind, raw)
          s.recipe = prev
          const r = await replayRecipe(prev, runtimeFor(raw))
          if (r.ok) s.drafts = r.drafts
          else throw new SourceError(`the saved way of reaching this source no longer works (${r.observed}).`, r.fixes, r.observed)
          continue
        }
        const found = await readFormat(s, { which, transcribe: Boolean(o.transcribe), cwd, cloneDir, tempDir, net, allowFile: Boolean(o.allowFileGitUrlsForTests), reuse })
        if (found) {
          if (repo && repo !== found) throw new SourceError(`A course is built from one repository; ${repo} is already this course's repository.`, FIX.secondRepo(raw), 'a second repository')
          repo = found
          s.repo = found
        }
        if (s.access && !o.access) s.problem = noAccessProblem(s)
      } catch (err) {
        s.problem = problemFrom(s.spec, err)
      }
    }

    // ── phase 2: paid reads, only when nothing failed (or --allow-partial) ──
    const failures = () => states.reduce((n, s) => n + (s.problem ? 1 : 0) + s.fileProblems.length, 0)
    const blocked = () => !o.allowPartial && failures() > 0
    for (const s of states.filter((x) => x.access && !x.problem)) {
      const observed = s.access === 'reference' ? undefined : s.access
      if (blocked()) {
        s.problem = deferred(s.spec, s.access === 'reference' ? 'not a path or URL; it needs the access agent' : observed!.summary, failures(), 'the access agent was not run')
        continue
      }
      emit('access', s.spec.kind, s.spec.raw)
      const r = await runAccessAgent({ spec: s.spec, observed, sourceId: s.sourceId }, o.access!, runtimeFor(s.spec.raw))
      addUsage(usage, r.usage)
      if (r.outcome.ok) {
        s.drafts = r.outcome.drafts
        s.recipe = r.outcome.recipe
      } else s.problem = r.outcome.problem
    }
    for (const s of states.filter((x) => x.pending.length && !x.problem)) {
      const folder = s.spec.kind === 'folder'
      for (const p of s.pending) {
        if (blocked()) {
          const problem = deferred(folder ? { raw: p.abs, kind: p.meta.kind, target: p.abs } : s.spec, `${p.kind} waiting for --transcribe`, failures(), 'it was not transcribed')
          if (folder) s.fileProblems.push({ ...problem, fixes: [...problem.fixes, FIX.inFolder] })
          else s.problem = problem
          continue
        }
        emit('transcribe', p.meta.kind, p.meta.origin)
        try {
          const t = await transcribeFile(o.transcribe!, p.abs, p.kind)
          s.drafts.push({ ...p.meta, content: t.markdown, transcribedBy: o.transcribe!.model })
        } catch (err) {
          const problem = problemFrom(folder ? { raw: p.abs, kind: p.meta.kind, target: p.abs } : s.spec, err)
          if (folder) s.fileProblems.push({ ...problem, fixes: [...problem.fixes, FIX.inFolder] })
          else s.problem = problem
        }
      }
    }

    // ── write ──
    const { manifest, problems } = await writeCorpus(corpusDir, states, previous, now().toISOString(), emit)
    for (const p of problems) emit('problem', p.kind, `${p.source}: ${p.why}`)
    const repoState = states.find((s) => s.repo)
    const mode: CourseMode = !repoState ? 'documents' : manifest.docs.length ? 'mixed' : 'code'
    return { manifest, problems, mode, ...(repoState ? { repo: repoState.repo } : {}), usage, grantsUsed: used }
  } finally {
    if (tempPath) await fs.rm(tempPath, { recursive: true, force: true })
  }
}

// ── phase 1 per source ─────────────────────────────────────────────────────────────────────────

interface FormatCtx {
  which: (bin: string) => string | null
  transcribe: boolean
  cwd: string
  cloneDir: string
  tempDir: () => Promise<string>
  net: NetCtx
  allowFile: boolean
  reuse?: (abs: string) => Draft | null
}

/** Reads one source with the format layer, filling `s`. Returns the repo directory when the source is a repository. */
async function readFormat(s: SourceState, c: FormatCtx): Promise<string | undefined> {
  const { spec } = s
  const local = { which: c.which, transcribe: c.transcribe, reuse: c.reuse }
  const take = (r: FileResult) => ('draft' in r ? s.drafts.push(r.draft) : s.pending.push(r.pending))
  switch (spec.kind) {
    case 'repo':
      return spec.target
    case 'folder': {
      const r = await readFolder(spec.target, local)
      r.results.forEach(take)
      s.fileProblems.push(...r.problems)
      return undefined
    }
    case 'git-remote':
      return cloneRemote(spec, c)
    case 'web': {
      const git = c.which('git')
      if (git && gitUrlAllowed(spec.target)) {
        const check = await isGitRemote(git, spec.target)
        c.net.emit('git', 'web', `${spec.target}: ${check.detail}`)
        if (check.ok) {
          spec.kind = 'git-remote'
          return cloneOrRefresh(git, spec.target, c.cloneDir)
        }
      }
      const r = await readWebUrl(spec.target, { ...c.net, which: c.which, transcribe: c.transcribe, tempDir: c.tempDir })
      if ('needsAccess' in r) s.access = r.needsAccess
      else take(r)
      return undefined
    }
    case 'unknown':
      if (isReference(spec)) {
        s.access = 'reference'
        return undefined
      }
      throw new SourceError(`nothing exists at ${spec.target}.`, FIX.missingPath(c.cwd), 'no such file or directory')
    default:
      take(await readLocalFile(spec.target, spec.kind, local, path.basename(spec.target).replace(/\.[^.]+$/, '')))
      return undefined
  }
}

async function cloneRemote(spec: SourceSpec, c: FormatCtx): Promise<string> {
  if (!gitUrlAllowed(spec.target, c.allowFile)) {
    throw new SourceError('it is not an https or ssh git URL this tool will pass to git.', FIX.gitRemote(spec.target), 'unsupported git URL form')
  }
  const git = c.which('git')
  if (!git) throw new SourceError('git is not installed, so the repository cannot be cloned.', ['Install git (https://git-scm.com/downloads), then retry.', 'Or clone it on another machine and pass the folder.'], 'git not on PATH')
  const check = await isGitRemote(git, spec.target)
  if (!check.ok) throw new SourceError('git could not reach a repository at that address.', FIX.gitRemote(spec.target), check.detail)
  return cloneOrRefresh(git, spec.target, c.cloneDir)
}

// ── problems ───────────────────────────────────────────────────────────────────────────────────

function problemFrom(spec: SourceSpec, err: unknown): SourceProblem {
  if (err instanceof SourceError) return { source: spec.raw, kind: spec.kind, ...(err.observed ? { observed: err.observed } : {}), why: err.why, fixes: err.fixes }
  return {
    source: spec.raw,
    kind: spec.kind,
    why: `reading it failed unexpectedly (${err instanceof Error ? err.message : String(err)}).`,
    fixes: ['Retry; if it keeps failing, export the content to a file (PDF, Markdown or plain text) and pass that file.'],
  }
}

function noAccessProblem(s: SourceState): SourceProblem {
  if (s.access === 'reference') {
    return {
      source: s.spec.raw,
      kind: s.spec.kind,
      observed: 'not an existing path or a URL',
      why: 'it is neither a file, a folder nor a URL, and working out what it refers to needs the access agent, which this run does not have.',
      fixes: [...FIX.access, 'Run system-explainer sources to see every supported format and the form each source takes.'],
    }
  }
  const obs = s.access as Observation
  return { source: s.spec.raw, kind: s.spec.kind, observed: obs.summary, why: `the format layer could not read it (${obs.summary}), and working out how to reach it needs the access agent, which this run does not have.`, fixes: FIX.access }
}

function deferred(spec: SourceSpec, observed: string, failures: number, what: string): SourceProblem {
  return {
    source: spec.raw,
    kind: spec.kind,
    observed,
    why: `${what}: ${failures} other source${failures === 1 ? '' : 's'} could not be read, so no API call was made for this one.`,
    fixes: FIX.deferred,
  }
}

// ── corpus ─────────────────────────────────────────────────────────────────────────────────────

/** "https://user:secret@host/x" -> "https://[redacted]@host/x" (a user name alone, as in ssh://git@host, is kept). */
/**
 * A previous transcription of a local file is reused when the file has not been modified since it
 * was read: the corpus keeps the same words and sha256, and no model is called. A changed file is
 * read again (with --transcribe) or refused (without it), never served stale.
 */
function reuseTranscription(corpusDir: string, previous: CorpusManifest | null): (abs: string) => Draft | null {
  const byOrigin = new Map((previous?.docs ?? []).filter((d) => d.transcribedBy).map((d) => [d.origin, d]))
  return (abs) => {
    const prev = byOrigin.get(abs)
    if (!prev) return null
    try {
      if (statSync(abs).mtimeMs > Date.parse(prev.retrievedAt)) return null
      const text = readFileSync(path.join(corpusDir, prev.path), 'utf8')
      const body = text.replace(/^---\n[\s\S]*?\n---\n\n?/, '')
      // Same name as before, so the doc keeps its corpus path (and, with the same words, its sha256).
      const name = prev.path.split('/').slice(1).join('/').replace(/\.md$/, '')
      return { title: prev.title, kind: prev.kind, origin: prev.origin, name, via: prev.via ?? 'local file, transcribed', date: prev.date, speakers: prev.speakers, service: prev.service, transcribedBy: prev.transcribedBy, content: body }
    } catch {
      return null
    }
  }
}

export const redactUserInfo = (raw: string) => raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s:]*:[^/@\s]*@/i, '$1[redacted]@')

function sourceIdFor(spec: SourceSpec): string {
  let label = spec.raw
  if (path.isAbsolute(spec.target)) label = path.basename(spec.target)
  else if (/^https?:\/\//.test(spec.target)) {
    const u = new URL(spec.target)
    label = `${u.host}-${u.pathname.split('/').filter(Boolean).at(-1) ?? ''}`
  }
  return `${spec.kind}-${slugify(label, 40)}-${shortHash(spec.raw)}`
}

function takeRecipe(prev: ManifestSourceWithRecipe[], raw: string): AccessRecipe | undefined {
  const i = prev.findIndex((p) => p.raw === raw && p.recipe)
  return i < 0 ? undefined : prev.splice(i, 1)[0].recipe
}

async function readManifest(dir: string): Promise<CorpusManifest | null> {
  try {
    const m = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')) as CorpusManifest
    return m?.version === 1 && Array.isArray(m.docs) && Array.isArray(m.sources) ? m : null
  } catch {
    return null
  }
}

async function writeCorpus(
  dir: string,
  states: SourceState[],
  previous: CorpusManifest | null,
  retrievedAt: string,
  emit: (type: string, label: string, detail?: string) => void,
): Promise<{ manifest: CorpusManifest & { sources: ManifestSourceWithRecipe[] }; problems: SourceProblem[] }> {
  const prevDocs = new Map((previous?.docs ?? []).map((d) => [d.path, d]))
  const docs: CorpusDoc[] = []
  const sources: ManifestSourceWithRecipe[] = []
  const problems: SourceProblem[] = []
  for (const s of states) {
    const taken = new Set<string>()
    const paths: string[] = []
    if (!s.problem) {
      for (const d of s.drafts) {
        const rel = uniquePath(s.sourceId, d.name, taken)
        const meta = { title: d.title, kind: d.kind, origin: d.origin, date: d.date, speakers: d.speakers, service: d.service, via: d.via, transcribedBy: d.transcribedBy }
        let at = retrievedAt
        let text = renderDoc({ ...meta, retrievedAt: at }, d.content)
        // An unchanged doc keeps its previous retrieval time, so its bytes and sha256 stay stable for reverify.
        const prev = prevDocs.get(rel)
        if (prev?.retrievedAt && prev.retrievedAt !== at) {
          const again = renderDoc({ ...meta, retrievedAt: prev.retrievedAt }, d.content)
          if (sha256(again) === prev.sha256) [text, at] = [again, prev.retrievedAt]
        }
        const abs = path.join(dir, ...rel.split('/'))
        await fs.mkdir(path.dirname(abs), { recursive: true })
        await fs.writeFile(abs, text)
        const bytes = Buffer.from(text)
        docs.push({
          path: rel,
          sourceId: s.sourceId,
          title: d.title,
          kind: d.kind,
          origin: d.origin,
          ...(d.date ? { date: d.date } : {}),
          ...(d.speakers?.length ? { speakers: d.speakers } : {}),
          retrievedAt: at,
          sha256: sha256(bytes),
          bytes: bytes.length,
          ...(d.transcribedBy ? { transcribedBy: d.transcribedBy } : {}),
          ...(d.service ? { service: d.service } : {}),
          ...(d.via ? { via: d.via } : {}),
        })
        paths.push(rel)
        emit('doc', d.kind, rel)
      }
    }
    sources.push({
      raw: s.spec.raw,
      kind: s.spec.kind,
      status: s.problem ? 'unreachable' : 'ok',
      docs: paths,
      ...(s.problem ? { problem: s.problem } : {}),
      ...(s.recipe ? { recipe: s.recipe } : {}),
    })
    if (s.problem) problems.push(s.problem)
    for (const fp of s.fileProblems) {
      sources.push({ raw: fp.source, kind: fp.kind, status: 'unreachable', docs: [], problem: fp })
      problems.push(fp)
    }
  }
  await removeStale(dir, new Set(docs.map((d) => d.path)))
  docs.sort((a, b) => (a.date && b.date ? a.date.localeCompare(b.date) : a.date ? -1 : b.date ? 1 : 0) || a.path.localeCompare(b.path))
  const manifest = { version: 1 as const, createdAt: retrievedAt, sources, docs }
  const tmp = path.join(dir, `manifest.json.${process.pid}.tmp`)
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2) + '\n')
  await fs.rename(tmp, path.join(dir, 'manifest.json'))
  return { manifest, problems }
}

/** "<sourceId>/<slug segments>.md", with -2, -3 ... when two docs of one source slug the same. */
function uniquePath(sourceId: string, name: string, taken: Set<string>): string {
  const base = `${sourceId}/${name.split(/[\\/]/).map((seg) => slugify(seg)).join('/')}`
  let rel = `${base}.md`
  for (let n = 2; taken.has(rel); n++) rel = `${base}-${n}.md`
  taken.add(rel)
  return rel
}

/** Deletes corpus docs (".md" inside a source directory) that this run did not write, then empty directories. */
async function removeStale(dir: string, keep: Set<string>): Promise<void> {
  const walk = async (rel: string): Promise<boolean> => {
    const entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])
    let empty = true
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (await walk(p)) await fs.rmdir(path.join(dir, p)).catch(() => {})
        else empty = false
      } else if (rel && e.name.endsWith('.md') && !keep.has(p)) await fs.unlink(path.join(dir, p))
      else empty = false
    }
    return empty
  }
  await walk('')
}

function addUsage(total: AgentUsage, u: AgentUsage): void {
  total.input_tokens += u.input_tokens
  total.output_tokens += u.output_tokens
  total.cache_read_input_tokens += u.cache_read_input_tokens
  total.cache_creation_input_tokens += u.cache_creation_input_tokens
}

