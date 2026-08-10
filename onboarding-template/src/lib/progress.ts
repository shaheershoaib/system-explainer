import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { ConceptMastery, MasteryLevel, Module, Progress } from './progress-types'

export type { Progress, ModuleProgress, QuizAttempt, ConceptMastery, MasteryLevel } from './progress-types'

// ───────────────────────── pure logic (unit-tested) ─────────────────────────

export function completedModuleIds(progress: Progress): Set<string> {
  return new Set(
    Object.entries(progress.modules)
      .filter(([, mp]) => mp.completedAt)
      .map(([id]) => id),
  )
}

/** A module is unlocked when every prerequisite module is complete. */
export function moduleUnlocked(
  moduleId: string,
  modules: Module[],
  completedIds: Set<string>,
): boolean {
  const m = modules.find((x) => x.id === moduleId)
  if (!m) return false
  return (m.prerequisites ?? []).every((p) => completedIds.has(p))
}

export function overallPercent(modules: Module[], progress: Progress): number {
  if (!modules.length) return 0
  return Math.round((completedModuleIds(progress).size / modules.length) * 100)
}

/** Self-grade a short answer: correct iff it contains every rubric keyword (case-insensitive). */
export function gradeShortAnswer(answer: string, rubricKeywords?: string[]): boolean {
  if (!rubricKeywords?.length) return true
  const a = answer.toLowerCase()
  return rubricKeywords.every((k) => a.includes(k.toLowerCase()))
}

// ───────────────────────── spaced review (unit-tested) ──────────────────────

const DAY = 86_400_000
/** Leitner intervals per box (ms): box 0 is due immediately, then 1d, 3d, 7d, 21d. */
export const REVIEW_INTERVALS = [0, DAY, 3 * DAY, 7 * DAY, 21 * DAY]

export function masteryLevel(m?: ConceptMastery): MasteryLevel {
  if (!m) return 'unseen'
  if (m.box >= 3) return 'solid'
  if (m.box >= 1) return 'learning'
  return 'shaky'
}

/** Fold one attempt into a concept's mastery: a correct answer promotes a box, a wrong one resets to 0. */
export function applyAttempt(prev: ConceptMastery | undefined, correct: boolean, now: number): ConceptMastery {
  const base = prev ?? { box: 0, correct: 0, wrong: 0, lastSeenAt: now, dueAt: now }
  const box = correct ? Math.min(REVIEW_INTERVALS.length - 1, base.box + 1) : 0
  return {
    box,
    correct: base.correct + (correct ? 1 : 0),
    wrong: base.wrong + (correct ? 0 : 1),
    lastSeenAt: now,
    dueAt: now + REVIEW_INTERVALS[box],
  }
}

/** The review queue: concepts whose dueAt has passed and that aren't yet solid, soonest first. */
export function conceptsDue(concepts: Record<string, ConceptMastery> | undefined, now: number): string[] {
  if (!concepts) return []
  return Object.entries(concepts)
    .filter(([, m]) => m.dueAt <= now && masteryLevel(m) !== 'solid')
    .sort((a, b) => a[1].dueAt - b[1].dueAt)
    .map(([id]) => id)
}

// ───────────────────────── localStorage-backed store ────────────────────────

const keyFor = (sys: string) => `onboarding:progress:${sys}`
const emptyProgress = (sys: string): Progress => ({ systemId: sys, modules: {} })

const listeners = new Set<() => void>()
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => { listeners.delete(l) }
}
const emit = () => listeners.forEach((l) => l())

function readRaw(sys: string): string {
  try { return localStorage.getItem(keyFor(sys)) ?? '' } catch { return '' }
}
function parse(sys: string, raw: string): Progress {
  if (!raw) return emptyProgress(sys)
  try {
    const p = JSON.parse(raw) as Progress
    return p?.systemId ? p : emptyProgress(sys)
  } catch {
    return emptyProgress(sys)
  }
}
function commit(p: Progress) {
  try { localStorage.setItem(keyFor(p.systemId), JSON.stringify(p)) } catch {}
  emit()
}

export function useProgress(systemId: string) {
  // Snapshot is the raw string so React bails out when nothing changed (stable ref).
  const raw = useSyncExternalStore(subscribe, () => readRaw(systemId), () => '')
  const progress = useMemo(() => parse(systemId, raw), [systemId, raw])

  const update = useCallback(
    (fn: (p: Progress) => void) => {
      const next = parse(systemId, readRaw(systemId))
      fn(next)
      commit(next)
    },
    [systemId],
  )

  const ensureModule = (p: Progress, id: string) => {
    // Tolerate partial records (e.g. a module marked complete elsewhere, or migrated/seeded
    // progress) — backfill the arrays so attempts/lessonsViewed are always safe to push to.
    const mp = (p.modules[id] ??= { lessonsViewed: [], attempts: [], startedAt: Date.now() })
    mp.lessonsViewed ??= []
    mp.attempts ??= []
    return mp
  }

  const markLessonViewed = useCallback(
    (moduleId: string, lessonId: string) =>
      update((p) => {
        const mp = ensureModule(p, moduleId)
        if (!mp.lessonsViewed.includes(lessonId)) mp.lessonsViewed.push(lessonId)
      }),
    [update],
  )

  const recordAttempt = useCallback(
    (
      moduleId: string,
      attempt: { quizItemId: string; correct: boolean; misconceptionId?: string; targetMisconceptionId?: string },
    ) =>
      update((p) => {
        const now = Date.now()
        ensureModule(p, moduleId).attempts.push({
          quizItemId: attempt.quizItemId,
          correct: attempt.correct,
          misconceptionId: attempt.misconceptionId,
          at: now,
        })
        // Advance spaced-review mastery for the concept this item targets (whether passed or failed).
        if (attempt.targetMisconceptionId) {
          p.concepts ??= {}
          p.concepts[attempt.targetMisconceptionId] = applyAttempt(p.concepts[attempt.targetMisconceptionId], attempt.correct, now)
        }
      }),
    [update],
  )

  const completeModule = useCallback(
    (moduleId: string) => update((p) => { ensureModule(p, moduleId).completedAt = Date.now() }),
    [update],
  )

  const setLearner = useCallback(
    (learner: { name?: string; email?: string }) =>
      update((p) => {
        p.learner = { ...p.learner, ...learner }
        if (!p.learnerId) p.learnerId = crypto.randomUUID?.() ?? `l-${Date.now()}`
      }),
    [update],
  )

  const reset = useCallback(() => update((p) => { p.modules = {}; p.concepts = {} }), [update])

  return { progress, markLessonViewed, recordAttempt, completeModule, setLearner, reset }
}
