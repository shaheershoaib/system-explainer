/**
 * runCourse: the autonomous course loop (enumerate -> data model -> per-domain author + verify ->
 * completeness critic, up to maxRounds) as a plain function over generator/llm. It replaces the
 * Workflow-tool script auto-course.workflow.js and keeps its phases, prompts and JSON schemas.
 *
 * What changed is the runtime: agents no longer write files, they RETURN their artifact through
 * submit_result, and this function owns the disk bus (plan.json, datamodel.json, drafts/<id>.json,
 * modules/<id>.json under workDir) before handing it to assemble(), the deterministic back half.
 * Every agent's system prompt starts with `ROLE: <role>` so an offline player can stand in for the
 * model (see fake-course-roles.ts).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { assemble } from './assemble-bundle'
import { runAgent, type AgentOptions, type AgentUsage } from './llm/agent'
import type { LlmClient } from './llm/client'
import { estimateCostUsd } from './llm/cost'
import { createSandbox } from './llm/tools'

export type Role = 'enumerate' | 'data-model' | 'author' | 'verify' | 'critic'
export type Audience = 'developer' | 'non-technical'

export interface CourseOptions {
  client: LlmClient
  model: string
  repoPath: string
  systemName: string
  srcHint?: string
  repoUrl?: string
  audience?: Audience
  /** default <repoPath>/.system-explainer/auto-course/<systemName> */
  workDir?: string
  /** optional graphify graph; passed into the prompts exactly like the workflow's GRAPH block */
  graphPath?: string
  /** default 3 (author+verify pairs run concurrently up to this) */
  concurrency?: number
  /** default 3 (completeness-critic rounds, as in the workflow) */
  maxRounds?: number
  effort?: AgentOptions['effort']
  /** engine dir for assemble (default this package) */
  root?: string
  /** optional --out copy */
  out?: string
  onEvent?: (e: { type: string; label: string; detail?: string }) => void
  /** when set, each agent gets a transcript file under it */
  transcriptDir?: string
}
export interface CourseResult {
  workDir: string
  bundlePath: string
  modules: string[]
  dataModelEntities: number
  grounding?: { total: number; verified: number; exact: number; drifted: number; missingFile: number }
  agents: { label: string; turns: number; seconds: number; stopReason: string; usage: AgentUsage }[]
  usage: AgentUsage
  estimatedCostUsd: number | null
  seconds: number
}

// ── The artifacts agents submit (the workflow's JSON schemas, as types) ──────────────────────
export interface Domain {
  id: string
  title: string
  files: string[]
  covers: string
}
export interface Plan {
  systemName: string
  oneLiner: string
  elevatorPitch: string
  outOfScope?: string[]
  domains: Domain[]
}
export interface DataModelEntity {
  id: string
  name: string
  definition: string
  relationships?: { to: string; cardinality: 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many'; label?: string }[]
}
export interface DataModel {
  entities: DataModelEntity[]
}
export interface DraftCode {
  caption?: string
  language: string
  sourcePath: string
  snippet: string
}
export interface DraftLesson {
  title: string
  prose: string
  code?: DraftCode[]
  callout?: { variant: 'gotcha' | 'note' | 'warning' | 'tip'; md: string }
}
export interface DraftQuiz {
  prompt: string
  options: { text: string; correct: boolean; ifChosen?: string }[]
  explanation: string
  misconception?: { trap: string; correction: string }
}
export interface DraftModule {
  id: string
  title: string
  objective: string
  oneJob?: string
  concepts: { id: string; name: string; definition: string }[]
  lessons: DraftLesson[]
  quiz: DraftQuiz[]
}
export interface VerifyResult {
  id: string
  module: DraftModule
  verified: number
  total: number
  dropped: number
}
export interface CriticVerdict {
  complete: boolean
  rationale?: string
  missingDomains: Domain[]
}

// ── submit_result schemas, copied from auto-course.workflow.js ───────────────────────────────
const DOMAIN = {
  type: 'object', additionalProperties: false,
  required: ['id', 'title', 'files', 'covers'],
  properties: {
    id: { type: 'string', description: 'kebab-case id' },
    title: { type: 'string' },
    files: { type: 'array', items: { type: 'string' }, description: 'repo-relative paths implementing this domain' },
    covers: { type: 'string' },
  },
}
const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['systemName', 'oneLiner', 'elevatorPitch', 'domains'],
  properties: {
    systemName: { type: 'string' }, oneLiner: { type: 'string' }, elevatorPitch: { type: 'string' },
    outOfScope: { type: 'array', items: { type: 'string' } },
    domains: { type: 'array', items: DOMAIN },
  },
}
const REL = { type: 'object', additionalProperties: false, required: ['to', 'cardinality'], properties: { to: { type: 'string', description: 'another entity id' }, cardinality: { type: 'string', enum: ['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many'] }, label: { type: 'string' } } }
const DM_ENTITY = { type: 'object', additionalProperties: false, required: ['id', 'name', 'definition'], properties: { id: { type: 'string' }, name: { type: 'string' }, definition: { type: 'string' }, relationships: { type: 'array', items: REL } } }
const DATAMODEL_SCHEMA = { type: 'object', additionalProperties: false, required: ['entities'], properties: { entities: { type: 'array', items: DM_ENTITY } } }

