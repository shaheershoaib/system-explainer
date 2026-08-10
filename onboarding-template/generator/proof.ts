/**
 * Proof harness — the deterministic half of the "verifier" thesis.
 *
 *   npx tsx generator/proof.ts prep   --system <id> --bundle <bundle.json> [--modules a,b,c]
 *   npx tsx generator/proof.ts report --system <id> --bundle <bundle.json>
 *
 * `prep` turns a bundle into agent-facing inputs under proof-runs/<id>/:
 *   - inputs/<mod>.lesson.md   the module rendered to text WITHOUT the quiz (the "learner view")
 *   - inputs/<mod>.quiz.json   the quiz with the answer key stripped + options deterministically shuffled
 *   - inputs/<mod>.claims.json the prose/callout assertions + cited source paths (for the refuter)
 *   - keys/<mod>.key.json      the hidden answer key (report-only; never shown to the learner agent)
 *
 * Agents then write their verdicts/answers under:
 *   - adversarial/<mod>.json   { moduleId, claims:[{claim, verdict, evidence, note}] }
 *   - learner/<mod>.json       { moduleId, mode:'taught', answers:[{id, choice}] }
 *   - learner-cold/<mod>.json  { moduleId, mode:'cold',   answers:[{id, choice}] }
 *
 * `report` scores the learner against the key (cold run is the control = course "lift"), tallies the
 * adversarial verdicts, folds in the grounding gate, and writes proof-runs/<id>/PROOF_REPORT.md.
 *
 * The agent passes are LLM-driven (adversarial refute + simulated learner). Everything in this file
 * is pure + testable: stripping/shuffling, scoring, tallying, and report rendering.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const arg = (n: string): string | undefined => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const KEYS = 'abcdefgh'

// ── deterministic shuffle (reproducible: same bundle → same prep) ─────────────
export function hash(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
export function seededShuffle<T>(arr: T[], seed: string): T[] {
  return arr
    .map((v, i) => [v, hash(`${seed}#${i}`)] as [T, number])
    .sort((a, b) => a[1] - b[1])
    .map((x) => x[0])
}

// ── learner view: render a module's lessons to text, no quiz, no answer leakage ─
export function renderLessons(m: any): string {
  const out: string[] = [`# ${m.title}`, '', `> ${m.objective || ''}`, '']
  for (const l of m.lessons || []) {
    out.push(`## ${l.title}`, '')
    for (const b of l.blocks || []) {
      switch (b.type) {
        case 'prose':
          if (b.heading) out.push(`### ${b.heading}`)
          out.push(b.md, '')
          break
        case 'mental-model':
          out.push(b.md || '', b.entities?.length ? `_Entities: ${b.entities.join(', ')}_` : '', '')
          break
        case 'predict-reveal':
          out.push(`*${b.prompt}*`, b.reveal, '')
          break
        case 'code':
          out.push('```' + (b.language || ''), b.code, '```', b.caption ? `_${b.caption}_` : '', '')
          break
        case 'worked-example':
          out.push(`**${b.title}**`)
          for (const s of b.steps || []) out.push(`- ${s.label}${s.compute ? `: ${s.compute}` : ''}${s.note ? ` (${s.note})` : ''}`)
          out.push('')
          break
        case 'callout':
          out.push(`> **${b.variant}:** ${b.md}`, '')
          break
        case 'code-map':
          out.push(`**${b.title || 'Where it lives'}**`)
          for (const e of b.entries || []) out.push(`- ${e.label}: ${(e.files || []).map((f: any) => f.path).join(', ')}`)
          out.push('')
          break
        case 'decisions':
          out.push(`**${b.title || 'Decisions'}**`)
          for (const it of b.items || []) out.push(`- ${it.title} — ${it.rationale} _(${it.status})_`)
          out.push('')
          break
        case 'sources':
          out.push(`**${b.title || 'Sources'}**`)
          for (const it of b.items || []) out.push(`- [${it.kind}] ${it.label}${it.detail ? ` — ${it.detail}` : ''}`)
          out.push('')
          break
        case 'diagram':
          out.push(`_(Diagram: ${b.diagram?.kind}${b.diagram?.title ? ` — ${b.diagram.title}` : ''}${b.diagram?.scope?.length ? `; covering ${b.diagram.scope.join(', ')}` : ''})_`, '')
          break
        case 'simulation':
          out.push(`_(Interactive simulation: ${b.title || b.simulationId})_`, '')
          break
        case 'screen':
          out.push(`_(Annotated app screen: ${b.title || b.screenId})_`, '')
          break
        case 'exercise':
          out.push(`*Exercise (${b.kind}): ${b.prompt}*`, b.hint ? `_Hint: ${b.hint}_` : '', '')
          break
      }
    }
  }
  return out.join('\n')
}

// ── quiz: strip the answer key + shuffle, returning the learner view + hidden key ─
type LearnerQuizItem = any
type KeyItem = { id: string; type: string; correct: any; notAutoScored?: boolean }
export function buildLearnerQuiz(m: any): { quiz: LearnerQuizItem[]; key: KeyItem[] } {
  const quiz: LearnerQuizItem[] = []
  const key: KeyItem[] = []
  for (const q of m.quiz || []) {
    if (q.type === 'mcq') {
      const shuffled = seededShuffle(q.options as any[], `${m.id}:${q.id}`)
      const options = shuffled.map((o: any, i: number) => ({ key: KEYS[i], text: o.text }))
      const correctKey = KEYS[shuffled.findIndex((o: any) => o.correct)]
      quiz.push({ id: q.id, type: 'mcq', prompt: q.prompt, options })
      key.push({ id: q.id, type: 'mcq', correct: correctKey })
    } else if (q.type === 'ordering') {
      const shuffled = seededShuffle(q.items as any[], `${m.id}:${q.id}`)
      const items = shuffled.map((it: any, i: number) => ({ key: KEYS[i], text: it.text }))
      // canonical order = original order of q.items; express it in the presented keys
      const correctSeq = (q.items as any[]).map((orig: any) => KEYS[shuffled.findIndex((s: any) => s.id === orig.id)])
      quiz.push({ id: q.id, type: 'ordering', prompt: q.prompt, items, instruction: 'Return the keys as an array in the correct order.' })
      key.push({ id: q.id, type: 'ordering', correct: correctSeq })
    } else if (q.type === 'spot-bug') {
      quiz.push({ id: q.id, type: 'spot-bug', prompt: q.prompt, language: q.language, lines: q.lines, instruction: 'Return { buggyLine: <1-based line number>, fix: <how to fix it> }.' })
      key.push({ id: q.id, type: 'spot-bug', correct: { buggyLine: q.buggyLine, fix: q.fix } })
    } else if (q.type === 'short-answer') {
      quiz.push({ id: q.id, type: 'short-answer', prompt: q.prompt, instruction: 'Answer in 1-3 sentences.' })
      key.push({ id: q.id, type: 'short-answer', correct: { modelAnswer: q.modelAnswer, rubricKeywords: q.rubricKeywords }, notAutoScored: true })
    }
  }
  return { quiz, key }
}

// ── hardened comprehension quiz: strip + shuffle agent-generated 4-option items ─
// The quizgen agent writes raw items [{id, prompt, options:[{text, correct}]}] whose
// distractors are real-but-wrong domain facts (not guessable). We strip the flag and
// shuffle so the learner agent cannot cheat, exactly like the course quiz.
export function buildGenQuiz(rawItems: any[], moduleId: string): { quiz: any[]; key: KeyItem[]; rejected: { id: string; reason: string }[] } {
  const quiz: any[] = []
  const key: KeyItem[] = []
  const rejected: { id: string; reason: string }[] = []
  for (const q of rawItems || []) {
    const opts = (q.options || []).filter((o: any) => o && o.text)
    if (opts.length < 2 || !opts.some((o: any) => o.correct)) {
      rejected.push({ id: q?.id ?? '?', reason: 'malformed (needs ≥2 options and exactly one correct)' })
      continue
    }
    // duplicate option texts make the item a coin flip — a corrupted measurement, not a question
    const norms = opts.map((o: any) => String(o.text).replace(/\s+/g, ' ').trim().toLowerCase())
    if (new Set(norms).size !== norms.length) {
      rejected.push({ id: q.id, reason: 'duplicate option texts' })
      continue
    }
    const shuffled = seededShuffle(opts as any[], `gen:${moduleId}:${q.id}`)
    const options = shuffled.map((o: any, i: number) => ({ key: KEYS[i], text: o.text }))
    const correctKey = KEYS[shuffled.findIndex((o: any) => o.correct)]
    quiz.push({ id: q.id, type: 'mcq', prompt: q.prompt, options })
    key.push({ id: q.id, type: 'mcq', correct: correctKey })
  }
  return { quiz, key, rejected }
}

// ── claims: the assertions an adversarial refuter will try to break ───────────
export function collectClaims(m: any): { id: string; text: string }[] {
  const claims: { id: string; text: string }[] = []
  for (const l of m.lessons || [])
    for (let bi = 0; bi < (l.blocks || []).length; bi++) {
      const b = l.blocks[bi]
      if (b.type === 'prose') claims.push({ id: `${l.id}-b${bi}`, text: b.md })
      else if (b.type === 'callout') claims.push({ id: `${l.id}-b${bi}`, text: `[${b.variant}] ${b.md}` })
      else if (b.type === 'mental-model' && b.md) claims.push({ id: `${l.id}-b${bi}`, text: b.md })
    }
  return claims
}
export function collectCitedPaths(m: any): string[] {
  const s = new Set<string>()
  for (const l of m.lessons || []) for (const b of l.blocks || []) if (b.type === 'code' && b.sourcePath) s.add(b.sourcePath)
  return [...s]
}

// ── scoring ───────────────────────────────────────────────────────────────────
export function scoreItem(type: string, choice: any, correct: any): { scorable: boolean; correct: boolean; partial: number } {
  if (type === 'mcq') {
    const ok = String(choice).trim().toLowerCase() === String(correct).trim().toLowerCase()
    return { scorable: true, correct: ok, partial: ok ? 1 : 0 }
  }
  if (type === 'ordering') {
    const a: string[] = Array.isArray(choice) ? choice.map((x) => String(x).trim().toLowerCase()) : []
    const b: string[] = (correct as string[]).map((x) => String(x).trim().toLowerCase())
    if (!a.length) return { scorable: true, correct: false, partial: 0 }
    const positional = b.filter((k, i) => a[i] === k).length / b.length
    return { scorable: true, correct: positional === 1, partial: positional }
  }
  if (type === 'spot-bug') {
    const got = choice && (typeof choice === 'object' ? choice.buggyLine : choice)
    const ok = Number(got) === Number(correct?.buggyLine)
    return { scorable: true, correct: ok, partial: ok ? 1 : 0 }
  }
  return { scorable: false, correct: false, partial: 0 } // short-answer: not auto-scored
}

export function scoreLearner(answers: { id: string; choice: any }[], key: KeyItem[]) {
  const byId = new Map(answers.map((a) => [a.id, a.choice]))
  const keyIds = new Set(key.map((k) => k.id))
  // Coverage guard: a missing or mis-keyed answer is NOT a wrong answer — it is an invalid
  // run (this exact failure silently scored 0% once when learners answered the wrong quiz).
  const answered = key.filter((k) => byId.has(k.id)).length
  const unknownIds = answers.map((a) => a.id).filter((id) => !keyIds.has(id))
  const complete = answered === key.length && key.length > 0
  let scorable = 0
  let correct = 0
  let partialSum = 0
  const perItem: { id: string; type: string; correct: boolean; partial: number; scorable: boolean }[] = []
  for (const k of key) {
    const r = scoreItem(k.type, byId.get(k.id), k.correct)
    perItem.push({ id: k.id, type: k.type, ...r })
    if (r.scorable) {
      scorable++
      partialSum += r.partial
      if (r.correct) correct++
    }
  }
  return { scorable, correct, partialSum, pct: scorable ? correct / scorable : 0, partialPct: scorable ? partialSum / scorable : 0, perItem, answered, expected: key.length, unknownIds, complete }
}

export type Verdict = 'supported' | 'refuted' | 'unverifiable'
export function tallyAdversarial(claimSets: { claims: { verdict: Verdict }[] }[]) {
  const t = { total: 0, supported: 0, refuted: 0, unverifiable: 0 }
  for (const set of claimSets)
    for (const c of set.claims || []) {
      t.total++
      if (c.verdict === 'supported') t.supported++
      else if (c.verdict === 'refuted') t.refuted++
      else t.unverifiable++
    }
  return t
}

// ── prep / report drivers ─────────────────────────────────────────────────────
function runDir(system: string) {
  return path.join(root, 'proof-runs', system)
}
function readJSON(p: string): any {
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
}

type RunStatus = 'ok' | 'incomplete' | 'missing'
type EffRow = {
  id: string
  taught?: number
  cold?: number
  scorable: number
  taughtStatus: RunStatus
  coldStatus: RunStatus
  taughtCoverage?: string
  coldCoverage?: string
  /** per-item discrimination: taught✓&cold✗ isolates teaching; both✓ = guessable item */
  discriminating?: number
  bothRight?: number
  bothWrong?: number
}
/**
 * Score a taught/cold learner pair against a key set living in <dir>/<keysSub>/.
 * FAIL-LOUD: an answer file that doesn't cover every key item (missing/mis-keyed ids) is an
 * INVALID run — excluded from every aggregate and flagged, never silently scored as wrong.
 */
