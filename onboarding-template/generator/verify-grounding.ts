/**
 * Grounding verification — the trust moat.
 *
 * For every `code` block that cites a `sourcePath`, check that the snippet's
 * distinctive identifiers still appear in the real source file. This catches two
 * things at once: hallucinated snippets (never grounded) and DRIFT (the repo moved
 * past the course). Token-set coverage (not exact substring) is deliberate: faithful
 * teaching snippets are often simplified (TypeScript types stripped, dev-only lines
 * dropped), so we verify the identifiers survived rather than demanding a byte match.
 *
 * Pure + fs-free so it unit-tests with an injected reader; the CLI supplies a real one.
 */
import type { OnboardingBundle } from '../schema/bundle'

export type GroundingStatus = 'verified' | 'partial' | 'drifted' | 'missing-file' | 'no-source'

export interface CodeBlockRef {
  moduleId: string
  lessonId: string
  blockIndex: number
  sourcePath?: string
  excerpt?: 'verbatim' | 'adapted'
  code: string
}
export interface GroundingResult {
  ref: CodeBlockRef
  status: GroundingStatus
  /** 0..1 fraction of the snippet's distinctive tokens found in the cited file. */
  coverage: number
  /** True when the snippet is a contiguous, whitespace-normalized COPY of the source
   *  (a byte-faithful excerpt) — the strongest grounding claim, above token coverage. */
  exact: boolean
  /** 1-based inclusive source lines of an exact match — powers #L deep-links in the UI. */
  lineRange?: { start: number; end: number }
}
export interface GroundingSummary {
  total: number
  verified: number
  partial: number
  drifted: number
  missingFile: number
  noSource: number
  /** How many snippets are exact (contiguous, whitespace-normalized) copies of source. */
  exact: number
}

/** Returns the file text for a repo-relative path, or null if it does not exist. */
export type FileReader = (sourcePath: string) => string | null

// Ultra-common keywords carry no grounding signal — they appear in every file.
const STOP = new Set([
  'const', 'let', 'var', 'function', 'return', 'this', 'new', 'typeof', 'void', 'import',
  'export', 'from', 'default', 'class', 'extends', 'interface', 'type', 'public', 'private',
  'async', 'await', 'yield', 'case', 'switch', 'break', 'continue', 'true', 'false', 'null',
  'undefined', 'else', 'for', 'while', 'try', 'catch', 'finally', 'throw',
])

const ident = /[A-Za-z_$][\w$]*/g

/** Distinctive identifiers worth grounding on: length >= 3, not a keyword, de-duped. */
export function distinctiveTokens(code: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of code.match(ident) ?? []) {
    if (t.length < 3 || STOP.has(t) || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/** Fraction of the snippet's distinctive tokens that appear anywhere in the file. */
export function coverageOf(code: string, fileText: string): number {
  const toks = distinctiveTokens(code)
  if (!toks.length) return 1
  const fileToks = new Set(fileText.match(ident) ?? [])
  return toks.filter((t) => fileToks.has(t)).length / toks.length
}

const normWs = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * True when the snippet is a contiguous, whitespace-normalized COPY of the source —
 * a byte-faithful excerpt (indentation/line-wrap differences allowed). Elided snippets
 * (`# ...`, trimmed middles) break contiguity and correctly fail this stronger check,
 * falling back to token coverage. A short floor avoids trivial substring matches.
 */
export function exactMatch(code: string, fileText: string): boolean {
  const snip = normWs(code)
  if (snip.length < 24) return false
  return normWs(fileText).includes(snip)
}

/**
 * Locate an exact snippet in its source file as a 1-based line range, by matching the
 * snippet's non-empty trimmed lines as a consecutive run of the file's trimmed lines.
 * Returns null when the snippet isn't line-contiguous in the file (elisions, rewrites).
 */
export function findLineRange(code: string, fileText: string): { start: number; end: number } | null {
  const snipLines = code.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  if (!snipLines.length) return null
  const fileLines = fileText.split('\n')
  for (let i = 0; i < fileLines.length; i++) {
    if (fileLines[i].trim() !== snipLines[0]) continue
    // candidate start — walk the file skipping blank lines, matching every snippet line in order
    let fi = i
    let matched = 0
    while (fi < fileLines.length && matched < snipLines.length) {
      const ft = fileLines[fi].trim()
      if (ft.length === 0) {
        fi++
        continue
      }
      if (ft !== snipLines[matched]) break
      matched++
      fi++
    }
    if (matched === snipLines.length) return { start: i + 1, end: fi }
  }
  return null
}

export function statusFor(coverage: number, excerpt?: 'verbatim' | 'adapted'): GroundingStatus {
  const verifiedAt = excerpt === 'verbatim' ? 0.85 : 0.6
  if (coverage >= verifiedAt) return 'verified'
  if (coverage >= 0.3) return 'partial'
  return 'drifted'
}

export function collectCodeBlocks(bundle: OnboardingBundle): CodeBlockRef[] {
  const out: CodeBlockRef[] = []
  for (const m of bundle.modules)
    for (const lesson of m.lessons)
      lesson.blocks.forEach((b, i) => {
        if (b.type === 'code')
          out.push({
            moduleId: m.id,
            lessonId: lesson.id,
            blockIndex: i,
            sourcePath: b.sourcePath,
            excerpt: b.excerpt,
            code: b.code,
          })
      })
  return out
}

export function verifyGrounding(bundle: OnboardingBundle, read: FileReader): GroundingResult[] {
  return collectCodeBlocks(bundle).map((ref) => {
    if (!ref.sourcePath) return { ref, status: 'no-source', coverage: 0, exact: false }
    const text = read(ref.sourcePath)
    if (text == null) return { ref, status: 'missing-file', coverage: 0, exact: false }
    const exact = exactMatch(ref.code, text)
    const coverage = coverageOf(ref.code, text)
    // Exact copies are the strongest claim → always 'verified'. Otherwise fall back to
    // token coverage. A snippet that CLAIMS verbatim but isn't an exact copy is flagged
    // (capped at 'partial') rather than rubber-stamped.
    let status: GroundingStatus = exact ? 'verified' : statusFor(coverage, ref.excerpt)
    if (!exact && ref.excerpt === 'verbatim' && status === 'verified') status = 'partial'
    const lineRange = exact ? findLineRange(ref.code, text) ?? undefined : undefined
    return { ref, status, coverage, exact, lineRange }
  })
}

export function summarize(results: GroundingResult[]): GroundingSummary {
  const c: GroundingSummary = { total: results.length, verified: 0, partial: 0, drifted: 0, missingFile: 0, noSource: 0, exact: 0 }
  for (const r of results) {
    if (r.exact) c.exact++
    if (r.status === 'verified') c.verified++
    else if (r.status === 'partial') c.partial++
    else if (r.status === 'drifted') c.drifted++
    else if (r.status === 'missing-file') c.missingFile++
    else c.noSource++
  }
  return c
}

/**
 * SME questions surfaced from the content — the checklist a human answers in the
 * refine pass. Pulled from callout.smeQuestion and open-question decision items.
 */
export function collectOpenQuestions(bundle: OnboardingBundle): string[] {
  const out: string[] = []
  for (const m of bundle.modules)
    for (const lesson of m.lessons)
      for (const blk of lesson.blocks) {
        if (blk.type === 'callout' && blk.smeQuestion) out.push(blk.smeQuestion)
        if (blk.type === 'decisions')
          for (const it of blk.items) if (it.sme) out.push(it.sme)
      }
  return out
}
