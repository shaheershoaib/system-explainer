/**
 * An offline model that plays the five course roles (enumerate, data-model, author, verify,
 * critic) with schema-valid, repo-derived answers, so the whole loop runs without an API key.
 *
 * It never touches the network or the filesystem: file contents reach it only as tool_results the
 * runner produced, and it reads its role and mode from the `ROLE:` and `MODE:` lines runCourse puts
 * first in every system prompt. Given the same conversation it always answers the same way.
 */
import type Anthropic from '@anthropic-ai/sdk'
import { DRAFT_MARKER, SOURCES_HEADER, type DataModel, type DataModelEntity, type DraftCode, type DraftModule, type Domain, type Plan, type Role, type VerifyResult } from './course'
import type { CourseMode } from './ingest/types'
import type { FakeStep } from './llm/fake'

type Params = Anthropic.MessageCreateParamsNonStreaming

interface ToolResult {
  content: string
  isError: boolean
}

/** The role runCourse tagged this agent with (`ROLE: <role>` on the system prompt's first line). */
export function roleOf(params: Params): Role | null {
  const m = /^ROLE: (\S+)/m.exec(systemText(params))
  return m ? (m[1] as Role) : null
}

/** The mode runCourse tagged this agent with (`MODE: <mode>` on the second line); 'code' when absent. */
export function modeOf(params: Params): CourseMode {
  const m = /^MODE: (\S+)/m.exec(systemText(params))?.[1]
  return m === 'documents' || m === 'mixed' ? m : 'code'
}

export function createFakeCoursePlayer(repoDir: string): (callIndex: number, params: Params) => FakeStep {
  const prefix = repoDir.replace(/\/+$/, '') + '/'
  // Prompts cite repo-relative paths; an absolute one under the repo is tolerated and relativized.
  const rel = (p: string) => (p.startsWith(prefix) ? p.slice(prefix.length) : p)
  return (_callIndex, params) => {
    const role = roleOf(params)
    const task = taskText(params)
    const results = toolResults(params)
    const mode = modeOf(params)
    if (mode !== 'code') {
      const sources = sourcesOf(params)
      switch (role) {
        case 'enumerate':
          return playEnumerateDocs(task, mode === 'mixed' ? srcHintOf(params) : null, corpusRootOf(params), sources, results)
        case 'data-model':
          return mode === 'mixed' ? playDataModel(srcHintOf(params), results) : playDataModelDocs(sources, results)
        case 'author': {
          const files = filesOf(task, rel)
          return mode === 'documents' || sources.some((s) => s.path === files[0]) ? playAuthorDocs(task, files, sources, results) : playAuthor(task, results, rel)
        }
        case 'verify':
          return playVerify(task)
        case 'critic':
          return { submit: { complete: true, missingDomains: [] } }
        default:
          throw new Error('fake course player: the system prompt has no ROLE line')
      }
    }
    switch (role) {
      case 'enumerate':
        return playEnumerate(task, srcHintOf(params), results)
      case 'data-model':
        return playDataModel(srcHintOf(params), results)
      case 'author':
        return playAuthor(task, results, rel)
      case 'verify':
        return playVerify(task)
      case 'critic':
        return { submit: { complete: true, missingDomains: [] } }
      default:
        throw new Error('fake course player: the system prompt has no ROLE line')
    }
  }
}

// ── roles ─────────────────────────────────────────────────────────────────────────────────────
function playEnumerate(task: string, srcHint: string, results: ToolResult[]): FakeStep {
  if (!results.length) return { toolUse: [{ name: 'list_dir', input: { path: srcHint } }] }
  const files = filesIn(results[0])
  const systemName = /course for "([^"]+)"/.exec(task)?.[1] ?? 'system'
  const plan: Plan = {
    systemName,
    oneLiner: `${systemName}: ${files.length} source file(s) under ${srcHint}, taught one domain each.`,
    elevatorPitch: `A fixture-scale course. Every source file under ${srcHint} becomes its own domain, so each lesson can quote the file it teaches.`,
    outOfScope: [`Anything outside ${srcHint}`],
    domains: files.map(codeDomain),
  }
  return { submit: plan }
}