function scoreSet(dir: string, keysSub: string, taughtSub: string, coldSub: string, only?: string[]) {
  const kdir = path.join(dir, keysSub)
  let ids = existsSync(kdir) ? readdirSync(kdir).filter((f) => f.endsWith('.key.json')).map((f) => f.replace('.key.json', '')) : []
  if (only) ids = ids.filter((id) => only.includes(id))
  const rows: EffRow[] = []
  let tC = 0, tS = 0, cC = 0, cS = 0
  for (const id of ids) {
    const key = readJSON(path.join(kdir, `${id}.key.json`))?.key || []
    const taught = readJSON(path.join(dir, taughtSub, `${id}.json`))
    const cold = readJSON(path.join(dir, coldSub, `${id}.json`))
    const ts = taught ? scoreLearner(taught.answers || [], key) : null
    const cs = cold ? scoreLearner(cold.answers || [], key) : null
    const taughtStatus: RunStatus = !ts ? 'missing' : ts.complete ? 'ok' : 'incomplete'
    const coldStatus: RunStatus = !cs ? 'missing' : cs.complete ? 'ok' : 'incomplete'
    if (ts && taughtStatus === 'ok') { tC += ts.correct; tS += ts.scorable }
    if (cs && coldStatus === 'ok') { cC += cs.correct; cS += cs.scorable }
    const row: EffRow = {
      id,
      taught: taughtStatus === 'ok' ? ts!.pct : undefined,
      cold: coldStatus === 'ok' ? cs!.pct : undefined,
      scorable: ts?.scorable ?? cs?.scorable ?? 0,
      taughtStatus,
      coldStatus,
      taughtCoverage: ts && !ts.complete ? `${ts.answered}/${ts.expected} answered${ts.unknownIds.length ? `, ${ts.unknownIds.length} unknown id(s)` : ''}` : undefined,
      coldCoverage: cs && !cs.complete ? `${cs.answered}/${cs.expected} answered${cs.unknownIds.length ? `, ${cs.unknownIds.length} unknown id(s)` : ''}` : undefined,
    }
    if (taughtStatus === 'ok' && coldStatus === 'ok') {
      const cm = new Map(cs!.perItem.map((p) => [p.id, p]))
      let disc = 0, both = 0, neither = 0
      for (const p of ts!.perItem) {
        if (!p.scorable) continue
        const c = cm.get(p.id)
        if (!c) continue
        if (p.correct && !c.correct) disc++
        else if (p.correct && c.correct) both++
        else if (!p.correct && !c.correct) neither++
      }
      row.discriminating = disc
      row.bothRight = both
      row.bothWrong = neither
    }
    rows.push(row)
  }
  const invalid = rows.filter((r) => r.taughtStatus === 'incomplete' || r.coldStatus === 'incomplete')
  return { ids, rows, invalid, tS, cS, taughtOverall: tS ? tC / tS : 0, coldOverall: cS ? cC / cS : 0, present: rows.some((r) => r.taught != null || r.cold != null) }
}