const CONCEPT = { type: 'object', additionalProperties: false, required: ['id', 'name', 'definition'], properties: { id: { type: 'string' }, name: { type: 'string' }, definition: { type: 'string' } } }
const CODE = { type: 'object', additionalProperties: false, required: ['sourcePath', 'language', 'snippet'], properties: { caption: { type: 'string' }, language: { type: 'string' }, sourcePath: { type: 'string' }, snippet: { type: 'string', description: 'VERBATIM from the file' } } }
const CALLOUT = { type: 'object', additionalProperties: false, required: ['variant', 'md'], properties: { variant: { type: 'string', enum: ['gotcha', 'note', 'warning', 'tip'] }, md: { type: 'string' } } }
const LESSON = { type: 'object', additionalProperties: false, required: ['title', 'prose'], properties: { title: { type: 'string' }, prose: { type: 'string' }, code: { type: 'array', items: CODE }, callout: CALLOUT } }
const OPTION = { type: 'object', additionalProperties: false, required: ['text', 'correct'], properties: { text: { type: 'string' }, correct: { type: 'boolean' }, ifChosen: { type: 'string' } } }
const MISC = { type: 'object', additionalProperties: false, required: ['trap', 'correction'], properties: { trap: { type: 'string' }, correction: { type: 'string' } } }
const QUIZ = { type: 'object', additionalProperties: false, required: ['prompt', 'options', 'explanation'], properties: { prompt: { type: 'string' }, options: { type: 'array', items: OPTION }, explanation: { type: 'string' }, misconception: MISC } }
const MODULE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['id', 'title', 'objective', 'concepts', 'lessons', 'quiz'],
  properties: {
    id: { type: 'string' }, title: { type: 'string' }, objective: { type: 'string' }, oneJob: { type: 'string' },
    concepts: { type: 'array', items: CONCEPT }, lessons: { type: 'array', items: LESSON }, quiz: { type: 'array', items: QUIZ },
  },
}
// The workflow's VERIFY_SUMMARY plus the finalized module itself: the verifier used to write
// modules/<id>.json, now it returns the module and runCourse writes the file.
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['id', 'module', 'verified', 'total', 'dropped'],
  properties: {
    id: { type: 'string' },
    module: { ...MODULE_SCHEMA, description: 'the finalized module: IDENTICAL to the draft except for the snippet corrections/deletions' },
    verified: { type: 'integer', description: 'code blocks now faithful to source' },
    total: { type: 'integer', description: 'code blocks in the draft' },
    dropped: { type: 'integer', description: 'code blocks removed because their file does not exist' },
  },
}
const CRITIC_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['complete', 'missingDomains'],
  properties: { complete: { type: 'boolean' }, rationale: { type: 'string' }, missingDomains: { type: 'array', items: DOMAIN } },
}

