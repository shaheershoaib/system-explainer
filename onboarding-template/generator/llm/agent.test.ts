import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Anthropic, { APIConnectionError, BadRequestError, InternalServerError, RateLimitError } from '@anthropic-ai/sdk'
import { runAgent, type AgentEvent, type AgentOptions, type AgentUsage } from './agent'
import { classifyError } from './client'
import { estimateCostUsd, priceFor } from './cost'
import { createFakeClient } from './fake'
import { createSandbox, type Sandbox } from './tools'

const SCHEMA = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }
const tmp: string[] = []
const scratch = (label: string) => {
  const d = mkdtempSync(path.join(tmpdir(), `llm-agent-${label}-`))
  tmp.push(d)
  return d
}
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true })
})

type Params = Anthropic.MessageCreateParamsNonStreaming
const base = (client: AgentOptions['client'], extra: Partial<AgentOptions> = {}): AgentOptions => ({
  client,
  model: 'claude-opus-5',
  label: 'test',
  system: 'You are under test.',
  user: 'Do the thing.',
  submitSchema: SCHEMA,
  ...extra,
})
const spySandbox = () => {
  const execute = vi.fn(async (name: string) => ({ content: `ran ${name}` }))
  const sandbox: Sandbox = { definitions: [], execute }
  return { sandbox, execute }
}
const lastUser = (p: Params) => p.messages.at(-1)!
const blocks = <B>(p: Params, index: number) => p.messages[index].content as B[]