// Downstream artifacts per module — re-prepping a module invalidates ALL of these (the
// inputs they were produced from just changed), so prep deletes them. Stale-run mixing was
// a real observed failure: report() tallies whatever files exist.
const AGENT_OUTPUT_FILES = (id: string) => [
  `adversarial/${id}.json`,
  `learner/${id}.json`,
  `learner-cold/${id}.json`,
  `genraw/${id}.json`,
  `genquiz/${id}.quiz.json`,
  `genkeys/${id}.key.json`,
  `learner-gen/${id}.json`,
  `learner-gen-cold/${id}.json`,
]

function readManifest(dir: string): { modules: string[]; preppedAt?: string } | null {
  return readJSON(path.join(dir, 'manifest.json'))
}

function prep() {
  const system = arg('system')!
  const bundlePath = arg('bundle')!
  const only = arg('modules')?.split(',').map((s) => s.trim())
  const bundle = JSON.parse(readFileSync(path.resolve(root, bundlePath), 'utf8'))
  const dir = runDir(system)
  for (const sub of ['inputs', 'keys', 'adversarial', 'learner', 'learner-cold']) mkdirSync(path.join(dir, sub), { recursive: true })
  const mods = (bundle.modules as any[]).filter((m) => !only || only.includes(m.id))
  let invalidated = 0
  for (const m of mods) {
    for (const f of AGENT_OUTPUT_FILES(m.id)) {
      const p = path.join(dir, f)
      if (existsSync(p)) {
        rmSync(p)
        invalidated++
      }
    }
    writeFileSync(path.join(dir, 'inputs', `${m.id}.lesson.md`), renderLessons(m))
    const { quiz, key } = buildLearnerQuiz(m)
    writeFileSync(path.join(dir, 'inputs', `${m.id}.quiz.json`), JSON.stringify({ moduleId: m.id, title: m.title, objective: m.objective, quiz }, null, 2))
    writeFileSync(path.join(dir, 'keys', `${m.id}.key.json`), JSON.stringify({ moduleId: m.id, key }, null, 2))
    writeFileSync(
      path.join(dir, 'inputs', `${m.id}.claims.json`),
      JSON.stringify({ moduleId: m.id, title: m.title, objective: m.objective, citedPaths: collectCitedPaths(m), claims: collectClaims(m) }, null, 2),
    )
  }
  // The manifest is the single source of truth for which modules belong to THIS run;
  // report() reads only these, so leftovers from earlier differently-scoped runs are inert.
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ system, preppedAt: new Date().toISOString(), modules: mods.map((m) => m.id) }, null, 2))
  console.log(`✓ prepped ${mods.length} module(s) → ${path.relative(root, dir)}`)
  console.log(`  modules: ${mods.map((m) => m.id).join(', ')}`)
  if (invalidated) console.log(`  invalidated ${invalidated} stale agent output(s) from prior runs of these modules`)
  const claimCount = mods.reduce((n, m) => n + collectClaims(m).length, 0)
  console.log(`  ${claimCount} claim block(s) for adversarial verify · learner quizzes stripped + shuffled · manifest.json written`)
}

