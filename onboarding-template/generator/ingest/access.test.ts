// @vitest-environment node
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import { createFakeClient } from '../llm/fake'
import type { LlmClient } from '../llm/client'
import { ACCESS_SYSTEM, createAccessRuntime, type AccessRuntimeOptions, type ExtractionSpec, type ManifestSourceWithRecipe } from './access'
import { createFakeAccessPlayer } from './fake-access'
import { ingest, type IngestEvent, type IngestOptions } from './index'
import type { CredentialGrant } from './types'

type Params = Anthropic.MessageCreateParamsNonStreaming

const TOKEN = 'tok_fixture_9f8e7d6c5b4a3928'
const API = 'https://api.fixture.test/pages/42'
const GRANT: CredentialGrant = { env: 'FIXTURE_TOKEN', host: 'api.fixture.test' }
const PAGE = {
  title: 'Q3 planning',
  updated_at: '2026-09-30T17:00:00.000Z',
  markdown: '# Q3 planning\n\nThe free tier goes to 5 seats from October 1.\n\n- Owner: Dana\n- Billing change: Sam\n',
  echo: `auth ${TOKEN}`,
}
const NOW = new Date('2026-10-10T12:00:00.000Z')

const tmp: string[] = []
const scratch = (label: string) => {
  const d = mkdtempSync(path.join(tmpdir(), `ingest-access-${label}-`))
  tmp.push(d)
  return d
}
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true })
})

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

