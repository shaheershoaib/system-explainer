// @vitest-environment node
import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { detectSource } from './detect'
import { defaultWhich, ingest, type IngestEvent, type IngestOptions } from './index'
import { cloneDirName, gitUrlAllowed, httpGet, type NetCtx } from './remote'

const tmp: string[] = []
const scratch = (label: string) => {
  const d = mkdtempSync(path.join(tmpdir(), `ingest-remote-${label}-`))
  tmp.push(d)
  return d
}
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true })
})

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>
function fakeFetch(handler: Handler) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()) })
    return handler(url, init)
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

const html = (body: string, headers: Record<string, string> = {}, status = 200) => new Response(`<html><head><title>T</title></head><body>${body}</body></html>`, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } })
const LONG = '<p>' + 'The release train leaves every Tuesday at noon. '.repeat(8) + '</p>'

function web(handler: Handler, extra: Partial<IngestOptions> = {}) {
  const f = fakeFetch(handler)
  const events: IngestEvent[] = []
  const sleeps: number[] = []
  const dir = scratch('web')
  const run = ingest({
    sources: ['https://docs.example.test/guide'],
    corpusDir: path.join(dir, 'corpus'),
    fetch: f.fetch,
    which: () => null,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    onEvent: (e) => events.push(e),
    now: () => new Date('2026-10-10T12:00:00Z'),
    ...extra,
  })
  return { run, calls: f.calls, events, sleeps, dir }
}

describe('plain URLs', () => {
  it('reads an HTML page into a web doc dated by Last-Modified', async () => {
    const w = web(() => html(`<h1>Guide</h1>${LONG}<!-- hidden note to an AI -->`, { 'last-modified': 'Wed, 16 Sep 2026 08:00:00 GMT' }))
    const res = await w.run
    expect(res.problems).toEqual([])
    expect(res.manifest.docs[0]).toMatchObject({ kind: 'web', title: 'T', origin: 'https://docs.example.test/guide', date: '2026-09-16', via: 'public URL' })
    const text = readFileSync(path.join(w.dir, 'corpus', res.manifest.docs[0].path), 'utf8')
    expect(text).toContain('# Guide\n\nThe release train')
    expect(text).not.toContain('hidden note')
    expect(w.calls).toHaveLength(1)
    expect(w.calls[0].url).toBe('https://docs.example.test/guide')
  })

  it('a 403 without the access agent is a problem stating what was observed, with generic fixes', async () => {
    const w = web(() => html('<p>Forbidden</p>', {}, 403))
    const res = await w.run
    expect(w.calls).toHaveLength(1)
    expect(res.problems[0]).toMatchObject({ kind: 'web', observed: 'HTTP 403 from docs.example.test' })
    expect(res.problems[0].why).toMatch(/HTTP 403 from docs\.example\.test.*needs the access agent/)
    expect(res.problems[0].fixes[0]).toMatch(/ANTHROPIC_API_KEY/)
    expect(res.problems[0].fixes.join(' ')).toMatch(/export the content to a file/)
    expect(res.manifest.sources[0]).toMatchObject({ status: 'unreachable', docs: [] })
  })

  it('a JavaScript-only shell is handed on as "renders in the browser"', async () => {
    const res = await web(() => html('<div id="root"></div><script src="/app.js"></script>')).run
    expect(res.problems[0].observed).toMatch(/<script> elements: the page renders in the browser/)
  })

  it('a redirect to a sign-in page is recognized as such', async () => {
    const w = web((url) =>
      url === 'https://docs.example.test/guide' ? new Response(null, { status: 302, headers: { location: 'https://sso.example.test/login?next=/guide' } }) : html('<form><input type="password" name="p"></form>'),
    )
    const res = await w.run
    expect(w.calls.map((c) => c.url)).toEqual(['https://docs.example.test/guide', 'https://sso.example.test/login?next=/guide'])
    expect(res.problems[0].observed).toMatch(/a sign-in page/)
  })

  it('retries 503 with backoff and 429 honoring Retry-After, then succeeds; one event per retry', async () => {
    let n = 0
    const w = web(() => (++n === 1 ? new Response('busy', { status: 503 }) : n === 2 ? new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }) : html(LONG)))
    const res = await w.run
    expect(res.problems).toEqual([])
    expect(w.calls).toHaveLength(3)
    expect(w.sleeps[0]).toBeLessThan(1000)
    expect(w.sleeps[1]).toBe(2000)
    expect(w.events.filter((e) => e.type === 'retry').map((e) => e.label)).toEqual(['web', 'web'])
  })

  it('gives up after 3 network failures with a problem and a fail event; never retries a 404', async () => {
    const down = web(() => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
    })
    const res = await down.run
    expect(down.calls).toHaveLength(3)
    expect(res.problems[0].why).toMatch(/docs\.example\.test could not be reached \(network error: fetch failed \(ECONNREFUSED\) \(after 3 attempts\)\)/)
    expect(down.events.filter((e) => e.type === 'retry')).toHaveLength(2)
    expect(down.events.filter((e) => e.type === 'fail')).toHaveLength(1)

    const missing = web(() => new Response('nope', { status: 404 }))
    await missing.run
    expect(missing.calls).toHaveLength(1)
  })

  it('refuses a response over 20 MB', async () => {
    const res = await web(() => new Response('x', { headers: { 'content-type': 'text/plain', 'content-length': String(21 * 1024 * 1024) } })).run
    expect(res.problems[0].why).toMatch(/larger than 20 MB/)
  })

  it('reads text and markdown as is, and refuses a link with user:password@ in it', async () => {
    const md = await web(() => new Response('# Notes\n\nplain markdown body\n', { headers: { 'content-type': 'text/markdown' } })).run
    expect(md.manifest.docs[0]).toMatchObject({ title: 'Notes', kind: 'web' })
    const secret = await web(() => html(LONG), { sources: ['https://me:hunter2@docs.example.test/x'] }).run
    expect(secret.problems[0].why).toMatch(/user name or password embedded/)
    expect(secret.problems[0].source).toBe('https://[redacted]@docs.example.test/x')
    expect(JSON.stringify([secret.manifest, secret.problems])).not.toContain('hunter2')
  })
})

