import type { Module } from '@schema/bundle'
export type { Module }

export interface QuizAttempt {
  quizItemId: string
  correct: boolean
  /** Set when the learner chose a distractor tied to a documented misconception. */
  misconceptionId?: string
  at: number
}

export interface ModuleProgress {
  startedAt?: number
  completedAt?: number
  lessonsViewed: string[]
  attempts: QuizAttempt[]
}

export type MasteryLevel = 'unseen' | 'shaky' | 'learning' | 'solid'

/** Per-misconception mastery, tracked as a Leitner box for spaced review. */
export interface ConceptMastery {
  /** Leitner box 0..4 — higher box = longer interval before the concept resurfaces. */
  box: number
  correct: number
  wrong: number
  lastSeenAt: number
  /** When this concept is next due for review (ms epoch). */
  dueAt: number
}

export interface Progress {
  systemId: string
  /** Stable per-browser id, generated on first identify; the dashboard's learner key. */
  learnerId?: string
  learner?: { name?: string; email?: string }
  modules: Record<string, ModuleProgress>
  /** Per-misconception mastery powering the spaced-review queue (the reason to return). */
  concepts?: Record<string, ConceptMastery>
}