/** The verify prompt ends with this marker followed by the draft module JSON. */
export const DRAFT_MARKER = 'DRAFT (JSON):'
const SUBMIT_NOTE = 'When your result is ready, call submit_result exactly once with it (it must match the tool schema); that ends the task.'

interface ModuleSummary {
  id: string
  title: string
  verified: number
  total: number
  dropped: number
}

export async function runCourse(o: CourseOptions): Promise<CourseResult> {
  const started = Date.now()
  const repoPath = path.resolve(o.repoPath)
  const { systemName } = o
  const srcHint = o.srcHint ?? 'src'
  const audience: Audience = o.audience === 'non-technical' ? 'non-technical' : 'developer'
  const depth = audience === 'non-technical' ? 'L2' : 'L3'
  const workDir = path.resolve(o.workDir ?? path.join(repoPath, '.system-explainer', 'auto-course', systemName))
  const maxRounds = o.maxRounds ?? 3
  const emit = (type: string, label: string, detail?: string) => o.onEvent?.({ type, label, detail })
  const log = (detail: string) => emit('log', 'course', detail)
  const warn = (label: string, detail: string) => {
    console.warn(`[course] ${label}: ${detail}`)
    emit('warn', label, detail)
  }

  const scope = `STRICT SCOPE: course ONLY the repository at ${repoPath}. Your tools are sandboxed to it and take repo-relative paths (no ${repoPath} prefix) — do NOT read, list, grep, or cite ANY file outside ${repoPath}. Start by listing the repository root and ${srcHint}. Cite every path repo-relative.`
  const graph = graphBlock(repoPath, o.graphPath)
  if (o.graphPath && !graph) warn('graph', `${o.graphPath} is missing or outside the repository, so the agents cannot read it; proceeding without the graph`)
  const sandbox = createSandbox({ repoDir: repoPath, workDir })
  const agents: CourseResult['agents'] = []
  const usage: AgentUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

  /** One role-tagged agent run. A non-submit is retried once with the same prompt, then reported as null. */
  async function call<T>(role: Role, label: string, user: string, submitSchema: Record<string, unknown>, withGraph = false): Promise<T | null> {
    const system = [`ROLE: ${role}`, scope, ...(withGraph && graph ? [graph] : []), SUBMIT_NOTE].join('\n\n')
    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await runAgent<T>({
        client: o.client,
        model: o.model,
        label,
        system,
        user,
        sandbox,
        submitSchema,
        effort: o.effort,
        onEvent: o.onEvent,
        transcriptPath: transcriptPath(o.transcriptDir, label, attempt),
      })
      agents.push({ label: attempt === 1 ? label : `${label} (retry)`, turns: res.turns, seconds: res.seconds, stopReason: res.stopReason, usage: res.usage })
      addUsage(usage, res.usage)
      if (res.stopReason === 'submitted' && res.result != null) return res.result
      emit('warn', label, `attempt ${attempt} ended with ${res.stopReason}${res.error ? `: ${res.error}` : ''}${attempt === 1 ? '; retrying once' : ''}`)
    }
    return null
  }

  emit('phase', 'Enumerate')
  const plan = await call<Plan>('enumerate', 'enumerate', enumeratePrompt(systemName, audience, srcHint), PLAN_SCHEMA, true)
  if (!plan) throw new Error('the enumerate agent did not submit a plan after a retry; nothing to course')
  writeJson(path.join(workDir, 'plan.json'), {
    systemName: plan.systemName,
    oneLiner: plan.oneLiner,
    elevatorPitch: plan.elevatorPitch,
    outOfScope: plan.outOfScope ?? [],
    audience,
    depth,
    repoUrl: o.repoUrl ?? null,
    domains: plan.domains ?? [],
  })

  emit('phase', 'Data model')
  const dataModel = await call<DataModel>('data-model', 'data-model', dataModelPrompt(systemName, srcHint), DATAMODEL_SCHEMA, true)
  const entities = dataModel?.entities ?? []
  if (!dataModel) warn('data-model', 'no data model submitted after a retry; the course ships without an ER backbone')
  writeJson(path.join(workDir, 'datamodel.json'), { entities })

  // Bound here: the null-check narrowing of `plan` does not reach the hoisted function below.
  const { oneLiner } = plan
  const drop = (d: Domain, step: string): null => {
    warn(`${step}:${d.id}`, `dropping domain "${d.id}": its ${step} agent did not submit after a retry`)
    return null
  }
  async function authorAndVerify(d: Domain): Promise<ModuleSummary | null> {
    const files = d.files ?? []
    const user = audience === 'non-technical' ? authorNonTechnicalPrompt(systemName, oneLiner, d, files) : authorPrompt(systemName, oneLiner, d, files)
    const draft = await call<DraftModule>('author', `author:${d.id}`, user, MODULE_SCHEMA)
    if (!draft) return drop(d, 'author')
    // The disk bus keys a module by its domain id; an agent that picked another id is corrected.
    draft.id = d.id
    writeJson(path.join(workDir, 'drafts', `${d.id}.json`), draft)
    const codeBlocks = codeBlockCount(draft)
    if (!codeBlocks) {
      writeJson(path.join(workDir, 'modules', `${d.id}.json`), draft)
      return { id: d.id, title: draft.title, verified: 0, total: 0, dropped: 0 }
    }
    const v = await call<VerifyResult>('verify', `verify:${d.id}`, verifyPrompt(draft), VERIFY_SCHEMA)
    if (!v?.module) return drop(d, 'verify')
    v.module.id = d.id
    writeJson(path.join(workDir, 'modules', `${d.id}.json`), v.module)
    return { id: d.id, title: v.module.title, verified: v.verified, total: v.total, dropped: v.dropped }
  }

  const summaries: ModuleSummary[] = []
  const seen = new Set<string>()
  const limited = limiter(o.concurrency ?? 3)
  let toAuthor: Domain[] = plan.domains ?? []
  for (let round = 0; round < maxRounds; round++) {
    const batch = toAuthor.filter((d) => d && d.id && !seen.has(d.id))
    if (!batch.length) break
    batch.forEach((d) => seen.add(d.id))
    log(`Round ${round + 1}: authoring ${batch.length} domain(s): ${batch.map((d) => d.id).join(', ')}`)

    emit('phase', 'Author + verify')
    const results = await Promise.all(batch.map((d) => limited(() => authorAndVerify(d))))
    summaries.push(...results.filter((s): s is ModuleSummary => s !== null))

    emit('phase', 'Completeness')
    const covered = summaries.map((s) => `- ${s.id}: ${s.title}`).join('\n')
    const crit = await call<CriticVerdict>('critic', `completeness:r${round + 1}`, criticPrompt(systemName, audience, srcHint, covered), CRITIC_SCHEMA, true)
    if (!crit) {
      warn(`completeness:r${round + 1}`, 'the completeness critic did not submit after a retry; treating the course as complete')
      break
    }
    log(`Round ${round + 1}: ${summaries.length} modules; complete=${crit.complete}; gaps=${(crit.missingDomains || []).length}`)
    if (crit.complete || !(crit.missingDomains || []).length) break
    toAuthor = crit.missingDomains
  }

  const totals = summaries.reduce((a, s) => ({ verified: a.verified + (s.verified || 0), total: a.total + (s.total || 0), dropped: a.dropped + (s.dropped || 0) }), { verified: 0, total: 0, dropped: 0 })
  log(`DONE: ${summaries.length} modules in ${workDir}/modules/, ${entities.length} data-model entities, grounding ${totals.verified}/${totals.total} in-loop (${totals.dropped} dropped)`)
  if (!summaries.length) throw new Error('every domain was dropped (no agent submitted a module); nothing to assemble')

  emit('phase', 'Assemble')
  const assembled = assemble({ dir: workDir, system: systemName, repo: repoPath, root: o.root, out: o.out })
  const g = assembled.grounding
  return {
    workDir,
    bundlePath: assembled.outPath,
    modules: assembled.bundle.modules.map((m) => m.id),
    dataModelEntities: entities.length,
    grounding: g && { total: g.total, verified: g.verified, exact: g.exact, drifted: g.drifted, missingFile: g.missingFile },
    agents,
    usage,
    estimatedCostUsd: estimateCostUsd(o.model, usage),
    seconds: (Date.now() - started) / 1000,
  }
}