describe('httpGet redirects', () => {
  const ctx = (fetch: typeof globalThis.fetch): NetCtx => ({ fetch, sleep: async () => {}, emit: () => {}, scrub: (s) => s })

  it('drops host-bound headers when a redirect leaves the host, and keeps them on the same host', async () => {
    const f = fakeFetch((url) =>
      url === 'https://a.test/1'
        ? new Response(null, { status: 302, headers: { location: '/2' } })
        : url === 'https://a.test/2'
          ? new Response(null, { status: 307, headers: { location: 'https://b.test/3' } })
          : new Response('ok'),
    )
    const r = await httpGet(ctx(f.fetch), 'https://a.test/1', { label: 't', headers: { 'X-Api-Key': 'k', Accept: 'text/plain' }, hostBound: ['x-api-key'] })
    expect(r.ok && r.finalUrl).toBe('https://b.test/3')
    expect(f.calls.map((c) => c.headers['x-api-key'])).toEqual(['k', 'k', undefined])
    expect(f.calls[2].headers.accept).toBe('text/plain')
  })

  it('refuses redirects to link-local / metadata addresses and from public hosts to private ones', async () => {
    const meta = await httpGet(ctx(fakeFetch(() => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } })).fetch), 'https://a.test/', { label: 't' })
    expect(!meta.ok && meta.error).toMatch(/link-local/)
    const priv = await httpGet(ctx(fakeFetch(() => new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/admin' } })).fetch), 'https://a.test/', { label: 't' })
    expect(!priv.ok && priv.error).toMatch(/public host to a private address/)
  })
})

describe('detection', () => {
  const cwd = scratch('detect')
  mkdirSync(path.join(cwd, 'docs'))
  mkdirSync(path.join(cwd, 'app', '.git'), { recursive: true })
  writeFileSync(path.join(cwd, 'docs', 'a.md'), 'x')

  it('maps arguments to format-level kinds only', () => {
    const kind = (raw: string) => detectSource(raw, cwd).kind
    expect(kind('docs')).toBe('folder')
    expect(kind('app')).toBe('repo')
    expect(kind('docs/a.md')).toBe('markdown')
    expect(kind('https://example.test/page')).toBe('web')
    expect(detectSource('example.test/page/1', cwd)).toMatchObject({ kind: 'web', target: 'https://example.test/page/1' })
    expect(kind('git@git.example.test:team/app.git')).toBe('git-remote')
    expect(kind('ssh://git@git.example.test/team/app.git')).toBe('git-remote')
    expect(detectSource('./missing.md', cwd)).toMatchObject({ kind: 'unknown', target: path.join(cwd, 'missing.md') })
    expect(detectSource("the Q3 planning doc", cwd)).toMatchObject({ kind: 'unknown', target: 'the Q3 planning doc' })
    expect(detectSource('meetings: last week', cwd)).toMatchObject({ kind: 'unknown', target: 'meetings: last week' })
    expect(detectSource(pathToFileURL(path.join(cwd, 'docs')).href, cwd)).toMatchObject({ kind: 'folder' })
  })
})

