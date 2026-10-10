/**
 * The network half of the format layer: one reliable GET (timeout, bounded jittered retries,
 * Retry-After, a 20 MB cap, manual redirects that drop host-bound headers), the plain-URL reader
 * (one GET parsed by content type), and the generic git-remote check (any host `git ls-remote`
 * accepts). No service is known here: a URL this layer cannot read is handed to the access agent
 * with what was observed.
 */
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { isSshGitUrl } from './detect'
import { dayOf, firstHeading, slugify, SourceError, titleFromFileName, type Draft, type Observation } from './frontmatter'
import { decodeText, hasTextLayer, htmlToMarkdown, MAX_BYTES, pagesToMarkdown, pdfPages, run, type PendingTranscription } from './local'
import { FIX } from './report'
import { imageMediaType } from './transcribe'

export interface NetCtx {
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
  emit: (type: string, label: string, detail?: string) => void
  /** Replaces every known secret value with [redacted]. */
  scrub: (s: string) => string
}

export interface GetOptions {
  label: string
  headers?: Record<string, string>
  /** Removed from the request when a redirect leaves the original host (credentials). */
  hostBound?: string[]
  /** Return a refusal reason to stop before following a redirect to `to`. */
  allowHop?: (to: URL) => string | null
}

export type GetResult =
  | { ok: true; status: number; headers: Headers; body: Buffer; finalUrl: string; hops: string[] }
  | { ok: false; error: string; finalUrl: string; hops: string[] }

const TIMEOUT_MS = 30_000
const MAX_ATTEMPTS = 3
const MAX_REDIRECTS = 5
const RETRY_AFTER_CAP_MS = 30_000
const RETRYABLE = new Set([429, 502, 503, 504])
const REDIRECT = new Set([301, 302, 303, 307, 308])

/** host + path only: a query string can carry a secret, so it never reaches an event. */
export const where = (u: URL) => `${u.host}${u.pathname}`

export const isLinkLocal = (host: string) => /^169\.254\.|^\[fe[89ab][0-9a-f]:/i.test(host) || host === 'metadata.google.internal'
export const isPrivateHost = (host: string) =>
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[::1?\]|\[f[cd][0-9a-f]{2}:)/i.test(host) || isLinkLocal(host)

/** Full jitter: uniform in [0, min(8 s, 0.5 s * 2^attempt)). */
const backoff = (attempt: number) => Math.random() * Math.min(8000, 500 * 2 ** attempt)

function retryAfterMs(res: Response): number | undefined {
  const v = res.headers.get('retry-after')
  if (!v) return undefined
  const ms = /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) * 1000 : Date.parse(v) - Date.now()
  return Number.isNaN(ms) ? undefined : Math.min(RETRY_AFTER_CAP_MS, Math.max(0, ms))
}

async function readCapped(res: Response): Promise<Buffer | null> {
  if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) {
    await res.body?.cancel().catch(() => {})
    return null
  }
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

const message = (err: unknown) => {
  const e = err as Error & { cause?: { code?: string; message?: string } }
  const cause = e?.cause?.code ?? e?.cause?.message
  return e?.name === 'TimeoutError' ? 'timed out after 30 s' : `${e?.message ?? String(err)}${cause ? ` (${cause})` : ''}`
}

