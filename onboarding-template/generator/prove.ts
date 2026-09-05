/**
 * prove - the proof workflow (proof.workflow.js) as a plain function driven by generator/llm.
 *
 *   prep -> one SKEPTIC per module -> one QUIZGEN per module -> genprep
 *        -> two LEARNERS per module (taught vs cold control) -> report
 *
 * The deterministic halves (prep / genprep / report) stay in proof.ts. This file only orchestrates
 * the agent fan-outs and writes what each agent SUBMITS to the file the workflow's agents used to
 * write themselves, so report() reads the run unchanged:
 *   adversarial/<id>.json       { moduleId, claims: [{ claim, verdict, evidence, note? }] }
 *   genraw/<id>.json            { moduleId, items: [{ id, prompt, options: [{ text, correct }], whyHard }] }
 *   learner-gen/<id>.json       { moduleId, mode: 'taught', answers: [{ id, choice, reasoning }] }
 *   learner-gen-cold/<id>.json  { moduleId, mode: 'cold', answers: [...] }
 *
 * What the workflow pointed agents at by path is passed INLINE, between <claims>, <lesson> and
 * <quiz> markers. Skeptic and quizgen get a read-only sandbox on the repo (write_file lands in a
 * throwaway dir); learners get no tools at all, and the cold learner never sees the lesson. Every
 * system prompt starts with `ROLE: <role>` - fake-proof-roles.ts keys on that line.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { runAgent, type AgentOptions, type AgentUsage } from './llm/agent'
import type { LlmClient } from './llm/client'
import { estimateCostUsd } from './llm/cost'
import { createSandbox, type Sandbox } from './llm/tools'
import { genprep, prep, report } from './proof'
import { affectedModules, changedFilesSince, pinnedSha } from './reverify'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..')

export interface ProveOptions {
  client: LlmClient
  model: string
  /** Model for the two learner arms; defaults to `model`. */
  modelLearner?: string
  system: string
  bundlePath: string
  repoPath: string
  /** Engine dir; proof-runs/<system>/ lives under it (default: this package). */
  root?: string
  /** Scope to these module ids (default: every module in the bundle). */
  modules?: string[]
  /** Scope to the modules whose cited files changed since the bundle's pinned sha; when none is, no agent runs. */
  affected?: boolean
  /** Agents in flight at once (default 3). */
  concurrency?: number
  effort?: AgentOptions['effort']
  onEvent?: (e: ProveEvent) => void
  /** When set, every agent attempt's request/response transcript is written here as <label>.jsonl. */
  transcriptDir?: string
}
export interface ProveEvent {
  type: string
  label: string
  detail?: string
}
export interface ProveAgent {
  label: string
  turns: number
  seconds: number
  stopReason: string
  usage: AgentUsage
}
export interface ProveResult {
  modules: string[]
  reportPath?: string
  skipped?: 'nothing-affected'
  adversarial?: { total: number; supported: number; refuted: number; unverifiable: number }
  effectiveness?: { taughtOverall: number; coldOverall: number }
  /** One entry per agent attempt (a retry is its own entry). */
  agents: ProveAgent[]
  usage: AgentUsage
  /** Sum over agents; null when a model is unknown to priceFor. */
  estimatedCostUsd: number | null
  seconds: number
}

type Role = 'skeptic' | 'quizgen' | 'learner-taught' | 'learner-cold'
const MODES = ['taught', 'cold'] as const
type Mode = (typeof MODES)[number]