describe('git remotes', () => {
  it('accepts https and ssh forms only; never an option, user info, or file:// outside the test seam', () => {
    expect(gitUrlAllowed('https://git.example.test/team/app.git')).toBe(true)
    expect(gitUrlAllowed('git@git.example.test:team/app.git')).toBe(true)
    expect(gitUrlAllowed('ssh://git@git.example.test/team/app.git')).toBe(true)
    expect(gitUrlAllowed('https://git.example.test/a/b;rm -rf')).toBe(true) // passed as one argv element after "--", never through a shell
    expect(gitUrlAllowed('--upload-pack=touch /tmp/pwned')).toBe(false)
    expect(gitUrlAllowed('-c protocol.ext.allow=always')).toBe(false)
    expect(gitUrlAllowed('ext::sh -c touch% /tmp/pwned')).toBe(false)
    expect(gitUrlAllowed('http://git.example.test/a/b')).toBe(false)
    expect(gitUrlAllowed('https://user:token@git.example.test/a/b')).toBe(false)
    expect(gitUrlAllowed('file:///tmp/repo')).toBe(false)
    expect(gitUrlAllowed('file:///tmp/repo', true)).toBe(true)
    expect(cloneDirName('https://git.example.test/Team/App.git')).toBe('git-git-example-test-team-app')
    expect(cloneDirName('git@git.example.test:team/app.git')).toBe('git-git-example-test-team-app')
  })

  it('an option-shaped argument never reaches git: it is a reference, and without the access agent a problem', async () => {
    const dir = scratch('opt')
    const res = await ingest({ sources: ['--upload-pack=touch'], corpusDir: path.join(dir, 'corpus'), cwd: dir, which: () => '/usr/bin/false', fetch: (() => Promise.reject(new Error('no'))) as typeof fetch })
    expect(res.problems[0]).toMatchObject({ kind: 'unknown', observed: 'not an existing path or a URL' })
  })

  it.skipIf(!defaultWhich('git'))('clones a remote that git ls-remote accepts (file:// behind the test seam), then refreshes it', async () => {
    const origin = scratch('origin')
    const git = (...args: string[]) => execFileSync('git', ['-C', origin, ...args], { stdio: 'pipe' })
    git('init', '--quiet', '-b', 'main')
    writeFileSync(path.join(origin, 'app.ts'), 'export const seats = 5\n')
    git('add', '.')
    git('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '--quiet', '-m', 'init')
    const dir = scratch('clone')
    const url = pathToFileURL(origin).href
    const opts = { sources: [url], corpusDir: path.join(dir, 'corpus'), cloneDir: path.join(dir, 'sources'), allowFileGitUrlsForTests: true }
    const first = await ingest(opts)
    expect(first.problems).toEqual([])
    expect(first.mode).toBe('code')
    expect(first.repo).toBe(path.join(dir, 'sources', cloneDirName(url)))
    expect(readFileSync(path.join(first.repo!, 'app.ts'), 'utf8')).toContain('seats = 5')
    expect(first.manifest.sources[0]).toMatchObject({ kind: 'git-remote', status: 'ok' })

    writeFileSync(path.join(origin, 'app.ts'), 'export const seats = 6\n')
    git('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '--quiet', '-am', 'bump')
    const second = await ingest(opts)
    expect(readFileSync(path.join(second.repo!, 'app.ts'), 'utf8')).toContain('seats = 6')

    const notARepo = await ingest({ ...opts, sources: [pathToFileURL(scratch('empty')).href] })
    expect(notARepo.problems[0]).toMatchObject({ kind: 'git-remote', why: 'git could not reach a repository at that address.' })
    expect(existsSync(path.join(dir, 'corpus', 'manifest.json'))).toBe(true)
  })
})
