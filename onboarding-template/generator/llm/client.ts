import Anthropic, { APIConnectionError, APIError, RateLimitError } from '@anthropic-ai/sdk'

/** The one SDK capability the loop needs, so a scripted fake can stand in for the real client. */
export interface LlmClient {
  /** Run one non-streaming-shaped request through the streaming transport and return the final Message. */
  complete(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>
}

export interface ClientOptions {
  apiKey?: string
  baseURL?: string
  maxRetries?: number
  timeoutMs?: number
}

/**
 * Real client. Credentials resolve from the environment (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN)
 * when apiKey is omitted. complete() goes through the streaming transport because a long agent
 * turn read as one non-streaming response can outlive the per-request HTTP timeout.
 */
export function createAnthropicClient(opts: ClientOptions = {}): LlmClient {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
    maxRetries: opts.maxRetries ?? 3,
    timeout: opts.timeoutMs ?? 600_000,
  })
  return { complete: (params) => client.messages.stream(params).finalMessage() }
}

/**
 * 'retryable': rate limits, connection failures, 5xx / overloaded.
 * 'terminal': any other API error (400/401/403/404 ...) - the request itself is wrong.
 * 'unknown': not an SDK error at all.
 */
export function classifyError(err: unknown): 'retryable' | 'terminal' | 'unknown' {
  // APIConnectionError extends APIError in this SDK, so it has to be tested before the generic class.
  if (err instanceof RateLimitError || err instanceof APIConnectionError) return 'retryable'
  if (err instanceof APIError) return err.status !== undefined && err.status >= 500 ? 'retryable' : 'terminal'
  return 'unknown'
}