const codeDomain = (f: string): Domain => ({ id: kebab(stem(f)), title: titleOf(f), files: [f], covers: `What ${f} implements and how it is used.` })

/**
 * List the corpus root (and srcHint in mixed mode), then each directory under the corpus root, and
 * make one topic per markdown document (id: its directory name). Mixed mode keeps one domain per
 * source file as well.
 */
function playEnumerateDocs(task: string, srcHint: string | null, root: string, sources: SourceLine[], results: ToolResult[]): FakeStep {
  const first = [...(srcHint ? [srcHint] : []), root].map((p) => ({ name: 'list_dir', input: { path: p } }))
  if (!results.length) return { toolUse: first }
  const rootListing = results[first.length - 1]
  if (results.length === first.length) {
    const dirs = dirsIn(rootListing)
    if (dirs.length) return { toolUse: dirs.map((p) => ({ name: 'list_dir', input: { path: p } })) }
  }
  const codeFiles = srcHint ? filesIn(results[0]) : []
  const docs = [rootListing, ...results.slice(first.length)].flatMap(filesIn).filter((f) => f.endsWith('.md'))
  const systemName = /course for "([^"]+)"/.exec(task)?.[1] ?? 'system'
  const ids = new Set<string>()
  const topics = docs.map((f): Domain => {
    let id = kebab(dirOf(f))
    if (ids.has(id)) id = `${id}-${kebab(stem(f))}`
    ids.add(id)
    const title = sources.find((s) => s.path === f)?.title ?? titleOf(dirOf(f))
    return { id, title, files: [f], covers: `What "${title}" records.` }
  })
  const plan: Plan = {
    systemName,
    oneLiner: `${systemName}: ${docs.length} document(s)${codeFiles.length ? ` and ${codeFiles.length} source file(s)` : ''}, taught one topic each.`,
    elevatorPitch: 'A fixture-scale course. Every document becomes its own topic, so each lesson can quote the document it teaches.',
    outOfScope: ['Anything the documents do not say'],
    domains: [...codeFiles.map(codeDomain), ...topics],
  }
  return { submit: plan }
}

/** Read the oldest document and turn its capitalized terms into 2 to 4 entities with one relationship. */
function playDataModelDocs(sources: SourceLine[], results: ToolResult[]): FakeStep {
  const file = sources[0]?.path
  if (!results.length && file) return { toolUse: [{ name: 'read_file', input: { path: file } }] }
  const text = results[0] && !results[0].isError ? bodyOf(stripLineNumbers(results[0].content)) : ''
  const where = file ?? 'the documents'
  const byId = new Map<string, DataModelEntity>()
  for (const term of capitalizedTerms(text)) {
    const id = kebab(term)
    if (byId.size < 4 && id && !byId.has(id)) byId.set(id, { id, name: term, definition: `${term}, as ${where} refers to it.` })
  }
  const base = kebab(dirOf(file ?? 'corpus'))
  for (const id of [base, `${base}-document`]) if (byId.size < 2 && !byId.has(id)) byId.set(id, { id, name: id, definition: `The document ${where}.` })
  const entities = [...byId.values()]
  entities[0].relationships = [{ to: entities[1].id, cardinality: 'many-to-many', label: 'mentioned with' }]
  const model: DataModel = { entities }
  return { submit: model }
}