function pct(x: number) {
  return `${Math.round(x * 100)}%`
}

function report() {
  const system = arg('system')!
  const bundlePath = arg('bundle')!
  const bundle = JSON.parse(readFileSync(path.resolve(root, bundlePath), 'utf8'))
  const dir = runDir(system)
  const g = bundle.provenance?.grounding
  const repoRef = g?.repoRef || bundle.system?.repoUrl || 'unknown'

  // which modules belong to THIS run — the manifest is authoritative; the keys-dir listing is
  // only a legacy fallback (pre-manifest runs). Files outside the manifest are stale and inert.
  const manifest = readManifest(dir)
  const prepped = manifest
    ? manifest.modules
    : existsSync(path.join(dir, 'keys'))
      ? readdirSync(path.join(dir, 'keys')).filter((f) => f.endsWith('.key.json')).map((f) => f.replace('.key.json', ''))
      : []
  if (!manifest) console.warn('  ⚠ no manifest.json (pre-manifest run) — falling back to the keys/ listing; re-run prep to scope the run explicitly')
  const modTitle = (id: string) => (bundle.modules as any[]).find((m) => m.id === id)?.title || id

  // adversarial
  const advSets: { moduleId: string; claims: any[] }[] = []
  for (const id of prepped) {
    const a = readJSON(path.join(dir, 'adversarial', `${id}.json`))
    if (a?.claims) advSets.push({ moduleId: id, claims: a.claims })
  }
  const adv = tallyAdversarial(advSets)
  const notSurvived = advSets.flatMap((s) => (s.claims || []).filter((c: any) => c.verdict !== 'supported').map((c: any) => ({ moduleId: s.moduleId, ...c })))

  // learner effectiveness — the course's own quiz, and the hardened generated quiz (if present)
  const course = scoreSet(dir, 'keys', 'learner', 'learner-cold', prepped)
  const gen = scoreSet(dir, 'genkeys', 'learner-gen', 'learner-gen-cold', prepped)
  const hardened = gen.present
  const primary = hardened ? gen : course // the hardened generated quiz wins when available

  // ── render ──
  const L: string[] = []
  L.push(`# Proof report — ${bundle.system?.name || system}`)
  L.push('')
  L.push(`Source of truth: \`${repoRef}\` · modules covered: ${prepped.length}/${(bundle.modules || []).length}`)
  L.push('')
  L.push(`This report tests three claims the course makes about itself: that it is **faithful** (every snippet is real), **true** (every assertion survives an adversary trying to refute it against the source), and **effective** (a learner who only read the course can pass its own assessment).`)
  L.push('')

  L.push('## Layer 1 — Faithful · snippet = source')
  if (g) {
    L.push(`\`${g.verified}/${g.total}\` code snippets verified against source` + (g.exact != null ? `, **${g.exact} exact-verbatim** (byte-for-byte contiguous copies)` : '') + (g.drifted ? `, ${g.drifted} drifted ⚠` : '') + (g.missingFile ? `, ${g.missingFile} missing-file ⚠` : '') + '.')
    L.push('')
    L.push('_Stamped by the grounding gate at author time; re-checked on every release so it cannot silently rot._')
  } else L.push('_No grounding record on this bundle._')
  L.push('')

  L.push('## Layer 2 — True · adversarial claim verification')
  if (adv.total) {
    L.push(`A skeptic agent re-read each prose/callout assertion and tried to **refute** it against \`${repoRef}\`, defaulting to "refuted/unverifiable" unless the code directly backs it.`)
    L.push('')
    L.push(`- **${adv.supported}** supported`)
    L.push(`- **${adv.refuted}** refuted ${adv.refuted ? '⚠' : ''}`)
    L.push(`- **${adv.unverifiable}** unverifiable (no code evidence either way)`)
    L.push('')
    L.push(`Survival rate: **${pct(adv.total ? adv.supported / adv.total : 0)}** of ${adv.total} atomic claims.`)
    if (notSurvived.length) {
      L.push('')
      L.push('### Claims that did NOT survive — what the loop would cut or flag')
      for (const c of notSurvived.slice(0, 40)) {
        L.push(`- **[${modTitle(c.moduleId)}]** _${c.verdict}_ — ${c.claim}`)
        if (c.evidence) L.push(`  - evidence: ${c.evidence}`)
        if (c.note) L.push(`  - ${c.note}`)
      }
      if (notSurvived.length > 40) L.push(`- …and ${notSurvived.length - 40} more`)
    }
  } else L.push('_Adversarial pass not yet run for these modules._')
  L.push('')

  L.push(`## Layer 3 — Effective · simulated learner${hardened ? ' on a hardened comprehension quiz' : ' (cold-control)'}`)
  L.push('')
  if (hardened) {
    L.push('**Method (hardened).** Fresh 4-option comprehension questions were generated per module, with the three distractors drawn from real-but-wrong facts in the same domain (a neighboring status, a sibling formula, an off-by-one FK direction) so they cannot be guessed from general knowledge. A capable learner answers them — "taught" reads only the module text; the "cold" control sees only the title + objective. The cold control fails not because the model is weak but because the distractors are *grounded*; the gap, **taught − cold = lift**, isolates what the course taught.')
  } else {
    L.push('**Method.** A learner agent reads ONLY the module text (answer key stripped, options shuffled) and takes the course\'s own quiz; a "cold" agent answers it having seen only the title + objective. **taught − cold = lift.** Auto-scored: mcq, ordering, spot-the-bug.')
  }
  L.push('')
  L.push('| Module | Items | Taught | Cold (control) | Lift | Discriminating items |')
  L.push('|---|---|---|---|---|---|')
  const statusCell = (v: number | undefined, s: RunStatus, cov?: string) =>
    s === 'ok' ? pct(v!) : s === 'incomplete' ? `⚠ invalid (${cov})` : '—'
  for (const r of primary.rows) {
    const lift = r.taught != null && r.cold != null ? r.taught - r.cold : null
    const disc = r.discriminating != null ? `${r.discriminating} of ${r.discriminating + (r.bothRight ?? 0) + (r.bothWrong ?? 0)}${r.bothRight ? ` (${r.bothRight} guessable)` : ''}` : '—'
    L.push(`| ${modTitle(r.id)} | ${r.scorable} | ${statusCell(r.taught, r.taughtStatus, r.taughtCoverage)} | ${statusCell(r.cold, r.coldStatus, r.coldCoverage)} | ${lift != null ? (lift >= 0 ? '+' : '') + Math.round(lift * 100) + ' pts' : '—'} | ${disc} |`)
  }
  L.push(`| **Overall** | ${primary.tS || primary.cS} | **${pct(primary.taughtOverall)}** | **${pct(primary.coldOverall)}** | **${(primary.taughtOverall - primary.coldOverall >= 0 ? '+' : '') + Math.round((primary.taughtOverall - primary.coldOverall) * 100)} pts** | |`)
  L.push('')
  L.push('_A **discriminating** item is one the taught learner got right and the cold control got wrong — the direct evidence of teaching. Items both got right are guessable and carry no signal._')
  L.push('')
  if (primary.invalid?.length) {
    L.push('### ⚠ Invalid learner runs — excluded from every number above')
    L.push('_An answer file that does not cover every question (missing or mis-keyed ids) is a broken measurement, not a low score. Re-run these learners._')
    for (const r of primary.invalid) {
      if (r.taughtStatus === 'incomplete') L.push(`- **${modTitle(r.id)}** taught: ${r.taughtCoverage}`)
      if (r.coldStatus === 'incomplete') L.push(`- **${modTitle(r.id)}** cold: ${r.coldCoverage}`)
    }
    L.push('')
  }
  if (hardened && course.present) {
    L.push(`_For contrast, the course's own 2-option quiz was near-non-discriminating (cold ${pct(course.coldOverall)}). The hardened quiz above is what actually isolates teaching._`)
    L.push('')
  } else if (!hardened && primary.coldOverall >= 0.8) {
    L.push(`> **Read the cold number first.** The control scored ${pct(primary.coldOverall)} without reading the course, so these questions are guessable. Run the hardened generated quiz (\`proof genprep\` + the learner-gen pass) to measure teaching.`)
    L.push('')
  }
  if (hardened && primary.cS > 0 && primary.coldOverall >= 0.6) {
    L.push(`> **High cold-control caveat.** The cold control scored ${pct(primary.coldOverall)} on the hardened quiz — a sizable share of questions are answerable without reading the course (model priors on a well-known codebase, residual guessability, or both). Lift UNDERSTATES teaching here; weigh the per-item discrimination column and the faithful + true layers more heavily. Lift is most meaningful on private/internal repos, where a control cannot have priors.`)
    L.push('')
  }
  L.push('**Effectiveness depends on truth.** A quiz can only measure teaching if its answer key is correct. When a key encodes a claim that Layer 2 refuted, a "taught" learner scores by *absorbing the error* and the control may score higher by reasoning correctly. So Layer 2 must pass before Layer 3 means anything — that is why the two run together.')
  L.push('')
  const didNotTeach = primary.rows.filter((r) => r.taught != null && r.taught < 0.6)
  if (didNotTeach.length) {
    L.push('### Did not teach to competence — regenerate these modules')
    for (const r of didNotTeach) L.push(`- **${modTitle(r.id)}**: taught only ${pct(r.taught!)} — the learner could not answer from the module text alone.`)
    L.push('')
  }

  L.push('## Honest limitations')
  L.push('- The learner is an LLM with prior knowledge it cannot fully suppress; the **cold control** is what makes the "taught" number meaningful (lift, not absolute), and on well-known public codebases even the control has priors — see the caveat above when it fires.')
  L.push('- **The author, skeptic, quiz-writer, and learner share a model family.** Shared blind spots can survive every layer — a claim wrong in a way the family reliably misjudges will pass its own adversary. For high-stakes courses, run the adversarial pass with a second model family (cross-model verification).')
  L.push('- Diagrams, simulations, and screens are rendered to the learner as short text stand-ins, so visual teaching is under-credited here.')
  L.push('- Adversarial verdicts are one skeptic per module; a production run votes N skeptics per claim and keeps only majority-supported.')
  L.push(`- Coverage is ${prepped.length}/${(bundle.modules || []).length} modules (a representative slice unless this says all).`)
  L.push('')

  const md = L.join('\n')
  writeFileSync(path.join(dir, 'PROOF_REPORT.md'), md)
  writeFileSync(
    path.join(dir, 'proof-report.json'),
    JSON.stringify({ system, repoRef, grounding: g, adversarial: adv, effectiveness: { mode: hardened ? 'hardened-generated' : 'course-quiz', taughtOverall: primary.taughtOverall, coldOverall: primary.coldOverall, lift: primary.taughtOverall - primary.coldOverall, invalidRuns: primary.invalid.map((r) => r.id), rows: primary.rows, courseQuiz: { taughtOverall: course.taughtOverall, coldOverall: course.coldOverall, present: course.present } }, generatedFrom: prepped, manifest: !!manifest }, null, 2),
  )
  console.log(`✓ proof report → ${path.relative(root, path.join(dir, 'PROOF_REPORT.md'))}`)
  console.log(`  faithful: ${g ? `${g.verified}/${g.total} verified, ${g.exact ?? 0} exact` : 'n/a'}`)
  console.log(`  true: ${adv.total ? `${adv.supported}/${adv.total} claims survived, ${adv.refuted} refuted, ${adv.unverifiable} unverifiable` : 'not run'}`)
  console.log(`  effective${hardened ? ' (hardened)' : ''}: taught ${pct(primary.taughtOverall)} vs cold ${pct(primary.coldOverall)} = +${Math.round((primary.taughtOverall - primary.coldOverall) * 100)} pts lift`)
}