// ── Prompts (the workflow's text; only the file-writing instructions changed to submit_result) ──
function enumeratePrompt(systemName: string, audience: Audience, srcHint: string): string {
  return `Scope a COMPREHENSIVE ${audience} onboarding course for "${systemName}". Read the README, ${srcHint}/__init__.py (or index/entrypoint), and each module file under ${srcHint}/.\n\nReturn: a precise one-liner (what it does in real terms), an elevator pitch (2-4 sentences on the core model + the non-obvious parts a newcomer trips on), what is explicitly out of scope, and the COMPLETE set of teachable domains — one per major subsystem/feature. For each domain: a kebab id, a title, the real repo-relative files that implement it, and what it covers. Be exhaustive: a new contributor should understand the WHOLE system (typically 8-12 domains). Do NOT under-scope.\n\nSubmit the plan via submit_result.`
}

function dataModelPrompt(systemName: string, srcHint: string): string {
  return `Extract the CANONICAL DATA MODEL of "${systemName}" — the core persistent / state entities a newcomer must hold in their head, NOT every concept. Read the model / schema / state-machine / type files under ${srcHint} (e.g. models, *-status, types, lib). Return entities: each {id (kebab), name, one-sentence definition} plus relationships [{to (another entity id you also list), cardinality, label}]. Aim for ~8-20 entities with real relationships — this is the ER backbone. Only include edges between entities you list.\n\nSubmit the data model via submit_result.`
}

