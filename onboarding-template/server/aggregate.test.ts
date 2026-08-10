import { describe, it, expect } from 'vitest'
import { aggregateDashboard, type LearnerRecord } from './aggregate'
import type { OnboardingBundle } from '../schema/bundle'

const bundle = {
  schemaVersion: '1.0.0',
  system: { id: 's', name: 'S', oneLiner: 'x' },
  actors: [],
  entities: [],
  modules: [
    {
      id: 'm1',
      title: 'M1',
      order: 1,
      objective: '',
      lessons: [],
      quiz: [
        {
          id: 'q1',
          type: 'mcq',
          prompt: '',
          options: [{ id: 'a', text: '', correct: true }],
          explanation: '',
          misconception: { id: 'mc1', trap: 'T1', correction: 'C1' },
        },
      ],
    },
    { id: 'm2', title: 'M2', order: 2, objective: '', lessons: [], quiz: [] },
  ],
} as unknown as OnboardingBundle

const alice: LearnerRecord = {
  learnerId: 'alice',
  learner: { name: 'Alice' },
  modules: { m1: { completedAt: 10, attempts: [{ quizItemId: 'q1', correct: false, misconceptionId: 'mc1', at: 9 }] } },
}
const bob: LearnerRecord = {
  learnerId: 'bob',
  learner: { name: 'Bob' },
  modules: {
    m1: { completedAt: 20, attempts: [{ quizItemId: 'q1', correct: true, at: 19 }] },
    m2: { completedAt: 21 },
  },
}

describe('aggregateDashboard', () => {
  const d = aggregateDashboard([alice, bob], bundle)

  it('counts learners and average completion', () => {
    expect(d.totals.learners).toBe(2)
    // alice 1/2 = 50, bob 2/2 = 100 → avg 75
    expect(d.totals.avgPercent).toBe(75)
  })

  it('computes per-learner completion', () => {
    expect(d.learners.find((l) => l.learnerId === 'alice')!.percent).toBe(50)
    expect(d.learners.find((l) => l.learnerId === 'bob')!.percent).toBe(100)
  })

  it('computes per-module completion counts', () => {
    expect(d.moduleCompletion.find((m) => m.moduleId === 'm1')!.completed).toBe(2)
    expect(d.moduleCompletion.find((m) => m.moduleId === 'm2')!.completed).toBe(1)
  })

  it('surfaces stuck-points from misconception misses, with the correction attached', () => {
    expect(d.stuckPoints).toHaveLength(1)
    const sp = d.stuckPoints[0]
    expect(sp.misconceptionId).toBe('mc1')
    expect(sp.misses).toBe(1)
    expect(sp.learnersAffected).toBe(1)
    expect(sp.trap).toBe('T1')
    expect(sp.correction).toBe('C1')
    expect(sp.moduleId).toBe('m1')
  })

  it('handles an empty cohort without dividing by zero', () => {
    const empty = aggregateDashboard([], bundle)
    expect(empty.totals.avgPercent).toBe(0)
    expect(empty.stuckPoints).toEqual([])
    expect(empty.conceptMastery).toEqual([])
  })
})

describe('aggregateDashboard — concept mastery', () => {
  it('summarizes team mastery per concept (solid / shaky / avg box), weakest first', () => {
    const r1: LearnerRecord = {
      learnerId: 'a',
      modules: {},
      concepts: { mc1: { box: 0, correct: 0, wrong: 2, lastSeenAt: 1, dueAt: 1 } },
    }
    const r2: LearnerRecord = {
      learnerId: 'b',
      modules: {},
      concepts: { mc1: { box: 4, correct: 4, wrong: 0, lastSeenAt: 1, dueAt: 1 } },
    }
    const d = aggregateDashboard([r1, r2], bundle)
    expect(d.conceptMastery).toHaveLength(1)
    const c = d.conceptMastery[0]
    expect(c.misconceptionId).toBe('mc1')
    expect(c.learners).toBe(2)
    expect(c.solid).toBe(1) // box 4
    expect(c.shaky).toBe(1) // box 0
    expect(c.avgBox).toBe(2) // (0 + 4) / 2
    expect(c.trap).toBe('T1')
    expect(c.moduleId).toBe('m1')
  })

  it('returns an empty mastery list when no one has review data', () => {
    expect(aggregateDashboard([alice, bob], bundle).conceptMastery).toEqual([])
  })
})