/** Read the topic's first document and quote its first one or two substantial body lines verbatim. */
function playAuthorDocs(task: string, files: string[], sources: SourceLine[], results: ToolResult[]): FakeStep {
  const file = files[0]
  if (!results.length && file) return { toolUse: [{ name: 'read_file', input: { path: file } }] }
  const id = /^MODULE ID: (\S+)/m.exec(task)?.[1] ?? kebab(dirOf(file ?? 'topic'))
  const title = /^(?:TOPIC|DOMAIN): (.+)$/m.exec(task)?.[1]?.trim() ?? id
  const src = sources.find((s) => s.path === file)
  const name = src ? `"${src.title}" (${src.date})` : (file ?? 'the documents')
  const text = results[0] && !results[0].isError ? stripLineNumbers(results[0].content) : ''
  const passage = file ? quoteFrom(text) : null
  const module: DraftModule = {
    id,
    title,
    objective: `Understand what ${name} records about ${title}.`,
    oneJob: `${title}, in one document`,
    concepts: [],
    lessons: [
      {
        title: `What ${name} says`,
        prose: `This topic rests on ${name}. The quote below is copied verbatim from it.`,
        quotes: file && passage ? [{ sourcePath: file, text: passage }] : [],
        callout: { variant: 'note', md: `Open question: ${name} does not say who owns ${title} from here.` },
      },
    ],
    quiz: [
      {
        prompt: `Which document is the source for ${title}?`,
        options: [
          { text: file ?? name, correct: true },
          { text: 'A summary written for this course', correct: false, ifChosen: `No: it comes from ${name}.` },
        ],
        explanation: `${title} is taught from ${name}.`,
        misconception: { trap: 'Assuming the course summarizes the documents in its own words.', correction: `It quotes ${name} directly.` },
      },
      {
        prompt: 'How are the quotes in this module checked?',
        options: [
          { text: 'They are paraphrased for readability', correct: false, ifChosen: 'No: a paraphrase is a misquote; quotes are copied verbatim.' },
          { text: 'They are copied verbatim and checked against the document', correct: true },
        ],
        explanation: 'Quotes are verbatim copies so they can be verified against the document they cite.',
        misconception: { trap: 'Treating quotes as approximate.', correction: 'They are exact, re-verified against the corpus.' },
      },
    ],
  }
  return { submit: module }
}

function playDataModel(srcHint: string, results: ToolResult[]): FakeStep {
  if (!results.length) return { toolUse: [{ name: 'list_dir', input: { path: srcHint } }] }
  const file = pickModelFile(filesIn(results[0]), srcHint)
  if (results.length === 1) return { toolUse: [{ name: 'read_file', input: { path: file } }] }
  const text = results[1].isError ? '' : stripLineNumbers(results[1].content)
  const byId = new Map<string, DataModelEntity>()
  for (const [kind, name] of exportsOf(text).slice(0, 4)) {
    const id = kebab(name)
    if (!byId.has(id)) byId.set(id, { id, name, definition: `The exported ${kind} ${name} in ${file}.` })
  }
  const base = kebab(stem(file))
  for (const id of [base, `${base}-module`]) if (byId.size < 2 && !byId.has(id)) byId.set(id, { id, name: id, definition: `The ${file} module.` })
  const entities = [...byId.values()]
  entities[0].relationships = [{ to: entities[1].id, cardinality: 'one-to-many', label: 'relates to' }]
  const model: DataModel = { entities }
  return { submit: model }
}

function playAuthor(task: string, results: ToolResult[], rel: (p: string) => string): FakeStep {
  const files = (/^FILES[^:\n]*: (.+)$/m.exec(task)?.[1] ?? '').split(',').map((s) => rel(s.trim())).filter(Boolean)
  const file = files[0]
  if (!results.length && file) return { toolUse: [{ name: 'read_file', input: { path: file } }] }
  const id = /^MODULE ID: (\S+)/m.exec(task)?.[1] ?? kebab(stem(file ?? 'module'))
  const title = /^DOMAIN: (.+)$/m.exec(task)?.[1]?.trim() ?? id
  const where = file ?? 'the repository'
  const text = file && results[0] && !results[0].isError ? stripLineNumbers(results[0].content) : ''
  const nonTechnical = /NON-TECHNICAL onboarding course/.test(task)
  const exported = exportsOf(text)[0]
  const module: DraftModule = {
    id,
    title,
    objective: `Understand what ${where} does and how a newcomer reads it.`,
    oneJob: `${title}, in one file`,
    concepts: exported ? [{ id: kebab(exported[1]), name: exported[1], definition: `The exported ${exported[0]} ${exported[1]} in ${where}.` }] : [],
    lessons: [
      {
        title: `Inside ${where}`,
        prose: `The ${title} domain lives in \`${where}\`. Read it top to bottom: the exports are the public surface and everything else supports them.`,
        code: file && text && !nonTechnical ? [snippetFrom(file, text)] : [],
        callout: { variant: 'note', md: `Every claim in this module was checked against ${where}.` },
      },
    ],
    quiz: [
      {
        prompt: `Which file implements ${title}?`,
        options: [
          { text: where, correct: true },
          { text: 'A generated file that is not in the repository', correct: false, ifChosen: `No: it lives in ${where}.` },
        ],
        explanation: `${title} is implemented in ${where}.`,
        misconception: { trap: `Assuming ${title} is spread across many files.`, correction: `It is one file: ${where}.` },
      },
      {
        prompt: 'Where does the code shown in this module come from?',
        options: [
          { text: 'It was written for the lesson', correct: false, ifChosen: 'No: snippets are copied verbatim from the source file.' },
          { text: `It is copied verbatim from ${where}`, correct: true },
        ],
        explanation: 'Snippets are verbatim copies so they can be verified against the source.',
        misconception: { trap: 'Treating course snippets as pseudocode.', correction: 'They are verbatim source, re-verified against the repository.' },
      },
    ],
  }
  return { submit: module }
}

