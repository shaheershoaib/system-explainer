import { describe, it, expect } from 'vitest'
import {
  moduleUnlocked,
  overallPercent,
  gradeShortAnswer,
  completedModuleIds,
  applyAttempt,
  conceptsDue,
  masteryLevel,
  REVIEW_INTERVALS,
} from './progress'
import type { ConceptMastery, Module, Progress } from './progress-types'

const mods: Module[] = [
  { id: 'm1', title: 'M1', order: 1, objective: '', lessons: [], quiz: [] },
  { id: 'm2', title: 'M2', order: 2, objective: '', prerequisites: ['m1'], lessons: [], quiz: [] },
]

const progressWith = (completed: string[]): Progress => ({
  systemId: 's',
  modules: Object.fromEntries(completed.map((id) => [id, { lessonsViewed: [], attempts: [], completedAt: 1 }])),
})

describe('moduleUnlocked', () => {
  it('unlocks modules with no prerequisites', () => {
    expect(moduleUnlocked('m1', mods, new Set())).toBe(true)
  })
  it('locks a module until its prerequisite is complete', () => {
    expect(moduleUnlocked('m2', mods, new Set())).toBe(false)
    expect(moduleUnlocked('m2', mods, new Set(['m1']))).toBe(true)
  })
})

describe('overallPercent', () => {
  it('is 0 with nothing complete and rounds the fraction otherwise', () => {
    expect(overallPercent(mods, progressWith([]))).toBe(0)
    expect(overallPercent(mods, progressWith(['m1']))).toBe(50)
    expect(overallPercent(mods, progressWith(['m1', 'm2']))).toBe(100)
  })
})

describe('completedModuleIds', () => {
  it('collects only modules with a completedAt', () => {
    const p: Progress = {
      systemId: 's',
      modules: { m1: { lessonsViewed: [], attempts: [], completedAt: 1 }, m2: { lessonsViewed: [], attempts: [] } },
    }
    expect([...completedModuleIds(p)]).toEqual(['m1'])
  })
})

describe('gradeShortAnswer', () => {
  it('passes when all rubric keywords are present (case-insensitive)', () => {
    expect(gradeShortAnswer('An Account sits between Customer and Policy', ['account', 'policy'])).toBe(true)
  })
  it('fails when a keyword is missing', () => {
    expect(gradeShortAnswer('It is just a customer', ['account', 'policy'])).toBe(false)
  })
  it('passes any answer when no rubric is given', () => {
    expect(gradeShortAnswer('whatever', undefined)).toBe(true)
  })
})

describe('spaced review — applyAttempt', () => {
  const T0 = 1_000_000_000_000
  const DAY = 86_400_000

  it('promotes a box and schedules the next review a day out on first correct answer', () => {
    const m = applyAttempt(undefined, true, T0)
    expect(m.box).toBe(1)
    expect(m.correct).toBe(1)
    expect(m.dueAt).toBe(T0 + DAY)
  })

  it('resets to box 0 and is immediately due on a wrong answer', () => {
    const learned: ConceptMastery = { box: 2, correct: 2, wrong: 0, lastSeenAt: T0, dueAt: T0 + 3 * DAY }
    const m = applyAttempt(learned, false, T0 + 10 * DAY)
    expect(m.box).toBe(0)
    expect(m.wrong).toBe(1)
    expect(m.dueAt).toBe(T0 + 10 * DAY) // due now
  })

  it('caps promotion at the last interval box', () => {
    let m = applyAttempt(undefined, true, T0)
    for (let i = 0; i < 10; i++) m = applyAttempt(m, true, T0)
    expect(m.box).toBe(REVIEW_INTERVALS.length - 1)
  })
})

describe('spaced review — masteryLevel + conceptsDue', () => {
  const NOW = 2_000_000_000_000
  const DAY = 86_400_000

  it('maps boxes to levels', () => {
    expect(masteryLevel(undefined)).toBe('unseen')
    expect(masteryLevel({ box: 0, correct: 0, wrong: 1, lastSeenAt: 0, dueAt: 0 })).toBe('shaky')
    expect(masteryLevel({ box: 1, correct: 1, wrong: 0, lastSeenAt: 0, dueAt: 0 })).toBe('learning')
    expect(masteryLevel({ box: 3, correct: 3, wrong: 0, lastSeenAt: 0, dueAt: 0 })).toBe('solid')
  })

  it('surfaces overdue, not-yet-solid concepts and skips solid or future ones', () => {
    const concepts: Record<string, ConceptMastery> = {
      missed: { box: 0, correct: 0, wrong: 1, lastSeenAt: NOW - DAY, dueAt: NOW - DAY }, // due
      learning: { box: 1, correct: 1, wrong: 1, lastSeenAt: NOW, dueAt: NOW - 60_000 }, // due
      future: { box: 2, correct: 2, wrong: 0, lastSeenAt: NOW, dueAt: NOW + 3 * DAY }, // not yet
      solid: { box: 4, correct: 5, wrong: 0, lastSeenAt: NOW - 30 * DAY, dueAt: NOW - DAY }, // overdue but mastered
    }
    expect(conceptsDue(concepts, NOW)).toEqual(['missed', 'learning'])
    expect(conceptsDue(undefined, NOW)).toEqual([])
  })
})
