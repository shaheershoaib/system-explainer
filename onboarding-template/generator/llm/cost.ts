import type { AgentUsage } from './agent'

/** USD per million tokens, [input, output], for the exact model ids the CLI accepts. */
const PRICES: Record<string, [number, number]> = {
  'claude-fable-5-1': [10, 50],
  'claude-fable-5': [10, 50],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-opus-4-6': [5, 25],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-4-5': [1, 5],
}

/** USD per million tokens for known model ids; unknown -> null. */
export function priceFor(model: string): { input: number; output: number; cacheRead: number } | null {
  const p = PRICES[model]
  return p ? { input: p[0], output: p[1], cacheRead: p[0] * 0.1 } : null
}

export function estimateCostUsd(model: string, usage: AgentUsage): number | null {
  const p = priceFor(model)
  if (!p) return null
  // Cache writes (5-minute TTL) bill at 1.25x the input rate.
  const tokensCost =
    usage.input_tokens * p.input +
    usage.output_tokens * p.output +
    usage.cache_read_input_tokens * p.cacheRead +
    usage.cache_creation_input_tokens * p.input * 1.25
  return tokensCost / 1_000_000
}