function authorPrompt(systemName: string, oneLiner: string, d: Domain, files: string[]): string {
  return `Author ONE deep module of a developer onboarding course for "${systemName}" (${oneLiner}).\n\nDOMAIN: ${d.title}\nMODULE ID: ${d.id} (use exactly this id)\nCOVERS: ${d.covers}\nFILES: ${files.join(', ')}\n\nREAD those files first. Then produce a DraftModule:\n- concept-first lessons: each a short prose explanation (markdown), then 1-3 REAL code snippets copied VERBATIM from the files (8-20 lines each, with the exact repo-relative sourcePath), and optionally a gotcha/note callout for a real trap.\n- the real concepts of this domain (id kebab, name, plain one-sentence definition).\n- 2-4 misconception quizzes: actual traps a newcomer hits, each an MCQ with exactly one correct option + 1-2 distractors (each distractor an ifChosen correction), an explanation, and a {trap, correction}.\nSnippets MUST be copied verbatim from the files (they are verified against source, including a line-exact check). Be deep, precise, and honest.\n\nSubmit the finished module via submit_result (a later pass verifies its snippets against source and finalizes it).`
}

function authorNonTechnicalPrompt(systemName: string, oneLiner: string, d: Domain, files: string[]): string {
  return `Author ONE module of a NON-TECHNICAL onboarding course for "${systemName}" (${oneLiner}) — for PMs, designers, and stakeholders, NOT engineers.\n\nDOMAIN: ${d.title}\nMODULE ID: ${d.id} (use exactly this id)\nCOVERS: ${d.covers}\nFILES (your ground truth to READ, never to quote): ${files.join(', ')}\n\nREAD those files first so every claim is true, then produce a DraftModule in PLAIN ENGLISH:\n- concept-first lessons: short analogy-first prose (markdown) explaining what happens and why it matters in business terms — NO code snippets at all (leave lessons' code arrays empty), no jargon without a plain gloss; optionally a gotcha/note callout for a real trap phrased plainly.\n- the real concepts of this domain (id kebab, name, plain one-sentence definition a non-engineer understands).\n- 2-4 misconception quizzes in plain language: actual traps, each an MCQ with exactly one correct option + 1-2 distractors (each distractor an ifChosen correction), an explanation, and a {trap, correction}.\nEvery factual claim must still come from the real files you read. Be clear, honest, and concrete.\n\nSubmit the finished module via submit_result (there are no code snippets to verify).`
}