function fakeFetch(handler: (url: string, headers: Headers) => Response) {
  const calls: { url: string; auth: string | null }[] = []
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    calls.push({ url: String(input), auth: headers.get('authorization') })
    return handler(String(input), headers)
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

/** The fixture API: the page with the right bearer token, a 401 otherwise. */
const fixtureApi = (page: unknown = PAGE) =>
  fakeFetch((url, headers) => (url === API && headers.get('authorization') === `Bearer ${TOKEN}` ? json(200, page) : url === API ? json(401, { code: 'unauthorized', message: 'API token is invalid.' }) : json(404, {})))

function playerClient() {
  const seen: Params[] = []
  const player = createFakeAccessPlayer()
  const client = createFakeClient((i, p) => {
    seen.push(p)
    return player(i, p)
  })
  return { client, seen }
}

const throwingClient: LlmClient = {
  complete: async () => {
    throw new Error('the model must not be called')
  },
}

function run(fetch: typeof globalThis.fetch, extra: Partial<IngestOptions> = {}) {
  const dir = extra.corpusDir ? path.dirname(extra.corpusDir) : scratch('run')
  const events: IngestEvent[] = []
  const done = ingest({
    sources: [API],
    corpusDir: path.join(dir, 'corpus'),
    env: { FIXTURE_TOKEN: TOKEN, HOME: '/home/x' },
    fetch,
    which: () => null,
    sleep: async () => {},
    now: () => NOW,
    onEvent: (e) => events.push(e),
    ...extra,
  })
  return { done, events, dir }
}

const corpusFiles = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((f) => path.join(dir, f))
    .filter((f) => statSync(f).isFile())
    .map((f) => readFileSync(f, 'utf8'))

describe('access agent: credentials and grants', () => {
  it('with a grant, reaches the API with the named credential and extracts the JSON field verbatim', async () => {
    const api = fixtureApi()
    const { client, seen } = playerClient()
    const r = run(api.fetch, { access: { client, model: 'claude-opus-5', grants: [GRANT] } })
    const res = await r.done

    expect(res.problems).toEqual([])
    expect(api.calls).toEqual([
      { url: API, auth: null },
      { url: API, auth: `Bearer ${TOKEN}` },
    ])
    const doc = res.manifest.docs[0]
    expect(doc).toMatchObject({ kind: 'remote', title: 'Q3 planning', date: '2026-09-30', service: 'Fixture API', via: 'fixture API using FIXTURE_TOKEN', origin: API })
    expect(readFileSync(path.join(r.dir, 'corpus', doc.path), 'utf8').split('---\n\n')[1]).toBe(PAGE.markdown)
    const source = res.manifest.sources[0] as ManifestSourceWithRecipe
    expect(source).toMatchObject({ raw: API, kind: 'web', status: 'ok', docs: [doc.path] })
    expect(source.recipe).toEqual({
      requests: [{ id: 'r1', url: API, credential: { env: 'FIXTURE_TOKEN', header: 'Authorization', prefix: 'Bearer ' } }],
      docs: [{ title: 'Q3 planning', service: 'Fixture API', via: 'fixture API using FIXTURE_TOKEN', origin: API, date: '2026-09-30', parts: [{ responses: ['r1'], as: 'markdown', path: 'markdown' }] }],
      service: 'Fixture API',
    })
    expect(res.grantsUsed).toEqual([GRANT])
    expect(res.usage).toEqual({ input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })

    // what the agent was told: the role line, the source, the observation, credential NAMES, grants
    expect(String(seen[0].system).startsWith('ROLE: access\n')).toBe(true)
    const task = seen[0].messages[0].content as string
    expect(task).toMatch(/^SOURCE: https:\/\/api\.fixture\.test\/pages\/42\n/)
    expect(task).toContain('HTTP 401 from api.fixture.test')
    expect(task).toContain('credential-looking environment variables (names only): FIXTURE_TOKEN')
    expect(task).toContain('grants (variable -> host it may be sent to): FIXTURE_TOKEN -> api.fixture.test')
  })

  it('without a grant, the tool says it is not granted and the source is unreachable with a --grant fix', async () => {
    const api = fixtureApi()
    const { client, seen } = playerClient()
    const res = await run(api.fetch, { access: { client, model: 'claude-opus-5', grants: [] } }).done
    expect(api.calls.map((c) => c.auth)).toEqual([null])
    const toolResult = (seen[1].messages[2].content as Anthropic.ToolResultBlockParam[])[0]
    expect(toolResult).toMatchObject({ type: 'tool_result', is_error: true })
    expect(toolResult.content).toMatch(/^not granted: FIXTURE_TOKEN may be sent only to a host the user granted.*--grant FIXTURE_TOKEN=api\.fixture\.test\.$/)
    expect(res.problems).toHaveLength(1)
    expect(res.problems[0]).toMatchObject({ source: API, kind: 'web' })
    expect(res.problems[0].fixes[0]).toContain('--grant FIXTURE_TOKEN=api.fixture.test')
    expect(res.grantsUsed).toEqual([])
  })

  it('asks interactively when a confirm hook is given, and records the new grant as used', async () => {
    const api = fixtureApi()
    const { client } = playerClient()
    const questions: string[] = []
    const res = await run(api.fetch, {
      access: { client, model: 'claude-opus-5', grants: [], confirm: async (q) => (questions.push(q), true) },
    }).done
    expect(questions).toEqual([`Send FIXTURE_TOKEN to api.fixture.test to read ${API}? [y/N]`])
    expect(res.problems).toEqual([])
    expect(res.grantsUsed).toEqual([GRANT])
  })

  it('never lets the credential value reach a tool result, event, problem, manifest, corpus file or transcript', async () => {
    const api = fixtureApi()
    const { client, seen } = playerClient()
    const dir = scratch('leak')
    const transcriptDir = path.join(dir, 'transcripts')
    const r = run(api.fetch, { corpusDir: path.join(dir, 'corpus'), access: { client, model: 'claude-opus-5', grants: [GRANT], transcriptDir } })
    const ok = await r.done
    const denied = await run(fixtureApi().fetch, { access: { client: playerClient().client, model: 'claude-opus-5', grants: [] } }).done
    const everything = [JSON.stringify(seen), JSON.stringify(r.events), JSON.stringify(ok), JSON.stringify(denied), ...corpusFiles(path.join(dir, 'corpus')), ...corpusFiles(transcriptDir)].join('\n')
    expect(everything).not.toContain(TOKEN)
    // the API echoed the token in its body: the preview the model saw has it redacted
    expect(JSON.stringify(seen)).toContain('auth [redacted]')
  })
})

describe('access runtime', () => {
  const runtime = (fetch: typeof globalThis.fetch, grants: CredentialGrant[] = [{ env: 'T', host: 'a.test' }], extra: Partial<AccessRuntimeOptions> = {}) =>
    createAccessRuntime({
      net: { fetch, sleep: async () => {}, emit: () => {}, scrub: (s) => s.split(TOKEN).join('[redacted]') },
      env: { T: TOKEN },
      grants,
      used: [],
      which: () => null,
      tempDir: async () => scratch('rt'),
      source: 'src',
      ...extra,
    })
  const CRED = { env: 'T', header: 'Authorization', prefix: 'Bearer ' }

  it('taint rule: after a credentialed response, only granted hosts can be reached (also through redirects)', async () => {
    const f = fakeFetch((url) => (url === 'https://a.test/redirect' ? new Response(null, { status: 302, headers: { location: 'https://b.test/collect' } }) : json(200, { ok: url })))
    const rt = runtime(f.fetch)
    expect((await rt.get({ url: 'https://b.test/before' })).ok).toBe(true)
    expect((await rt.get({ url: 'https://a.test/data', credential: CRED })).ok).toBe(true)
    expect(rt.tainted).toBe(true)
    const after = await rt.get({ url: 'https://b.test/after?copy=secret-content' })
    expect(after).toMatchObject({ ok: false })
    expect(!after.ok && after.error).toMatch(/^refused: a credentialed response was already read.*b\.test has no grant/)
    const viaTool = await rt.sandbox.execute('http_get', { url: 'https://b.test/x' })
    expect(viaTool.is_error).toBe(true)
    const hop = await rt.get({ url: 'https://a.test/redirect' })
    expect(!hop.ok && hop.error).toMatch(/redirect to b\.test, which has no grant/)
    expect(f.calls.map((c) => c.url)).toEqual(['https://b.test/before', 'https://a.test/data', 'https://a.test/redirect'])
  })

  it('rejects Authorization / Cookie / Host headers, plain http, user info, metadata and private addresses, without fetching', async () => {
    const f = fakeFetch(() => json(200, {}))
    const rt = runtime(f.fetch)
    for (const name of ['Authorization', 'cookie', 'Proxy-Authorization', 'Host']) {
      const r = await rt.sandbox.execute('http_get', { url: 'https://a.test/x', headers: [{ name, value: 'x' }] })
      expect(r.is_error).toBe(true)
      expect(r.content).toMatch(/may not be set directly/)
    }
    expect((await rt.sandbox.execute('http_get', { url: 'http://a.test/x' })).content).toMatch(/only https/)
    expect((await rt.sandbox.execute('http_get', { url: 'https://u:p@a.test/x' })).content).toMatch(/user:password/)
    expect((await rt.sandbox.execute('http_get', { url: 'https://169.254.169.254/latest' })).content).toMatch(/cloud-metadata/)
    expect((await rt.sandbox.execute('http_get', { url: 'http://localhost:8080/x' })).content).toMatch(/only when the source itself is on one/)
    expect((await rt.sandbox.execute('http_get', { url: 'https://10.1.2.3/admin' })).is_error).toBe(true)
    expect(f.calls).toHaveLength(0)
    const local = runtime(f.fetch, [], { source: 'http://localhost:8080/app' })
    expect((await local.sandbox.execute('http_get', { url: 'http://localhost:8080/x' })).is_error).toBeUndefined()
  })

  it('the credential goes only to its granted host and is dropped on a cross-host redirect', async () => {
    const f = fakeFetch((url) => (url === 'https://a.test/go' ? new Response(null, { status: 302, headers: { location: 'https://a.test/final' } }) : json(200, { url })))
    const rt = runtime(f.fetch, [
      { env: 'T', host: 'a.test' },
      { env: 'T', host: 'c.test' },
    ])
    const denied = await rt.get({ url: 'https://b.test/x', credential: CRED })
    expect(denied).toMatchObject({ ok: false, notGranted: { env: 'T', host: 'b.test' } })
    await rt.get({ url: 'https://a.test/go', credential: CRED })
    expect(f.calls.map((c) => c.auth)).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`])
    const g = fakeFetch((url) => (url === 'https://a.test/out' ? new Response(null, { status: 302, headers: { location: 'https://c.test/in' } }) : json(200, {})))
    await runtime(g.fetch, [
      { env: 'T', host: 'a.test' },
      { env: 'T', host: 'c.test' },
    ]).get({ url: 'https://a.test/out', credential: CRED })
    expect(g.calls.map((c) => [c.url, c.auth])).toEqual([
      ['https://a.test/out', `Bearer ${TOKEN}`],
      ['https://c.test/in', null],
    ])
  })

  it('tool results show the id, status, final URL, content type and a scrubbed, pretty-printed preview', async () => {
    const rt = runtime(fakeFetch(() => json(200, { a: 1, note: `echo ${TOKEN}` })).fetch)
    const r = await rt.sandbox.execute('http_get', { url: 'https://a.test/data', credential: CRED })
    expect(r.content).toBe(
      ['id: r1', 'status: 200', 'final URL: https://a.test/data', 'content type: application/json', `bytes: ${JSON.stringify({ a: 1, note: `echo ${TOKEN}` }).length}`, 'body (first 6000 characters, JSON pretty-printed):', '{\n  "a": 1,\n  "note": "echo [redacted]"\n}'].join('\n'),
    )
    expect((await rt.sandbox.execute('which', { bin: 'definitely-not-installed' })).content).toBe('definitely-not-installed is not on PATH')
  })
})

describe('extraction specs', () => {
  const PAGE1 = { meeting: { title: 'Pricing sync', start: '2026-09-16T15:00:00Z' }, items: [{ at: '00:00:01', speaker: { name: 'Dana' }, text: 'We move to 5 seats.' }, { at: '00:00:09', speaker: {}, text: 'Agreed.' }], paragraphs: ['First.', 'Second.'], empty: '' }
  const PAGE2 = { items: [{ at: '00:01:00', speaker: { name: 'Sam' }, text: 'Billing\nupdated.' }] }
  async function loaded() {
    const f = fakeFetch((url) => (url.endsWith('/p1') ? json(200, PAGE1) : url.endsWith('/p2') ? json(200, PAGE2) : json(404, { error: 'not found' })))
    const rt = createAccessRuntime({ net: { fetch: f.fetch, sleep: async () => {}, emit: () => {}, scrub: (s) => s }, env: {}, grants: [], used: [], which: () => null, tempDir: async () => scratch('ex'), source: 'https://a.test/m' })
    await rt.get({ url: 'https://a.test/m/p1' })
    await rt.get({ url: 'https://a.test/m/p2' })
    await rt.get({ url: 'https://a.test/m/missing' })
    return rt
  }
  const spec = (over: Partial<ExtractionSpec> = {}): ExtractionSpec => ({
    title: 'Pricing sync',
    via: 'test API',
    origin: 'https://a.test/m/p1',
    parts: [{ responses: ['r1', 'r2'], as: 'text', each: 'items', template: '[{at}] {speaker.name}: {text}', heading: 'Transcript' }],
    ...over,
  })

  it('renders each + template across paginated responses, verbatim, and keeps verified metadata', async () => {
    const rt = await loaded()
    const r = await rt.extract([spec({ date: '2026-09-16', speakers: ['Dana', 'Sam', 'Zed'], service: 'Test' })])
    expect(r.errors).toEqual([])
    expect(r.drafts[0]).toMatchObject({ kind: 'remote', title: 'Pricing sync', date: '2026-09-16', speakers: ['Dana', 'Sam'], service: 'Test', via: 'test API', origin: 'https://a.test/m/p1' })
    expect(r.drafts[0].content).toBe('## Transcript\n\n[00:00:01] Dana: We move to 5 seats.\n[00:00:09] : Agreed.\n[00:01:00] Sam: Billing updated.')
    expect(r.notes).toEqual(['doc "Pricing sync": speakers not found verbatim in a response were dropped'])
    expect(rt.recipe(r.specs).requests.map((q) => q.id)).toEqual(['r1', 'r2'])
  })

  it('drops an invented title and date; joins string arrays; rejects worded templates, empty and non-string selections, failed responses', async () => {
    const rt = await loaded()
    const r = await rt.extract([
      spec({ title: 'Board minutes', date: '2026-01-01', origin: 'https://elsewhere.test/', parts: [{ responses: ['r1'], as: 'markdown', path: 'paragraphs' }] }),
      spec({ title: 'worded', parts: [{ responses: ['r1'], as: 'text', each: 'items', template: '{speaker.name} said: {text}' }] }),
      spec({ title: 'empty', parts: [{ responses: ['r1'], as: 'text', path: 'empty' }] }),
      spec({ title: 'object', parts: [{ responses: ['r1'], as: 'markdown', path: 'meeting' }] }),
      spec({ title: 'missing', parts: [{ responses: ['r3'], as: 'text' }] }),
      spec({ title: 'unknown', parts: [{ responses: ['r9'], as: 'text' }] }),
    ])
    expect(r.drafts).toHaveLength(1)
    expect(r.drafts[0]).toMatchObject({ title: 'https://a.test/m/p1', origin: 'https://a.test/m/p1', content: 'First.\n\nSecond.' })
    expect(r.drafts[0].date).toBeUndefined()
    expect(r.errors).toEqual([
      expect.stringMatching(/^doc "worded": template literal text may only be punctuation/),
      expect.stringMatching(/^doc "empty": (?:path "empty" selects nothing|the extraction is empty)/),
      expect.stringMatching(/^doc "object": path "meeting" selects object in r1, not a string/),
      'doc "missing": r3 is HTTP 404; extract only from successful responses',
      'doc "unknown": unknown response id r9',
    ])
    const checked = await rt.sandbox.execute('check_extraction', { docs: [spec({ title: 'worded', parts: [{ responses: ['r1'], as: 'text', each: 'items', template: '{text} ok' }] })] })
    expect(checked.is_error).toBe(true)
    const good = await rt.sandbox.execute('check_extraction', { docs: [spec()] })
    expect(good.is_error).toBe(false)
    expect(good.content).toMatch(/^OK doc "Pricing sync": \d+ characters/)
  })
})

describe('access agent: wiring', () => {
  it('without the access option, a reference is a problem with the generic fixes', async () => {
    const res = await run(fixtureApi().fetch, { sources: ['the Q3 planning doc'] }).done
    expect(res.problems[0]).toMatchObject({ source: 'the Q3 planning doc', kind: 'unknown', observed: 'not an existing path or a URL' })
    expect(res.problems[0].fixes[0]).toMatch(/ANTHROPIC_API_KEY/)
  })

  it('with the access option, a reference goes to the agent, whose why and fixes become the problem', async () => {
    const { client, seen } = playerClient()
    const res = await run(fixtureApi().fetch, { sources: ['the Q3 planning doc'], access: { client, model: 'm', grants: [] } }).done
    expect((seen[0].messages[0].content as string).split('\n').slice(0, 3)).toEqual(['SOURCE: the Q3 planning doc', '', 'FORMAT LAYER OBSERVED:'])
    expect(res.problems[0].why).toBe('the offline access player reaches only test fixture hosts, with a credential name to try.')
  })

  it('does not run the agent (no model call) when another source already failed, unless --allow-partial', async () => {
    const res = await run(fixtureApi().fetch, { sources: ['./missing.md', API], cwd: scratch('cwd'), access: { client: throwingClient, model: 'm', grants: [GRANT] } }).done
    expect(res.problems.map((p) => p.kind)).toEqual(['unknown', 'web'])
    expect(res.problems[1].why).toMatch(/^the access agent was not run: 1 other source could not be read, so no API call was made/)
    expect(res.problems[1].fixes.join(' ')).toMatch(/--allow-partial/)
    const { client } = playerClient()
    const partial = await run(fixtureApi().fetch, { sources: ['./missing.md', API], cwd: scratch('cwd2'), allowPartial: true, access: { client, model: 'm', grants: [GRANT] } }).done
    expect(partial.problems).toHaveLength(1)
    expect(partial.manifest.docs).toHaveLength(1)
  })

  it('an agent that errors out becomes a problem, not a throw', async () => {
    const res = await run(fixtureApi().fetch, { access: { client: throwingClient, model: 'm', grants: [GRANT] } }).done
    expect(res.problems[0].why).toMatch(/^the access agent could not finish working out how to reach it \(error: the model must not be called\)/)
  })

  it('the system prompt names no product and carries no URL', () => {
    expect(ACCESS_SYSTEM.startsWith('ROLE: access\n')).toBe(true)
    expect(ACCESS_SYSTEM).not.toMatch(/https?:\/\/|\bwww\.|\.com\b/)
    expect(ACCESS_SYSTEM).not.toMatch(/Notion|Granola|Google|Slack|Confluence|Loom|GitHub|Zoom|Teams|Jira|Linear|Dropbox|Drive/)
  })
})

describe('recipe replay (reverify, no model)', () => {
  async function first(dir: string) {
    const { client } = playerClient()
    return run(fixtureApi().fetch, { corpusDir: path.join(dir, 'corpus'), access: { client, model: 'claude-opus-5', grants: [GRANT] } }).done
  }

  it('replays the saved requests to identical docs without touching the model', async () => {
    const dir = scratch('replay')
    const a = await first(dir)
    const api = fixtureApi()
    const b = await run(api.fetch, { corpusDir: path.join(dir, 'corpus'), replay: true, grants: [GRANT], access: { client: throwingClient, model: 'm', grants: [] }, now: () => new Date('2026-10-12T00:00:00Z') }).done
    expect(b.problems).toEqual([])
    expect(api.calls).toEqual([{ url: API, auth: `Bearer ${TOKEN}` }])
    expect(b.manifest.docs).toEqual(a.manifest.docs)
    expect((b.manifest.sources[0] as ManifestSourceWithRecipe).recipe).toEqual((a.manifest.sources[0] as ManifestSourceWithRecipe).recipe)
    expect(b.usage.input_tokens).toBe(0)
  })

  it('a changed remote body changes the doc sha256', async () => {
    const dir = scratch('replay-change')
    const a = await first(dir)
    const b = await run(fixtureApi({ ...PAGE, markdown: PAGE.markdown + '\n- Annual discount: Q1\n' }).fetch, { corpusDir: path.join(dir, 'corpus'), replay: true, grants: [GRANT] }).done
    expect(b.manifest.docs[0].path).toBe(a.manifest.docs[0].path)
    expect(b.manifest.docs[0].sha256).not.toBe(a.manifest.docs[0].sha256)
  })

  it('a failing replay is a problem naming what broke, with the re-run and credential fixes', async () => {
    const dir = scratch('replay-fail')
    await first(dir)
    const revoked = fakeFetch(() => json(401, { message: 'token revoked' }))
    const res = await run(revoked.fetch, { corpusDir: path.join(dir, 'corpus'), replay: true, grants: [GRANT] }).done
    expect(res.problems[0].why).toBe('the saved way of reaching this source no longer works (GET api.fixture.test/pages/42: HTTP 401).')
    expect(res.problems[0].fixes[0]).toMatch(/^Check that FIXTURE_TOKEN still holds a valid credential/)
    expect(res.problems[0].fixes[1]).toMatch(/^Run system-explainer ingest \(or course\) again/)
    expect((res.manifest.sources[0] as ManifestSourceWithRecipe).recipe).toBeDefined()

    const ungranted = await run(fixtureApi().fetch, { corpusDir: path.join(dir, 'corpus'), replay: true, grants: [] }).done
    expect(ungranted.problems[0].fixes[0]).toBe('Allow it with --grant FIXTURE_TOKEN=api.fixture.test, then rerun.')
  })
})