export async function runProve(o: ProveOptions): Promise<ProveResult> {
  const started = Date.now()
  const root = o.root ?? packageRoot
  const bundle = JSON.parse(readFileSync(path.resolve(root, o.bundlePath), 'utf8'))
  if (!existsSync(o.repoPath)) throw new Error(`prove: repoPath does not exist: ${o.repoPath}`)
  const emit = (type: string, label: string, detail?: string) => o.onEvent?.({ type, label, detail })
  const runner = createRunner(o)
  const finish = (partial: Pick<ProveResult, 'modules' | 'reportPath' | 'skipped' | 'adversarial' | 'effectiveness'>): ProveResult => ({
    ...partial,
    agents: runner.agents,
    usage: sumUsage(runner.agents),
    estimatedCostUsd: runner.cost(),
    seconds: (Date.now() - started) / 1000,
  })

  const scope = scopeModules(o, bundle)
  if (!scope.ids.length) {
    if (!o.affected) throw new Error(`prove: none of the requested modules exist in ${o.bundlePath}: ${(o.modules ?? []).join(', ')}`)
    emit('skip', 'prove', `no module cites a file changed since ${scope.since}`)
    return finish({ modules: [], skipped: 'nothing-affected' })
  }

  // 1. prep (deterministic): inputs/ + keys/ + manifest.json; stale agent outputs for these modules are removed
  emit('phase', 'Prep', scope.ids.join(', '))
  const { dir, prepped: ids } = prep({ system: o.system, bundlePath: o.bundlePath, modules: scope.explicit ? scope.ids : undefined, root })
  const limit = o.concurrency ?? 3
  const read = (...rel: string[]) => readFileSync(path.join(dir, ...rel), 'utf8')

  const workDir = mkdtempSync(path.join(tmpdir(), 'prove-work-'))
  try {
    const sandbox = createSandbox({ repoDir: o.repoPath, workDir })
    // 2. TRUE: one adversarial skeptic per module
    emit('phase', 'Verify-true', `${ids.length} skeptic(s)`)
    await mapLimit(ids, limit, async (id) => {
      const job = { label: `verify:${id}`, role: 'skeptic' as const, model: o.model, user: skepticTask(id, read('inputs', `${id}.claims.json`)), schema: SKEPTIC_SCHEMA, check: Skeptic, sandbox }
      const r = await runner.run(job)
      if (r) writeJson(path.join(dir, 'adversarial', `${id}.json`), { moduleId: id, claims: r.claims })
    })
    // 3. EFFECTIVE setup: hardened 4-option questions with grounded distractors
    emit('phase', 'Quizgen', `${ids.length} quiz writer(s)`)
    await mapLimit(ids, limit, async (id) => {
      const job = { label: `quizgen:${id}`, role: 'quizgen' as const, model: o.model, user: quizgenTask(id, read('inputs', `${id}.lesson.md`)), schema: QUIZGEN_SCHEMA, check: Quizgen, sandbox }
      const r = await runner.run(job)
      if (r) writeJson(path.join(dir, 'genraw', `${id}.json`), { moduleId: id, items: r.items })
    })
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }

  // 4. genprep (deterministic): strip + shuffle genraw/ into learner-facing genquiz/ + held-back genkeys/
  genprep({ system: o.system, bundlePath: o.bundlePath, root })

  // 5. EFFECTIVE: a capable learner, taught vs cold control - no tools, and the cold arm never sees the lesson
  emit('phase', 'Effective', `${ids.length * 2} learner(s)`)
  const learnerModel = o.modelLearner ?? o.model
  const jobs = ids.flatMap((id) => MODES.map((mode) => ({ id, mode })))
  await mapLimit(jobs, limit, async ({ id, mode }) => {
    const label = `learn:${mode}:${id}`
    const quizPath = path.join(dir, 'genquiz', `${id}.quiz.json`)
    if (!existsSync(quizPath)) {
      emit('skip', label, 'no hardened quiz for this module (quizgen did not submit, or every item was rejected)')
      return
    }
    const lesson = mode === 'taught' ? read('inputs', `${id}.lesson.md`) : null
    const role: Role = mode === 'taught' ? 'learner-taught' : 'learner-cold'
    const r = await runner.run({ label, role, model: learnerModel, user: learnerTask(id, mode, readFileSync(quizPath, 'utf8'), lesson), schema: LEARNER_SCHEMA, check: Learner })
    if (r) writeJson(path.join(dir, mode === 'taught' ? 'learner-gen' : 'learner-gen-cold', `${id}.json`), { moduleId: id, mode, answers: r.answers })
  })

  // 6. report (deterministic): score + tally + render PROOF_REPORT.md
  emit('phase', 'Report')
  const rep = report({ system: o.system, bundlePath: o.bundlePath, root })
  return finish({
    modules: ids,
    reportPath: rep.reportPath,
    adversarial: rep.adversarial,
    effectiveness: { taughtOverall: rep.effectiveness.taughtOverall, coldOverall: rep.effectiveness.coldOverall },
  })
}

/**
 * The module ids to prove: the bundle's, narrowed to `modules` when given, then (with `affected`) to
 * those whose code blocks cite a file changed since the bundle's pinned sha. `explicit` says whether
 * prep is scoped (a scoped prep merges into the run's manifest; an unscoped one resets it).
 */