function verifyPrompt(draft: DraftModule): string {
  return `Verify and FINALIZE a drafted course module.\n\n1. The draft module JSON is included below.\n2. For EACH code entry in each lesson, read its sourcePath (repo-relative) and decide:\n   - keep it if the snippet faithfully appears in the file (trivial whitespace / teaching-elision is fine),\n   - if it does NOT appear (drifted), REPLACE the snippet text with a VERBATIM contiguous copy from the real file (8-20 lines) that best teaches the same point,\n   - if the file does not exist, DELETE that code entry.\n   Prefer exact contiguous copies of source (they earn a stronger grounding mark).\n3. Submit via submit_result the finalized module as \`module\` — IDENTICAL to the draft except for the snippet corrections/deletions above. Do not rewrite prose, ids, quizzes, captions, or anything else.\n4. Alongside it submit id, verified (blocks now faithful), total (blocks in the draft), dropped (deleted entries).\n\n${DRAFT_MARKER}\n${JSON.stringify(draft, null, 2)}`
}

function criticPrompt(systemName: string, audience: Audience, srcHint: string, covered: string): string {
  return `A ${audience} onboarding course for "${systemName}" currently has these modules:\n${covered}\n\nScan the repo (especially ${srcHint}/) and judge whether the course COMPREHENSIVELY covers the system for a new contributor. If a substantial subsystem/feature is NOT yet covered, return it in missingDomains (id, title, real files, what it covers). If coverage is genuinely complete, complete=true and missingDomains=[]. Be rigorous about real gaps; do not invent trivial ones.`
}

/** The workflow's GRAPH block with a repo-relative path. The sandbox reads only inside the repo, so a graph elsewhere (or absent) yields no block. */
function graphBlock(repoPath: string, graphPath?: string): string | null {
  const abs = path.resolve(repoPath, graphPath ?? 'graphify-out/graph.json')
  const rel = path.relative(repoPath, abs)
  if (!existsSync(abs) || rel.startsWith('..') || path.isAbsolute(rel)) return null
  const p = rel.split(path.sep).join('/')
  return `DETERMINISTIC BACKBONE: check whether ${p} exists. If it does, READ IT FIRST — it is an AST-derived code graph (nodes = real files/functions/classes/components with paths; edges = imports/calls/renders). Use it as the authoritative inventory of WHAT EXISTS and WHAT CONNECTS (enumerate from its nodes, cross-check relationships against its edges — do not invent files or connections it contradicts). The SOURCE FILES remain ground truth for content and behavior; the graph is the map, not the territory. If it does not exist, proceed by reading the repo directly.`
}

function transcriptPath(dir: string | undefined, label: string, attempt: number): string | undefined {
  if (!dir) return undefined
  return path.join(dir, `${label.replace(/[^\w.-]+/g, '-')}${attempt > 1 ? '.retry' : ''}.jsonl`)
}

function codeBlockCount(m: DraftModule): number {
  return (m.lessons ?? []).reduce((n, l) => n + (l.code?.length ?? 0), 0)
}

function writeJson(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2))
}

function addUsage(total: AgentUsage, u: AgentUsage): void {
  total.input_tokens += u.input_tokens
  total.output_tokens += u.output_tokens
  total.cache_read_input_tokens += u.cache_read_input_tokens
  total.cache_creation_input_tokens += u.cache_creation_input_tokens
}

/** Run at most n tasks at once; the rest wait their turn in FIFO order. */
function limiter(n: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: (() => void)[] = []
  return async (task) => {
    if (active >= n) await new Promise<void>((wake) => waiting.push(wake))
    active++
    try {
      return await task()
    } finally {
      active--
      waiting.shift()?.()
    }
  }
}
