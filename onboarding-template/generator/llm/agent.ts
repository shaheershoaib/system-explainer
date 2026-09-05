/**
 * The agent loop: one system prompt, one task, the sandbox tools plus a strict `submit_result`
 * tool whose input IS the result. Runs until the model submits, or a budget (turns, wall clock)
 * runs out. Never throws - every outcome is an AgentResult with a stopReason.
 *
 * Transcript (when transcriptPath is set): one JSON line per completed turn,
 * `{ turn, request, response, next }` where `next` is the user message the loop pushed in reply
 * (tool results or a nudge; null when nothing was pushed), plus `{ turn, error }` lines for
 * thrown calls.
 */
import type Anthropic from '@anthropic-ai/sdk'
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { classifyError, type LlmClient } from './client'
import type { Sandbox } from './tools'

export interface AgentUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}
export interface AgentEvent {
  type: 'turn' | 'tool' | 'submit' | 'error' | 'done'
  label: string
  detail?: string
}
export interface AgentOptions {
  client: LlmClient
  model: string
  label: string
  system: string
  user: string
  /** Its definitions are appended to the tool list. */
  sandbox?: Sandbox
  /** JSON schema for the result; becomes the strict `submit_result` tool's input_schema. */
  submitSchema: Record<string, unknown>
  /** default 40 assistant turns */
  maxTurns?: number
  /** default 16000 */
  maxTokens?: number
  /** default 'high'; sent as output_config.effort */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** default 45 minutes; exceeded -> stop with stopReason 'wall_clock' */
  wallClockMs?: number
  onEvent?: (e: AgentEvent) => void
  /** When set, append every request/response pair as JSON lines. */
  transcriptPath?: string
}
export interface AgentResult<T = unknown> {
  /** The submit_result input, or null when the agent never submitted. */
  result: T | null
  turns: number
  usage: AgentUsage
  seconds: number
  stopReason: 'submitted' | 'max_turns' | 'wall_clock' | 'ended_without_submit' | 'refusal' | 'error'
  error?: string
}

const SUBMIT = 'submit_result'
const NUDGE = 'You have not called submit_result. Call it now with your finished result.'
const CONTINUE = 'Your last message was cut off. Continue, and call submit_result when done.'
const CUT_OFF_TOOL = 'Your message was cut off before this tool call completed; call it again.'