describe('runAgent', () => {
  it('runs a tool call, then accepts the submitted result', async () => {
    const repo = scratch('repo')
    writeFileSync(path.join(repo, 'hello.txt'), 'hi there\n')
    const seen: Params[] = []
    const events: AgentEvent[] = []
    const client = createFakeClient((i, params) => {
      seen.push(params)
      return i === 0 ? { toolUse: [{ name: 'read_file', input: { path: 'hello.txt' } }] } : { submit: { ok: true } }
    })
    const res = await runAgent<{ ok: boolean }>(base(client, { sandbox: createSandbox({ repoDir: repo, workDir: scratch('work') }), onEvent: (e) => events.push(e) }))

    expect(res.stopReason).toBe('submitted')
    expect(res.result).toEqual({ ok: true })
    expect(res.turns).toBe(2)
    expect(res.usage).toEqual({ input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
    expect(res.error).toBeUndefined()
    expect(res.seconds).toBeGreaterThanOrEqual(0)

    // request shape: system, first user message, sandbox tools + strict submit_result, auto tool choice, effort
    const first = seen[0]
    expect(first.system).toBe('You are under test.')
    expect(first.messages).toEqual([{ role: 'user', content: 'Do the thing.' }])
    expect(first.tool_choice).toEqual({ type: 'auto' })
    expect(first.output_config).toEqual({ effort: 'high' })
    expect(first.max_tokens).toBe(16000)
    const tools = first.tools as Anthropic.Tool[]
    expect(tools.map((t) => t.name)).toEqual(['list_dir', 'read_file', 'search', 'git_log', 'git_show', 'write_file', 'submit_result'])
    const submit = tools.at(-1)!
    expect(submit.strict).toBe(true)
    expect(submit.input_schema).toEqual({ ...SCHEMA, additionalProperties: false })

    // the second request carries the assistant turn and ONE user message holding the tool result
    const second = seen[1]
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    const [use] = blocks<Anthropic.ToolUseBlockParam>(second, 1)
    const [result] = blocks<Anthropic.ToolResultBlockParam>(second, 2)
    expect(result).toEqual({ type: 'tool_result', tool_use_id: use.id, content: '1\thi there' })

    expect(events.map((e) => e.type)).toEqual(['turn', 'tool', 'turn', 'submit', 'done'])
    expect(events[1].label).toBe('read_file')
  })

  it('re-prompts once after an end_turn without submit, then gives up', async () => {
    const seen: Params[] = []
    const client = createFakeClient((_i, params) => {
      seen.push(params)
      return { text: 'I think I am done.' }
    })
    const res = await runAgent(base(client))
    expect(res.stopReason).toBe('ended_without_submit')
    expect(res.result).toBeNull()
    expect(res.turns).toBe(2)
    expect(seen).toHaveLength(2)
    expect(lastUser(seen[1])).toEqual({ role: 'user', content: 'You have not called submit_result. Call it now with your finished result.' })
  })

  it('answers an unknown tool with an is_error tool_result', async () => {
    const seen: Params[] = []
    const client = createFakeClient((i, params) => {
      seen.push(params)
      return i === 0 ? { toolUse: [{ name: 'teleport', input: { to: 'mars' } }] } : { submit: { ok: true } }
    })
    const res = await runAgent(base(client))
    expect(res.stopReason).toBe('submitted')
    const [use] = blocks<Anthropic.ToolUseBlockParam>(seen[1], 1)
    const [result] = blocks<Anthropic.ToolResultBlockParam>(seen[1], 2)
    expect(result).toEqual({ type: 'tool_result', tool_use_id: use.id, content: 'unknown tool: teleport', is_error: true })
  })

  it('stops with max_turns when the budget runs out', async () => {
    const { sandbox, execute } = spySandbox()
    const client = createFakeClient(() => ({ toolUse: [{ name: 'list_dir', input: {} }] }))
    const res = await runAgent(base(client, { sandbox, maxTurns: 1 }))
    expect(res.stopReason).toBe('max_turns')
    expect(res.result).toBeNull()
    expect(res.turns).toBe(1)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith('list_dir', {})
  })

  it('stops with wall_clock when the time budget is gone', async () => {
    const client = createFakeClient(() => ({ submit: { ok: true } }))
    const res = await runAgent(base(client, { wallClockMs: 0 }))
    expect(res.stopReason).toBe('wall_clock')
    expect(res.turns).toBe(0)
  })

  it('runs the other tool_use in a submit message and returns all tool_results in one user message', async () => {
    const { sandbox, execute } = spySandbox()
    const transcriptPath = path.join(scratch('transcript'), 'nested', 'run.jsonl')
    const client = createFakeClient(() => ({ toolUse: [{ name: 'list_dir', input: { path: 'src' } }, { name: 'submit_result', input: { ok: true } }] }))
    const res = await runAgent(base(client, { sandbox, transcriptPath }))
    expect(res.stopReason).toBe('submitted')
    expect(res.result).toEqual({ ok: true })
    expect(res.turns).toBe(1)
    expect(execute).toHaveBeenCalledWith('list_dir', { path: 'src' })

    const lines = readFileSync(transcriptPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toHaveLength(1)
    const [entry] = lines
    expect(entry.turn).toBe(1)
    expect(entry.request.messages).toHaveLength(1)
    const uses = entry.response.content as Anthropic.ToolUseBlock[]
    expect(uses.map((u) => u.name)).toEqual(['list_dir', 'submit_result'])
    expect(entry.next.role).toBe('user')
    expect(entry.next.content).toEqual([
      { type: 'tool_result', tool_use_id: uses[0].id, content: 'ran list_dir' },
      { type: 'tool_result', tool_use_id: uses[1].id, content: 'accepted' },
    ])
  })

  it('asks the model to continue after max_tokens, answering any cut-off tool calls with errors', async () => {
    const seen: Params[] = []
    const client = createFakeClient((i, params) => {
      seen.push(params)
      if (i === 0) return { text: 'Here is the beginning of a very long', stop: 'max_tokens' }
      return { submit: { ok: true } }
    })
    const res = await runAgent(base(client))
    expect(res.stopReason).toBe('submitted')
    expect(lastUser(seen[1])).toEqual({ role: 'user', content: [{ type: 'text', text: 'Your last message was cut off. Continue, and call submit_result when done.' }] })
  })

  it('never throws: a terminal API error becomes stopReason error', async () => {
    const client = { complete: async () => { throw new BadRequestError(400, { type: 'invalid_request_error', message: 'bad schema' }, undefined, new Headers()) } }
    const res = await runAgent(base(client))
    expect(res.stopReason).toBe('error')
    expect(res.error).toMatch(/bad schema/)
    expect(res.turns).toBe(0)
  })
})

describe('classifyError', () => {
  it('sorts SDK errors into retryable / terminal / unknown', () => {
    expect(classifyError(new RateLimitError(429, { type: 'rate_limit_error' }, 'slow down', new Headers()))).toBe('retryable')
    expect(classifyError(new APIConnectionError({ message: 'socket hang up' }))).toBe('retryable')
    expect(classifyError(new InternalServerError(529, { type: 'overloaded_error' }, 'overloaded', new Headers()))).toBe('retryable')
    expect(classifyError(new BadRequestError(400, { type: 'invalid_request_error' }, 'nope', new Headers()))).toBe('terminal')
    expect(classifyError(new Error('boom'))).toBe('unknown')
    expect(classifyError('boom')).toBe('unknown')
  })
})

describe('cost', () => {
  const usage = (u: Partial<AgentUsage>): AgentUsage => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...u })
  it('prices opus-5 at 5 in / 25 out per million', () => {
    expect(estimateCostUsd('claude-opus-5', usage({ input_tokens: 1_000_000, output_tokens: 1_000_000 }))).toBe(30)
  })
  it('bills cache reads at 10% of input and cache writes at 125%', () => {
    expect(priceFor('claude-fable-5-1')).toEqual({ input: 10, output: 50, cacheRead: 1 })
    expect(estimateCostUsd('claude-sonnet-4-6', usage({ cache_read_input_tokens: 1_000_000 }))).toBeCloseTo(0.3)
    expect(estimateCostUsd('claude-haiku-4-5', usage({ cache_creation_input_tokens: 1_000_000 }))).toBeCloseTo(1.25)
  })
  it('returns null for unknown models', () => {
    expect(priceFor('gpt-4o')).toBeNull()
    expect(estimateCostUsd('claude-opus-4-5-20251101', usage({ input_tokens: 10 }))).toBeNull()
  })
})