function playVerify(task: string): FakeStep {
  const i = task.indexOf(DRAFT_MARKER)
  if (i < 0) throw new Error('fake course player: the verify prompt carries no draft')
  const module = JSON.parse(task.slice(i + DRAFT_MARKER.length)) as DraftModule
  const total = module.lessons.reduce((n, l) => n + (l.code?.length ?? 0) + (l.quotes?.length ?? 0), 0)
  const result: VerifyResult = { id: module.id, module, verified: total, total, dropped: 0 }
  return { submit: result }
}

// ── reading the conversation ─────────────────────────────────────────────────────────────────
function systemText(p: Params): string {
  const s = p.system
  if (!s) return ''
  return typeof s === 'string' ? s : s.map((b) => b.text).join('\n')
}

/** The task prompt: runAgent's first user message, always a plain string. */
function taskText(p: Params): string {
  const c = p.messages[0]?.content
  if (typeof c === 'string') return c
  return (c ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n')
}

function toolResults(p: Params): ToolResult[] {
  const out: ToolResult[] = []
  for (const m of p.messages) {
    if (m.role !== 'user' || typeof m.content === 'string') continue
    for (const b of m.content) if (b.type === 'tool_result') out.push({ content: resultText(b.content), isError: !!b.is_error })
  }
  return out
}

function resultText(c: Anthropic.ToolResultBlockParam['content']): string {
  if (!c) return ''
  return typeof c === 'string' ? c : c.map((b) => (b.type === 'text' ? b.text : '')).join('\n')
}

function srcHintOf(p: Params): string {
  return /Start by listing the repository root and (\S+?)\./.exec(systemText(p))?.[1] ?? 'src'
}

/** Files (not directories) in a list_dir result; an error or an empty directory yields none. */
function filesIn(r: ToolResult): string[] {
  if (r.isError) return []
  return r.content.split('\n').filter((l) => l && !l.endsWith('/') && !l.startsWith('('))
}

/** Directories in a list_dir result, without the trailing "/". */
function dirsIn(r: ToolResult): string[] {
  if (r.isError) return []
  return r.content.split('\n').filter((l) => l.endsWith('/')).map((l) => l.slice(0, -1))
}

interface SourceLine {
  path: string
  title: string
  kind: string
  date: string
  speakers: string
}

/** The SOURCES block runCourse puts in documents and mixed system prompts, one document per line. */
function sourcesOf(p: Params): SourceLine[] {
  const s = systemText(p)
  const at = s.indexOf(SOURCES_HEADER)
  if (at < 0) return []
  const out: SourceLine[] = []
  for (const line of s.slice(at + SOURCES_HEADER.length + 1).split('\n')) {
    if (!line.trim()) break
    const [path = '', title = '', kind = '', date = '', speakers = ''] = line.split(' | ')
    out.push({ path, title, kind, date, speakers })
  }
  return out
}

function corpusRootOf(p: Params): string {
  return /listing the corpus root \("([^"]*)"\)/.exec(systemText(p))?.[1] ?? '.'
}