export async function runAgent<T = unknown>(opts: AgentOptions): Promise<AgentResult<T>> {
  const started = Date.now()
  const maxTurns = opts.maxTurns ?? 40
  const wallClockMs = opts.wallClockMs ?? 45 * 60_000
  const tools: Anthropic.Tool[] = [...(opts.sandbox?.definitions ?? []), submitTool(opts.submitSchema)]
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: opts.user }]
  const usage: AgentUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  const transcript = opts.transcriptPath ? openTranscript(opts.transcriptPath) : null
  const emit = (type: AgentEvent['type'], label: string, detail?: string) => opts.onEvent?.({ type, label, detail })
  let turns = 0
  let result: T | null = null
  let nudges = 0
  let continuations = 0
  let retries = 0

  const finish = (stopReason: AgentResult['stopReason'], error?: string): AgentResult<T> => {
    emit('done', opts.label, error ? `${stopReason}: ${error}` : stopReason)
    const out: AgentResult<T> = { result, turns, usage, seconds: (Date.now() - started) / 1000, stopReason }
    if (error) out.error = error
    return out
  }

  async function runTool(u: Anthropic.ToolUseBlock): Promise<Anthropic.ToolResultBlockParam> {
    const outcome = opts.sandbox ? await opts.sandbox.execute(u.name, u.input) : { content: `unknown tool: ${u.name}`, is_error: true }
    emit('tool', u.name, `${summarize(u.input)} -> ${outcome.is_error ? 'error: ' : ''}${outcome.content.length} chars`)
    return toolResult(u.id, outcome.content, outcome.is_error)
  }

  try {
    while (true) {
      if (turns >= maxTurns) return finish('max_turns')
      if (Date.now() - started >= wallClockMs) return finish('wall_clock')
      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model: opts.model,
        max_tokens: opts.maxTokens ?? 16000,
        system: opts.system,
        messages: [...messages],
        tools,
        tool_choice: { type: 'auto' },
        output_config: { effort: opts.effort ?? 'high' },
      }

      let message: Anthropic.Message
      try {
        message = await opts.client.complete(params)
      } catch (err) {
        const detail = errorMessage(err)
        emit('error', opts.label, detail)
        transcript?.({ turn: turns + 1, error: detail })
        // The SDK has already retried transport failures; a couple more attempts with a pause
        // ride out a rate-limit window, and anything else will not fix itself.
        if (classifyError(err) !== 'retryable' || retries >= 2) return finish('error', detail)
        retries++
        await sleep(2000 + Math.random() * 1000)
        continue
      }
      retries = 0
      turns++
      addUsage(usage, message.usage)
      messages.push({ role: 'assistant', content: message.content })
      const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      emit('turn', opts.label, `turn ${turns}: ${message.stop_reason}, ${toolUses.length} tool call(s), ${message.usage.output_tokens} output tokens`)

      let next: Anthropic.MessageParam | null = null
      let stop: AgentResult['stopReason'] | null = null
      let error: string | undefined
      if (message.stop_reason === 'refusal') {
        stop = 'refusal'
        error = message.stop_details?.explanation ?? undefined
      } else if (message.stop_reason === 'model_context_window_exceeded') {
        stop = 'error'
        error = 'model context window exceeded'
      } else if (message.stop_reason === 'max_tokens') {
        // A cut-off turn may carry half-built tool calls: the API still requires a tool_result for
        // each, but running them would act on truncated input.
        const results = toolUses.map((u) => toolResult(u.id, CUT_OFF_TOOL, true))
        if (continuations++ < 2) next = { role: 'user', content: [...results, { type: 'text', text: CONTINUE }] }
        else {
          stop = 'ended_without_submit'
          error = 'max_tokens reached three times'
        }
      } else if (toolUses.length) {
        const results: Anthropic.ToolResultBlockParam[] = []
        for (const u of toolUses) {
          if (u.name !== SUBMIT) results.push(await runTool(u))
          else {
            result = u.input as T
            stop = 'submitted'
            results.push(toolResult(u.id, 'accepted'))
            emit('submit', opts.label, summarize(u.input))
          }
        }
        next = { role: 'user', content: results }
      } else if (message.stop_reason === 'pause_turn') {
        // Nothing to add: re-sending the transcript lets the model resume its turn.
      } else if (nudges++ < 1) {
        next = { role: 'user', content: NUDGE }
      } else {
        stop = 'ended_without_submit'
      }
      if (next) messages.push(next)
      transcript?.({ turn: turns, request: params, response: message, next })
      if (stop) return finish(stop, error)
    }
  } catch (err) {
    return finish('error', errorMessage(err))
  }
}

function submitTool(schema: Record<string, unknown>): Anthropic.Tool {
  return {
    name: SUBMIT,
    description: 'Call exactly once with the finished result. This ends the task.',
    strict: true,
    input_schema: { additionalProperties: false, ...schema, type: 'object' },
  }
}

function toolResult(id: string, content: string, is_error?: boolean): Anthropic.ToolResultBlockParam {
  const block: Anthropic.ToolResultBlockParam = { type: 'tool_result', tool_use_id: id, content }
  if (is_error) block.is_error = true
  return block
}

function addUsage(total: AgentUsage, u: Anthropic.Usage): void {
  total.input_tokens += u.input_tokens
  total.output_tokens += u.output_tokens
  total.cache_read_input_tokens += u.cache_read_input_tokens ?? 0
  total.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0
}

function openTranscript(file: string): (entry: unknown) => void {
  mkdirSync(path.dirname(file), { recursive: true })
  return (entry) => appendFileSync(file, JSON.stringify(entry) + '\n')
}

function summarize(input: unknown): string {
  const s = JSON.stringify(input) ?? String(input)
  return s.length > 120 ? s.slice(0, 117) + '...' : s
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
