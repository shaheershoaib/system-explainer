/**
 * An offline model for the access role (`ROLE: access` on the system prompt's first line), so the
 * access path runs without an API key. It only ever reaches test fixture hosts (".test" domains
 * and localhost by default): for one, it requests the source with the first credential name it was
 * shown, then submits an extraction of the longest top-level string field of the JSON response.
 * Everything else is reported unreachable with generic fixes. Deterministic for a given conversation.
 */
import type Anthropic from '@anthropic-ai/sdk'
import type { FakeStep } from '../llm/fake'

type Params = Anthropic.MessageCreateParamsNonStreaming

export interface FakeAccessOptions {
  /** Hosts the player treats as fixture servers (default: *.test, localhost, 127.0.0.1). */
  isFixtureHost?: (host: string) => boolean
}

const defaultFixture = (host: string) => /\.test(?::\d+)?$/.test(host) || /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(host)

const EXPORT_FIX = 'Export the content to a file (PDF, HTML, Markdown or plain text) and pass that file.'

export function createFakeAccessPlayer(opts: FakeAccessOptions = {}): (callIndex: number, params: Params) => FakeStep {
  const isFixture = opts.isFixtureHost ?? defaultFixture
  return (_callIndex, params) => {
    const task = typeof params.messages[0]?.content === 'string' ? params.messages[0].content : ''
    const source = /^SOURCE: (.*)$/m.exec(task)?.[1].trim() ?? ''
    const names = /^credential-looking environment variables \(names only\): (.*)$/m.exec(task)?.[1].trim() ?? 'none'
    const env = names === 'none' ? undefined : names.split(', ')[0]
    const url = parseUrl(source)
    const results = toolResults(params)

    if (!results.length) {
      if (url && isFixture(url.host) && env) {
        return { toolUse: [{ name: 'http_get', input: { url: url.href, credential: { env, header: 'Authorization', prefix: 'Bearer ' } } }] }
      }
      return unreachable('the source is not a fixture host this offline player can reach', 'the offline access player reaches only test fixture hosts, with a credential name to try.', [EXPORT_FIX])
    }

    const last = results[results.length - 1]
    if (last.isError) {
      const grant = /--grant (\S+=[^\s.]+(?:\.[^\s.]+)*)/.exec(last.content)?.[1]
      return unreachable(
        last.content.split('\n')[0],
        grant ? `the credential ${grant.split('=')[0]} has not been granted for ${grant.split('=')[1]}.` : 'the request was refused.',
        grant ? [`Allow it with --grant ${grant}, then rerun.`, EXPORT_FIX] : [EXPORT_FIX],
      )
    }
    const id = /^id: (\S+)$/m.exec(last.content)?.[1] ?? 'r1'
    const status = Number(/^status: (\d+)$/m.exec(last.content)?.[1] ?? 0)
    if (status < 200 || status >= 300) {
      return unreachable(`HTTP ${status} from ${url?.host ?? source}`, `the fixture API answered HTTP ${status}.`, [
        `Check that ${env} holds a valid credential for ${url?.host ?? 'that host'}, then rerun.`,
        EXPORT_FIX,
      ])
    }
    const body = last.content.split(/^body \(first \d+ characters[^)]*\):\n/m)[1] ?? ''
    const json = parseJson(body)
    const fields = json && typeof json === 'object' && !Array.isArray(json) ? Object.entries(json as Record<string, unknown>) : []
    const longest = fields.filter(([, v]) => typeof v === 'string').sort((a, b) => (b[1] as string).length - (a[1] as string).length)[0]
    const title = fields.find(([k, v]) => k === 'title' && typeof v === 'string')?.[1] as string | undefined
    const date = (fields.find(([, v]) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) as [string, string] | undefined)?.[1].slice(0, 10)
    const doc = {
      title: title ?? source,
      service: 'Fixture API',
      via: `fixture API using ${env}`,
      origin: source,
      ...(date ? { date } : {}),
      parts: [longest ? { responses: [id], as: 'markdown', path: longest[0] } : { responses: [id], as: 'text' }],
    }
    return { submit: { status: 'ok', service: 'Fixture API', docs: [doc] } }
  }
}

const unreachable = (observed: string, why: string, fixes: string[]): FakeStep => ({ submit: { status: 'unreachable', observed, why, fixes } })

function parseUrl(s: string): URL | null {
  try {
    return /^https?:\/\//.test(s) ? new URL(s) : null
  } catch {
    return null
  }
}

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

function toolResults(params: Params): { content: string; isError: boolean }[] {
  const out: { content: string; isError: boolean }[] = []
  for (const m of params.messages.slice(1)) {
    if (m.role !== 'user' || typeof m.content === 'string') continue
    for (const b of m.content) {
      if (b.type !== 'tool_result') continue
      const content = typeof b.content === 'string' ? b.content : (b.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('')
      if (content !== 'accepted') out.push({ content, isError: Boolean(b.is_error) })
    }
  }
  return out
}