function filesOf(task: string, rel: (p: string) => string): string[] {
  return (/^FILES[^:\n]*: (.+)$/m.exec(task)?.[1] ?? '').split(',').map((s) => rel(s.trim())).filter(Boolean)
}

/** The directory a corpus document sits in (its source's slug), or its stem when it sits at the root. */
function dirOf(f: string): string {
  const parts = f.split('/')
  return parts.length > 1 ? parts[parts.length - 2] : stem(f)
}

/** A document without its front matter. */
function bodyOf(text: string): string {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return text
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  return end < 0 ? '' : lines.slice(end + 1).join('\n')
}

/** The first body line of 30+ characters that is not a heading, plus the next line when it qualifies too. */
function quoteFrom(text: string): string | null {
  const lines = bodyOf(text).split('\n')
  const ok = (l: string | undefined) => !!l && l.trim().length >= 30 && !l.trim().startsWith('#')
  const i = lines.findIndex(ok)
  if (i < 0) return null
  return ok(lines[i + 1]) ? `${lines[i]}\n${lines[i + 1]}` : lines[i]
}

const NOT_TERMS = new Set(['The', 'This', 'That', 'These', 'Those', 'We', 'Our', 'They', 'Their', 'It', 'Its', 'And', 'But', 'For', 'With', 'When', 'What', 'Who', 'How', 'Why', 'Where', 'If', 'In', 'On', 'At', 'To', 'As', 'So', 'No', 'Yes', 'Every', 'Nobody'])

/** Runs of capitalized words ("Billing Service", "Postgres"), in order of first appearance, minus sentence starters. */
function capitalizedTerms(text: string): string[] {
  const seen = new Set<string>()
  for (const m of text.matchAll(/\b[A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+)*/g)) if (m[0].length >= 3 && !NOT_TERMS.has(m[0])) seen.add(m[0])
  return [...seen]
}

function pickModelFile(files: string[], srcHint: string): string {
  return files.find((f) => /type|model|schema|entit|event/i.test(f)) ?? files[0] ?? `${srcHint}/index.ts`
}

/** Undo the sandbox's "N<TAB>text" numbering and drop its truncation note. */
function stripLineNumbers(content: string): string {
  return content
    .split('\n')
    .filter((l) => !l.startsWith('... (truncated;'))
    .map((l) => l.replace(/^\d+\t/, ''))
    .join('\n')
}

const EXPORT = /^\s*export\s+(?:default\s+)?(?:async\s+)?(function|class|interface|type|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/gm

/** [kind, name] per exported declaration, in file order, unique by name. */
function exportsOf(text: string): [string, string][] {
  const seen = new Set<string>()
  const out: [string, string][] = []
  for (const m of text.matchAll(EXPORT)) {
    if (seen.has(m[2])) continue
    seen.add(m[2])
    out.push([m[1], m[2]])
  }
  return out
}

/** A contiguous run of 4 to 8 lines starting at the first export (or as late as the file allows), copied verbatim. */
function snippetFrom(sourcePath: string, text: string): DraftCode {
  const lines = text.split('\n')
  const firstExport = Math.max(0, lines.findIndex((l) => /\bexport\b/.test(l)))
  const start = Math.min(firstExport, Math.max(0, lines.length - 4))
  const run = lines.slice(start, start + 8)
  return { caption: `${sourcePath}, lines ${start + 1}-${start + run.length}`, language: languageOf(sourcePath), sourcePath, snippet: run.join('\n') }
}

const LANGUAGES: Record<string, string> = { ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', py: 'python', go: 'go', rs: 'rust', rb: 'ruby', java: 'java' }
const languageOf = (p: string) => LANGUAGES[p.split('.').pop() ?? ''] ?? 'text'
const stem = (p: string) => (p.split('/').pop() ?? p).replace(/\.[^.]+$/, '')
const kebab = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
const titleOf = (f: string) => {
  const s = stem(f)
  return s.charAt(0).toUpperCase() + s.slice(1)
}