/** Strip + shuffle agent-generated raw quizzes (genraw/<mod>.json) into learner-facing genquiz/ + held-back genkeys/. */
function genprep() {
  const system = arg('system')!
  const bundlePath = arg('bundle')!
  const bundle = JSON.parse(readFileSync(path.resolve(root, bundlePath), 'utf8'))
  const dir = runDir(system)
  for (const sub of ['genraw', 'genquiz', 'genkeys', 'learner-gen', 'learner-gen-cold']) mkdirSync(path.join(dir, sub), { recursive: true })
  const manifest = readManifest(dir)
  const rawDir = path.join(dir, 'genraw')
  const raws = existsSync(rawDir) ? readdirSync(rawDir).filter((f) => f.endsWith('.json')) : []
  let n = 0
  let items = 0
  let dropped = 0
  for (const f of raws) {
    const raw = readJSON(path.join(rawDir, f))
    if (!raw) continue
    const id = raw.moduleId || f.replace('.json', '')
    if (manifest && !manifest.modules.includes(id)) {
      console.warn(`  ⚠ genraw/${f} is not in this run's manifest — skipped (stale from a prior run?)`)
      continue
    }
    const m = (bundle.modules as any[]).find((x) => x.id === id) || {}
    const { quiz, key, rejected } = buildGenQuiz(raw.items || [], id)
    for (const r of rejected) console.warn(`  ⚠ ${id}/${r.id} rejected: ${r.reason}`)
    dropped += rejected.length
    if (!quiz.length) continue
    // a regenerated quiz invalidates any prior answers to the old one
    for (const stale of [`learner-gen/${id}.json`, `learner-gen-cold/${id}.json`]) {
      const p = path.join(dir, stale)
      if (existsSync(p)) rmSync(p)
    }
    writeFileSync(path.join(dir, 'genquiz', `${id}.quiz.json`), JSON.stringify({ moduleId: id, title: m.title, objective: m.objective, quiz }, null, 2))
    writeFileSync(path.join(dir, 'genkeys', `${id}.key.json`), JSON.stringify({ moduleId: id, key }, null, 2))
    n++
    items += quiz.length
  }
  console.log(`✓ gen-prepped ${n} module(s) · ${items} hardened question(s)${dropped ? ` · ${dropped} rejected` : ''} → genquiz/ + genkeys/ (answer keys held back; prior learner-gen answers invalidated)`)
}

// Only run the CLI when executed directly (not when imported by the test).
const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  const cmd = process.argv[2]
  if (cmd === 'prep') prep()
  else if (cmd === 'genprep') genprep()
  else if (cmd === 'report') report()
  else {
    console.error('Usage: proof <prep|genprep|report> --system <id> --bundle <bundle.json> [--modules a,b,c]')
    process.exit(1)
  }
}