/** GET with retries on network errors / 429 / 502 / 503 / 504 only; every other status is returned as is. */
export async function httpGet(ctx: NetCtx, url: string, opts: GetOptions): Promise<GetResult> {
  let current = new URL(url)
  const origin = current.host
  const hops: string[] = []
  let headers = { ...opts.headers }
  for (let redirects = 0; ; redirects++) {
    const res = await getOnce(ctx, current, headers, opts.label)
    if ('error' in res) return { ok: false, error: res.error, finalUrl: current.href, hops }
    const location = res.response.headers.get('location')
    if (!REDIRECT.has(res.response.status) || !location) {
      const body = await readCapped(res.response).catch((err) => err as Error)
      if (body instanceof Error) return fail(ctx, opts.label, current, `network error while reading the body: ${message(body)}`, hops)
      if (body === null) return fail(ctx, opts.label, current, 'the response is larger than 20 MB', hops)
      if (res.response.status >= 400) ctx.emit('fail', opts.label, `GET ${where(current)}: HTTP ${res.response.status}`)
      return { ok: true, status: res.response.status, headers: res.response.headers, body, finalUrl: current.href, hops }
    }
    await res.response.body?.cancel().catch(() => {})
    if (redirects >= MAX_REDIRECTS) return fail(ctx, opts.label, current, `more than ${MAX_REDIRECTS} redirects`, hops)
    let next: URL
    try {
      next = new URL(location, current)
    } catch {
      return fail(ctx, opts.label, current, `redirect to an invalid URL`, hops)
    }
    const refusal =
      next.protocol !== 'https:' && next.protocol !== 'http:'
        ? `redirect to a non-http(s) URL (${next.protocol})`
        : isLinkLocal(next.host)
          ? `redirect to a link-local or cloud-metadata address (${next.host})`
          : isPrivateHost(next.host) && !isPrivateHost(origin)
            ? `redirect from a public host to a private address (${next.host})`
            : (opts.allowHop?.(next) ?? null)
    if (refusal) return fail(ctx, opts.label, current, refusal, hops)
    if (next.host !== current.host) {
      const bound = new Set((opts.hostBound ?? []).map((h) => h.toLowerCase()))
      headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !bound.has(k.toLowerCase())))
    }
    hops.push(next.href)
    current = next
  }
}

function fail(ctx: NetCtx, label: string, url: URL, error: string, hops: string[]): GetResult {
  ctx.emit('fail', label, ctx.scrub(`GET ${where(url)}: ${error}`))
  return { ok: false, error: ctx.scrub(error), finalUrl: url.href, hops }
}