function scopeModules(o: ProveOptions, bundle: any): { ids: string[]; explicit: boolean; since?: string } {
  const all: string[] = (bundle.modules as any[]).map((m) => m.id)
  const ids = o.modules ? all.filter((id) => o.modules!.includes(id)) : all
  if (!o.affected) return { ids, explicit: !!o.modules }
  const sha = pinnedSha(bundle)
  if (!sha) throw new Error(`prove: affected needs a pinned sha on the bundle (provenance.grounding.repoRef); ${o.bundlePath} has none`)
  const hit = new Set(affectedModules(bundle, changedFilesSince(o.repoPath, sha)).map((a) => a.moduleId))
  return { ids: ids.filter((id) => hit.has(id)), explicit: true, since: sha.slice(0, 7) }
}

// ── the agent runner: every attempt recorded; no valid submission -> one retry, then skipped ──────
interface Job<T> {
  label: string
  role: Role
  model: string
  user: string
  /** The strict submit_result input schema. */
  schema: Record<string, unknown>
  /** The same shape as a zod check on what actually came back. */
  check: z.ZodType<T>
  sandbox?: Sandbox
}

function createRunner(o: ProveOptions) {
  const agents: ProveAgent[] = []
  let cost = estimateCostUsd(o.model, zeroUsage())
  async function run<T>(job: Job<T>): Promise<T | null> {
    for (const attempt of [1, 2]) {
      const label = attempt === 1 ? job.label : `${job.label} (retry)`
      const r = await runAgent({
        client: o.client,
        model: job.model,
        label,
        system: systemPrompt(job.role),
        user: job.user,
        sandbox: job.sandbox,
        submitSchema: job.schema,
        effort: o.effort,
        onEvent: o.onEvent,
        transcriptPath: o.transcriptDir ? path.join(o.transcriptDir, `${slug(label)}.jsonl`) : undefined,
      })
      agents.push({ label, turns: r.turns, seconds: r.seconds, stopReason: r.stopReason, usage: r.usage })
      cost = addCost(cost, job.model, r.usage)
      const checked = r.stopReason === 'submitted' ? job.check.safeParse(r.result) : null
      if (checked?.success) return checked.data
      const why = checked ? 'submitted a result that does not match the schema' : r.error ? `${r.stopReason}: ${r.error}` : r.stopReason
      o.onEvent?.({ type: attempt === 1 ? 'retry' : 'skip', label, detail: why })
    }
    return null
  }
  return { agents, run, cost: () => cost }
}

// ── prompts, ported from proof.workflow.js: files became inline blocks, "write a JSON file" became submit_result ──
const ROLE_PROMPT: Record<Role, string> = {
  skeptic:
    'You are an ADVERSARIAL code fact-checker. Your job is to BREAK an onboarding course, not confirm it. ' +
    'Source of truth = the repository your tools expose (list_dir, read_file, search, git_log, git_show); cite every path repo-relative.',
  quizgen: 'You write HARD comprehension quizzes: questions only someone who actually READ the module can answer, with distractors grounded in the same codebase.',
  'learner-taught': 'You just finished reading ONE onboarding module. Answer its quiz using ONLY what the module taught you.',
  'learner-cold': 'Pop quiz on a system you have NOT studied - a control for prior knowledge. You have NO lesson material and no tools.',
}
const systemPrompt = (role: Role) => `ROLE: ${role}\n${ROLE_PROMPT[role]}`

// Both tags sit on their own line: that is the shape fake-proof-roles.ts parses, so prose may still name a <tag> inline.
const block = (tag: string, body: string) => `<${tag}>\n${body.trim()}\n</${tag}>`

function skepticTask(id: string, claimsJson: string): string {
  return [
    `The <claims> block below lists the factual claims the course makes in module "${id}", plus citedPaths where it says the behavior lives. For EACH claim:`,
    '1. Split bundled assertions into atomic, separately-checkable claims.',
    '2. Investigate against the ACTUAL code - start at citedPaths, then grep/read widely.',
    '3. Assign a verdict, DEFAULTING TO SKEPTICISM: "supported" only with direct evidence (cite file:line or symbol), "refuted" if the code contradicts it (cite it), "unverifiable" if you find no evidence either way.',
    '',
    `When done, call submit_result ONCE with {"moduleId":"${id}","claims":[{"claim":"<atomic claim>","verdict":"supported|refuted|unverifiable","evidence":"<file:line - what you found>","note":"<optional>"}]}.`,
    '',
    block('claims', claimsJson),
  ].join('\n')
}

