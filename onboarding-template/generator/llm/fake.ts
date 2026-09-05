import type Anthropic from '@anthropic-ai/sdk'
import type { LlmClient } from './client'

export type FakeStep =
  | { toolUse: { name: string; input: unknown }[] }
  | { submit: unknown }
  | { text: string; stop?: 'end_turn' | 'max_tokens' }

/**
 * A scripted LlmClient. `script(callIndex, params)` returns what the fake assistant does on that
 * call. It fabricates a valid Anthropic.Message (ids, usage: 100 input / 50 output tokens per
 * call, stop_reason 'tool_use' for tool calls, 'end_turn' otherwise).
 */
export function createFakeClient(script: (callIndex: number, params: Anthropic.MessageCreateParamsNonStreaming) => FakeStep): LlmClient {
  let calls = 0
  return {
    async complete(params) {
      const index = calls++
      const [content, stop_reason] = contentFor(script(index, params), index)
      return {
        id: `msg_fake_${index}`,
        type: 'message',
        role: 'assistant',
        model: params.model,
        content,
        stop_reason,
        stop_details: null,
        stop_sequence: null,
        container: null,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation: null,
          inference_geo: null,
          output_tokens_details: null,
          server_tool_use: null,
          service_tier: null,
        },
      }
    },
  }
}

function contentFor(step: FakeStep, call: number): [Anthropic.ContentBlock[], Anthropic.StopReason] {
  if ('submit' in step) return [[toolUse(call, 0, 'submit_result', step.submit)], 'tool_use']
  if ('toolUse' in step) return [step.toolUse.map((t, i) => toolUse(call, i, t.name, t.input)), 'tool_use']
  return [[{ type: 'text', text: step.text, citations: null }], step.stop ?? 'end_turn']
}

const toolUse = (call: number, i: number, name: string, input: unknown): Anthropic.ToolUseBlock => ({
  type: 'tool_use',
  id: `toolu_fake_${call}_${i}`,
  name,
  input,
  caller: { type: 'direct' },
})
