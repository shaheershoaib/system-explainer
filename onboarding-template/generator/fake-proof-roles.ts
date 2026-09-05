/**
 * A scripted stand-in for the four proof roles, so runProve can be tested offline through
 * createFakeClient. It reads the role from the `ROLE: <role>` first line of the system prompt and
 * its inputs from the <claims> / <quiz> blocks of the user message, then behaves deterministically:
 *   skeptic         one read_file on the first citedPath (when there is one), then every claim supported
 *   quizgen         5 items x 4 distinct options, one correct, text derived from the module id
 *   learner-taught  every item answered with option key "a"
 *   learner-cold    every item answered with option key "b" (a non-zero lift whenever the key is "a")
 * No filesystem, no network, no state: each step is computed from the request alone, so it is
 * safe under concurrency and a shared call counter.
 */
import type Anthropic from '@anthropic-ai/sdk'
import type { FakeStep } from './llm/fake'

type Params = Anthropic.MessageCreateParamsNonStreaming

export function createFakeProofPlayer(): (callIndex: number, params: Params) => FakeStep {
  return (_callIndex, params) => {
    const role = /^ROLE: (\S+)/.exec(textOf(params.system))?.[1]
    const user = textOf(params.messages[0]?.content)
    switch (role) {
      case 'skeptic':
        return skeptic(user, params.messages.length > 1)
      case 'quizgen':
        return quizgen(user)
      case 'learner-taught':
        return learner(user, 'taught', 'a')
      case 'learner-cold':
        return learner(user, 'cold', 'b')
      default:
        throw new Error(`fake proof player: the system prompt does not start with a known ROLE line (got ${JSON.stringify(role)})`)
    }
  }
}

function skeptic(user: string, toolResultSeen: boolean): FakeStep {
  const input = JSON.parse(between(user, 'claims')) as { moduleId: string; citedPaths: string[]; claims: { id: string; text: string }[] }
  const cited = input.citedPaths[0]
  if (cited && !toolResultSeen) return { toolUse: [{ name: 'read_file', input: { path: cited } }] }
  const evidence = cited ? `${cited}: read via read_file, consistent with the claim (fake)` : 'no cited path to read (fake)'
  return { submit: { moduleId: input.moduleId, claims: input.claims.map((c) => ({ claim: `[${c.id}] ${c.text}`, verdict: 'supported', evidence })) } }
}

function quizgen(user: string): FakeStep {
  // The task's submit example carries the concrete module id, as the workflow's prompt did.
  const moduleId = /"moduleId":"([^"]+)"/.exec(user)?.[1] ?? 'unknown-module'
  const items = [1, 2, 3, 4, 5].map((n) => ({
    id: `g${n}`,
    prompt: `Fake question ${n} about ${moduleId}?`,
    options: [{ text: `${moduleId} fact ${n}`, correct: true }, ...['x', 'y', 'z'].map((d) => ({ text: `${moduleId} distractor ${n}${d}`, correct: false }))],
    whyHard: `fake item ${n} derived from ${moduleId}`,
  }))
  return { submit: { moduleId, items } }
}

function learner(user: string, mode: 'taught' | 'cold', choice: string): FakeStep {
  const quiz = JSON.parse(between(user, 'quiz')) as { moduleId: string; quiz: { id: string }[] }
  const answers = quiz.quiz.map((q) => ({ id: q.id, choice, reasoning: `fake ${mode} learner always picks ${choice}` }))
  return { submit: { moduleId: quiz.moduleId, mode, answers } }
}

/** The body of the `<tag>` block whose tags stand on their own lines (prose may name the tag inline without matching). */
function between(text: string, tag: string): string {
  const m = new RegExp(`^<${tag}>\\n([\\s\\S]*?)\\n</${tag}>$`, 'm').exec(text)
  if (!m) throw new Error(`fake proof player: no <${tag}> block in the user message`)
  return m[1]
}

/** The text of a system prompt or message content, whether a string or an array of content blocks. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : '')).join('\n')
}