function quizgenTask(id: string, lesson: string): string {
  return [
    `Write a HARD comprehension quiz that tests whether someone actually LEARNED module "${id}" - not whether they can guess from general knowledge.`,
    '',
    'Study material (what the learner read): the <lesson> block below. You MAY consult the repository your tools expose to craft accurate distractors.',
    '',
    'Write 5 multiple-choice questions, each EXACTLY 4 options and EXACTLY ONE correct. Requirements:',
    '- The correct answer must require having READ THIS MODULE: a specific fact, number, status, formula, ordering, or FK direction from it. NOT general knowledge.',
    '- The 3 distractors must be PLAUSIBLE and grounded in the same domain - real-but-wrong neighbors (a sibling status, an off-by-one formula, a wrong FK direction). A smart engineer who did NOT read the module should find all 4 plausible and be unable to guess.',
    '- No "all of the above"; no two options with identical text; keep all 4 similar in length so length never telegraphs the answer.',
    '',
    `When done, call submit_result ONCE with {"moduleId":"${id}","items":[{"id":"g1","prompt":"...","options":[{"text":"...","correct":true},{"text":"...","correct":false},{"text":"...","correct":false},{"text":"...","correct":false}],"whyHard":"..."}]} (ids g1..g5).`,
    '',
    block('lesson', lesson),
  ].join('\n')
}

function learnerTask(id: string, mode: Mode, quizJson: string, lesson: string | null): string {
  const task =
    mode === 'taught'
      ? [
          'Study material (your ONLY source): the <lesson> block below.',
          'Quiz: the <quiz> block below - items have ids g1, g2, ...',
          '',
          'Answer EVERY item using those EXACT ids; one option key (a/b/c/d) per item; base answers on the module, no outside facts.',
        ]
      : [
          'Read ONLY the <quiz> block below (it has the title, objective, and questions). There is NO lesson material for you.',
          '',
          'Answer EVERY item using its EXACT id (g1, g2, ...); one option key (a/b/c/d) per item, from general knowledge / best guess.',
        ]
  return [
    ...task,
    `When done, call submit_result ONCE with {"moduleId":"${id}","mode":"${mode}","answers":[{"id":"g1","choice":"a","reasoning":"<one line>"}]}.`,
    '',
    ...(lesson === null ? [] : [block('lesson', lesson), '']),
    block('quiz', quizJson),
  ].join('\n')
}

// ── what each role submits: the strict schema sent to the API, and the zod check applied to the reply ──
// Strict mode allows enum but no count constraints, so "5 items / 4 options / one correct" lives in
// the prompt and genprep's buildGenQuiz rejects what does not comply.
const str = { type: 'string' }
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required })
const arr = (items: unknown) => ({ type: 'array', items })
const VERDICTS = ['supported', 'refuted', 'unverifiable'] as const

const SKEPTIC_SCHEMA = obj({
  moduleId: str,
  claims: arr(obj({ claim: str, verdict: { type: 'string', enum: VERDICTS }, evidence: str, note: str }, ['claim', 'verdict', 'evidence'])),
})
const Skeptic = z.object({
  moduleId: z.string(),
  claims: z.array(z.object({ claim: z.string(), verdict: z.enum(VERDICTS), evidence: z.string(), note: z.string().optional() })),
})

const QUIZGEN_SCHEMA = obj({
  moduleId: str,
  items: arr(obj({ id: str, prompt: str, options: arr(obj({ text: str, correct: { type: 'boolean' } })), whyHard: str })),
})
const Quizgen = z.object({
  moduleId: z.string(),
  items: z.array(z.object({ id: z.string(), prompt: z.string(), options: z.array(z.object({ text: z.string(), correct: z.boolean() })), whyHard: z.string() })),
})

const LEARNER_SCHEMA = obj({
  moduleId: str,
  mode: { type: 'string', enum: MODES },
  answers: arr(obj({ id: str, choice: str, reasoning: str })),
})
const Learner = z.object({
  moduleId: z.string(),
  mode: z.enum(MODES),
  answers: z.array(z.object({ id: z.string(), choice: z.string(), reasoning: z.string() })),
})

// ── small helpers ─────────────────────────────────────────────────────────────
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) await fn(items[next++])
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
}

function writeJson(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2))
}

const slug = (label: string) => label.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')

const zeroUsage = (): AgentUsage => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })

function sumUsage(agents: ProveAgent[]): AgentUsage {
  const total = zeroUsage()
  for (const a of agents) for (const k of Object.keys(total) as (keyof AgentUsage)[]) total[k] += a.usage[k]
  return total
}

function addCost(acc: number | null, model: string, usage: AgentUsage): number | null {
  const c = estimateCostUsd(model, usage)
  return acc === null || c === null ? null : acc + c
}