async function getOnce(ctx: NetCtx, url: URL, headers: Record<string, string>, label: string): Promise<{ response: Response } | { error: string }> {
  for (let attempt = 1; ; attempt++) {
    let response: Response
    try {
      response = await ctx.fetch(url.href, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (err) {
      const detail = ctx.scrub(`network error: ${message(err)}`)
      if (attempt >= MAX_ATTEMPTS) {
        ctx.emit('fail', label, `GET ${where(url)}: ${detail} (after ${attempt} attempts)`)
        return { error: `${detail} (after ${attempt} attempts)` }
      }
      const wait = backoff(attempt)
      ctx.emit('retry', label, `GET ${where(url)}: ${detail}; attempt ${attempt} of ${MAX_ATTEMPTS}, retrying in ${Math.round(wait)} ms`)
      await ctx.sleep(wait)
      continue
    }
    if (!RETRYABLE.has(response.status) || attempt >= MAX_ATTEMPTS) {
      if (RETRYABLE.has(response.status)) ctx.emit('fail', label, `GET ${where(url)}: HTTP ${response.status} (after ${attempt} attempts)`)
      return { response }
    }
    await response.body?.cancel().catch(() => {})
    const wait = retryAfterMs(response) ?? backoff(attempt)
    ctx.emit('retry', label, `GET ${where(url)}: HTTP ${response.status}; attempt ${attempt} of ${MAX_ATTEMPTS}, retrying in ${Math.round(wait)} ms`)
    await ctx.sleep(wait)
  }
}

// ── a plain URL ────────────────────────────────────────────────────────────────────────────────

export interface WebCtx extends NetCtx {
  which: (bin: string) => string | null
  transcribe: boolean
  /** A scratch directory removed when ingest finishes (downloaded PDFs and images wait there). */
  tempDir: () => Promise<string>
}

export type WebResult = { draft: Draft } | { pending: PendingTranscription } | { needsAccess: Observation }

const SIGN_IN = /(?:^|[./-])(?:login|log-in|signin|sign-in|sso|auth|oauth|accounts?|idp)(?:[./-]|$)/i

/** The link has no user:password@ part (it would be stored in the manifest and the corpus). */
export function assertNoUserInfo(url: URL): void {
  if (url.username || url.password) {
    throw new SourceError(
      'the link has a user name or password embedded in it, which this tool never stores or sends.',
      ['Pass the link without the user:password@ part; if the content needs a credential, put it in an environment variable and allow it with --grant VAR=host.'],
      'credentials in the URL',
    )
  }
}

/** Title for a URL with no better one: the last path segment, else the host. */
const urlTitle = (u: URL) => titleFromFileName(decodeURIComponent(u.pathname.split('/').filter(Boolean).at(-1) ?? '') || u.host)

/** One GET of a URL, parsed by content type. Unreadable responses come back as an Observation for the access agent. */
export async function readWebUrl(url: string, ctx: WebCtx): Promise<WebResult> {
  const u = new URL(url)
  assertNoUserInfo(u)
  const r = await httpGet(ctx, url, { label: 'web' })
  if (!r.ok) {
    if (/larger than 20 MB/.test(r.error)) throw new SourceError('the response is larger than 20 MB, so it was not read.', FIX.tooLarge, r.error)
    throw new SourceError(`${u.host} could not be reached (${r.error}).`, FIX.network(u.host), r.error)
  }
  const final = new URL(r.finalUrl)
  const ct = (r.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  const date = r.headers.get('last-modified') ? dayOf(new Date(r.headers.get('last-modified')!)) : undefined
  const validDate = date && !date.startsWith('NaN') ? date : undefined
  const observe = (summary: string, extra: Partial<Observation> = {}): WebResult => ({
    needsAccess: { summary, status: r.status, finalUrl: r.finalUrl, contentType: ct || undefined, ...extra },
  })
  const redirected = r.hops.length ? ` after redirects to ${where(final)}` : ''
  if (r.status >= 500 || r.status === 429) {
    throw new SourceError(`${u.host} answered HTTP ${r.status} on every attempt.`, FIX.network(u.host), `HTTP ${r.status}${redirected}`)
  }
  if (r.status >= 300) return observe(`HTTP ${r.status} from ${final.host}${redirected}`, { textPreview: previewOf(r.body, ct) })
  const draft = (content: string, title: string | undefined, kind: Draft['kind'] = 'web'): WebResult => ({
    draft: { kind, title: title?.trim() || urlTitle(u), content, origin: url, name: slugify(title?.trim() || urlTitle(u)), via: 'public URL', ...(validDate ? { date: validDate } : {}) },
  })

  if (ct === 'text/html' || ct === 'application/xhtml+xml' || (!ct && /^\s*</.test(r.body.subarray(0, 64).toString('latin1')))) {
    const h = htmlToMarkdown(r.body.toString('utf8'))
    const preview = { title: h.title, textPreview: h.text.slice(0, 1500) }
    if ((r.hops.length && SIGN_IN.test(`${final.host}${final.pathname}`)) || (h.passwordField && h.text.length < 3000)) {
      return observe(`HTTP ${r.status}${redirected}: a sign-in page`, preview)
    }
    if (h.text.replace(/\s+/g, '').length < 200 && h.scripts) {
      return observe(`HTTP ${r.status} text/html with ${h.text.replace(/\s+/g, '').length} characters of text and <script> elements: the page renders in the browser`, preview)
    }
    return draft(h.text, h.title)
  }
  if (ct === 'text/plain' || ct === 'text/markdown' || ct === 'text/x-markdown' || ct === 'text/csv') {
    const text = decodeText(r.body)
    if (text === null) return observe(`HTTP ${r.status} ${ct} that is not UTF-8 text`)
    return draft(text, firstHeading(text))
  }
  if (ct === 'application/json' || ct.endsWith('+json')) {
    try {
      return draft('```json\n' + JSON.stringify(JSON.parse(r.body.toString('utf8')), null, 2) + '\n```', undefined)
    } catch {
      return observe(`HTTP ${r.status} ${ct} that does not parse as JSON`, { textPreview: previewOf(r.body, ct) })
    }
  }
  if (ct === 'application/pdf' || r.body.subarray(0, 5).toString('latin1') === '%PDF-') return readPdfBody(r.body, url, u, validDate, ctx)
  if (ct.startsWith('image/') && imageMediaType(r.body.subarray(0, 16))) {
    if (!ctx.transcribe) throw new SourceError('images are read only with --transcribe (Claude reads the image), which this run did not enable.', FIX.image, `HTTP ${r.status} ${ct}`)
    const file = await saveTemp(ctx, r.body, 'image')
    return { pending: { abs: file, kind: 'image', meta: { kind: 'web', title: urlTitle(u), origin: url, name: slugify(urlTitle(u)), via: 'public URL' } } }
  }
  return observe(`HTTP ${r.status} with content type ${ct || '(none)'}, which the format layer cannot parse`)
}

async function readPdfBody(body: Buffer, url: string, u: URL, date: string | undefined, ctx: WebCtx): Promise<WebResult> {
  const file = await saveTemp(ctx, body, 'pdf')
  const meta = { kind: 'web' as const, title: urlTitle(u), origin: url, name: slugify(urlTitle(u)), via: 'public URL', ...(date ? { date } : {}) }
  const pages = await pdfPages(file, ctx.which)
  if (pages && hasTextLayer(pages)) return { draft: { ...meta, content: pagesToMarkdown(pages) } }
  if (ctx.transcribe) return { pending: { abs: file, kind: 'pdf', meta } }
  if (!pages) throw new SourceError("pdftotext is not installed, so the PDF's text cannot be extracted.", FIX.pdftotext, 'pdftotext not on PATH')
  throw new SourceError('this PDF has no text layer (probably scanned), so there is no text to extract.', FIX.scannedPdf, `pdftotext found ${pages.join('').replace(/\s+/g, '').length} characters`)
}

let tempCount = 0
async function saveTemp(ctx: WebCtx, body: Buffer, ext: string): Promise<string> {
  const file = path.join(await ctx.tempDir(), `download-${++tempCount}.${ext}`)
  await fs.writeFile(file, body)
  return file
}

function previewOf(body: Buffer, ct: string): string | undefined {
  const text = decodeText(body)
  if (text === null) return undefined
  return (ct.includes('html') || /^\s*</.test(text) ? htmlToMarkdown(text).text : text).slice(0, 1500)
}

// ── git remotes ────────────────────────────────────────────────────────────────────────────────

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }

/** https (no user info) or ssh; file:// only behind the test seam. Never starts with "-". */
export function gitUrlAllowed(url: string, allowFile = false): boolean {
  if (url.startsWith('-')) return false
  if (isSshGitUrl(url)) return true
  if (allowFile && /^file:\/\/\//.test(url)) return true
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && !u.username && !u.password && !u.host.startsWith('-')
  } catch {
    return false
  }
}

/** True when `git ls-remote` reaches a repository at `url` within 20 s. */
export async function isGitRemote(git: string, url: string): Promise<{ ok: boolean; detail: string }> {
  const r = await run(git, ['ls-remote', '--exit-code', '--', url], { timeout: 20_000, env: GIT_ENV, maxBuffer: 4 * 1024 * 1024 })
  return { ok: r.ok, detail: r.ok ? 'git ls-remote succeeded' : r.stderr.trim().split('\n')[0] || `git ls-remote exit ${r.code}` }
}

/** Directory name for a clone: a slug of host + path. */
export function cloneDirName(url: string): string {
  const scp = /^[^@]+@([^:]+):(.*)$/.exec(url)
  if (scp && !url.includes('://')) return `git-${slugify(`${scp[1]}/${scp[2]}`.replace(/\.git$/, ''), 80)}`
  const u = new URL(url)
  return `git-${slugify(`${u.host}${u.pathname}`.replace(/\.git\/?$/, ''), 80)}`
}

/** Shallow clone into cloneDir, or refresh an existing clone to the remote's HEAD. Returns the directory. */
export async function cloneOrRefresh(git: string, url: string, cloneDir: string): Promise<string> {
  const dir = path.join(cloneDir, cloneDirName(url))
  const opts = { timeout: 300_000, env: GIT_ENV }
  if (existsSync(dir)) {
    const fetched = await run(git, ['-C', dir, 'fetch', '--depth', '1', '--quiet', 'origin'], opts)
    const reset = fetched.ok ? await run(git, ['-C', dir, 'reset', '--hard', '--quiet', 'FETCH_HEAD'], opts) : fetched
    if (!reset.ok) throw new SourceError(`git could not refresh the existing clone at ${dir}.`, [...FIX.gitRemote(url), `Or delete ${dir} and retry.`], reset.stderr.trim().split('\n')[0])
    return dir
  }
  await fs.mkdir(cloneDir, { recursive: true })
  const r = await run(git, ['clone', '--depth', '1', '--quiet', '--', url, dir], opts)
  if (!r.ok) throw new SourceError('git could not clone it.', FIX.gitRemote(url), r.stderr.trim().split('\n')[0] || `git clone exit ${r.code}`)
  return dir
}
