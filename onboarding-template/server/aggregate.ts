import type { OnboardingBundle } from '../schema/bundle'

/** What a learner's browser POSTs to the backend (mirrors the client Progress shape). */
export interface LearnerRecord {
  learnerId: string
  learner?: { name?: string; email?: string }
  modules: Record<
    string,
    {
      startedAt?: number
      completedAt?: number
      lessonsViewed?: string[]
      attempts?: { quizItemId: string; correct: boolean; misconceptionId?: string; at: number }[]
    }
  >
  /** Per-misconception spaced-review mastery (Leitner box), mirrors the client Progress. */
  concepts?: Record<string, { box: number; correct: number; wrong: number; lastSeenAt: number; dueAt: number }>
  updatedAt?: number
}

export interface DashboardData {
  totals: { learners: number; avgPercent: number }
  learners: {
    learnerId: string
    name?: string
    completed: number
    total: number
    percent: number
    lastActive?: number
  }[]
  moduleCompletion: { moduleId: string; title: string; completed: number; total: number }[]
  /** The headline: which documented misconceptions trip people up most — candidate gotchas. */
  stuckPoints: {
    misconceptionId: string
    trap: string
    correction: string
    moduleId: string
    misses: number
    learnersAffected: number
  }[]
  /** Team-wide mastery per documented concept — the weak-spots heatmap (weakest first). */
  conceptMastery: {
    misconceptionId: string
    trap: string
    correction: string
    moduleId: string
    learners: number
    solid: number
    shaky: number
    avgBox: number
  }[]
}

/** Pure aggregation of learner records against a bundle. The dashboard's brain. */
export function aggregateDashboard(records: LearnerRecord[], bundle: OnboardingBundle): DashboardData {
  const modules = bundle.modules
  const total = records.length

  const catalog = new Map<string, { trap: string; correction: string; moduleId: string }>()
  for (const m of modules)
    for (const q of m.quiz)
      if ((q.type === 'mcq' || q.type === 'spot-bug') && q.misconception)
        catalog.set(q.misconception.id, {
          trap: q.misconception.trap,
          correction: q.misconception.correction,
          moduleId: m.id,
        })

  const learners = records.map((r) => {
    const completed = modules.filter((m) => r.modules[m.id]?.completedAt).length
    const stamps = Object.values(r.modules).flatMap((mp) => [
      mp.completedAt ?? 0,
      mp.startedAt ?? 0,
      ...(mp.attempts ?? []).map((a) => a.at),
    ])
    const lastActive = Math.max(0, ...stamps) || undefined
    return {
      learnerId: r.learnerId,
      name: r.learner?.name,
      completed,
      total: modules.length,
      percent: modules.length ? Math.round((completed / modules.length) * 100) : 0,
      lastActive,
    }
  })

  const moduleCompletion = modules.map((m) => ({
    moduleId: m.id,
    title: m.title,
    completed: records.filter((r) => r.modules[m.id]?.completedAt).length,
    total,
  }))

  const missMap = new Map<string, { misses: number; learners: Set<string> }>()
  for (const r of records)
    for (const mp of Object.values(r.modules))
      for (const a of mp.attempts ?? [])
        if (!a.correct && a.misconceptionId) {
          const e = missMap.get(a.misconceptionId) ?? { misses: 0, learners: new Set<string>() }
          e.misses += 1
          e.learners.add(r.learnerId)
          missMap.set(a.misconceptionId, e)
        }

  const stuckPoints = [...missMap.entries()]
    .map(([id, e]) => ({
      misconceptionId: id,
      trap: catalog.get(id)?.trap ?? id,
      correction: catalog.get(id)?.correction ?? '',
      moduleId: catalog.get(id)?.moduleId ?? '',
      misses: e.misses,
      learnersAffected: e.learners.size,
    }))
    .sort((a, b) => b.misses - a.misses)

  // Team-wide per-concept mastery — the weak-spots heatmap (weakest concepts first).
  const masteryMap = new Map<string, { boxes: number[]; solid: number; shaky: number }>()
  for (const r of records)
    for (const [cid, m] of Object.entries(r.concepts ?? {})) {
      const e = masteryMap.get(cid) ?? { boxes: [], solid: 0, shaky: 0 }
      e.boxes.push(m.box)
      if (m.box >= 3) e.solid += 1
      if (m.box <= 0) e.shaky += 1
      masteryMap.set(cid, e)
    }
  const conceptMastery = [...masteryMap.entries()]
    .map(([id, e]) => ({
      misconceptionId: id,
      trap: catalog.get(id)?.trap ?? id,
      correction: catalog.get(id)?.correction ?? '',
      moduleId: catalog.get(id)?.moduleId ?? '',
      learners: e.boxes.length,
      solid: e.solid,
      shaky: e.shaky,
      avgBox: e.boxes.length ? Math.round((e.boxes.reduce((s, b) => s + b, 0) / e.boxes.length) * 10) / 10 : 0,
    }))
    .sort((a, b) => a.avgBox - b.avgBox || b.shaky - a.shaky)

  const avgPercent = total ? Math.round(learners.reduce((s, l) => s + l.percent, 0) / total) : 0
  return { totals: { learners: total, avgPercent }, learners, moduleCompletion, stuckPoints, conceptMastery }
}
