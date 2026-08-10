import { describe, it, expect } from 'vitest'
import { hash, seededShuffle, buildLearnerQuiz, buildGenQuiz, collectClaims, scoreItem, scoreLearner, tallyAdversarial, renderLessons } from './proof'

describe('seededShuffle', () => {
  it('is deterministic for a given seed and a permutation of the input', () => {
    const a = seededShuffle([1, 2, 3, 4, 5], 'x')
    const b = seededShuffle([1, 2, 3, 4, 5], 'x')
    expect(a).toEqual(b)
    expect([...a].sort()).toEqual([1, 2, 3, 4, 5])
    expect(hash('x')).toBe(hash('x'))
  })
})

const moduleFixture = {
  id: 'm1',
  title: 'M1',
  objective: 'learn',
  lessons: [
    {
      id: 'l1',
      title: 'L1',
      blocks: [
        { type: 'prose', md: 'Invoices have exactly five types.' },
        { type: 'callout', variant: 'gotcha', md: 'Void is not a sixth type.' },
        { type: 'code', language: 'py', code: 'x=1', sourcePath: 'a/b.py' },
      ],
    },
  ],
  quiz: [
    {
      id: 'q1',
      type: 'mcq',
      prompt: 'How many invoice types?',
      options: [
        { id: 'o1', text: 'four', correct: false },
        { id: 'o2', text: 'five', correct: true },
        { id: 'o3', text: 'six', correct: false },
      ],
      explanation: 'five',
    },
    {
      id: 'q2',
      type: 'ordering',
      prompt: 'Order the lifecycle',
      items: [
        { id: 'i1', text: 'draft' },
        { id: 'i2', text: 'issued' },
        { id: 'i3', text: 'paid' },
      ],
      explanation: '...',
    },
    { id: 'q3', type: 'spot-bug', prompt: 'find it', lines: ['a', 'b', 'c'], buggyLine: 2, explanation: 'line 2', fix: 'do x' },
    { id: 'q4', type: 'short-answer', prompt: 'why?', modelAnswer: 'because' },
  ],
}

describe('buildLearnerQuiz', () => {
  const { quiz, key } = buildLearnerQuiz(moduleFixture)
  it('strips correctness flags from mcq options shown to the learner', () => {
    const mcq = quiz.find((q: any) => q.id === 'q1')
    expect(mcq.options.every((o: any) => !('correct' in o))).toBe(true)
    expect(mcq.options.map((o: any) => o.key)).toEqual(['a', 'b', 'c'])
  })
  it('records the correct key for the shuffled mcq', () => {
    const k = key.find((x) => x.id === 'q1')!
    const mcq = quiz.find((q: any) => q.id === 'q1')
    const fiveKey = mcq.options.find((o: any) => o.text === 'five').key
    expect(k.correct).toBe(fiveKey)
  })
  it('expresses the ordering answer as the presented keys in canonical order', () => {
    const k = key.find((x) => x.id === 'q2')!
    const ord = quiz.find((q: any) => q.id === 'q2')
    // first correct key should map to the item whose text is 'draft'
    const draftKey = ord.items.find((it: any) => it.text === 'draft').key
    expect(k.correct[0]).toBe(draftKey)
    expect(k.correct).toHaveLength(3)
  })
  it('marks short-answer as not auto-scored and keeps spot-bug buggyLine', () => {
    expect(key.find((x) => x.id === 'q4')!.notAutoScored).toBe(true)
    expect(key.find((x) => x.id === 'q3')!.correct.buggyLine).toBe(2)
  })
})

describe('collectClaims + renderLessons', () => {
  it('collects prose + callout as claims', () => {
    const claims = collectClaims(moduleFixture)
    expect(claims).toHaveLength(2)
    expect(claims[0].text).toContain('five types')
  })
  it('renders lessons to text WITHOUT exposing quiz answers', () => {
    const md = renderLessons(moduleFixture)
    expect(md).toContain('Invoices have exactly five types')
    expect(md).not.toContain('How many invoice types') // quiz is not in the learner reading view
  })
})

describe('scoreItem', () => {
  it('scores mcq exact (case-insensitive)', () => {
    expect(scoreItem('mcq', 'B', 'b').correct).toBe(true)
    expect(scoreItem('mcq', 'a', 'b').correct).toBe(false)
  })
  it('scores ordering with positional partial credit', () => {
    expect(scoreItem('ordering', ['a', 'b', 'c'], ['a', 'b', 'c'])).toMatchObject({ correct: true, partial: 1 })
    const r = scoreItem('ordering', ['a', 'c', 'b'], ['a', 'b', 'c'])
    expect(r.correct).toBe(false)
    expect(r.partial).toBeCloseTo(1 / 3)
  })
  it('scores spot-bug by buggyLine (object or scalar)', () => {
    expect(scoreItem('spot-bug', { buggyLine: 2, fix: 'x' }, { buggyLine: 2 }).correct).toBe(true)
    expect(scoreItem('spot-bug', 3, { buggyLine: 2 }).correct).toBe(false)
  })
  it('marks short-answer not scorable', () => {
    expect(scoreItem('short-answer', 'anything', {}).scorable).toBe(false)
  })
})

describe('scoreLearner', () => {
  const { key } = buildLearnerQuiz(moduleFixture)
  it('counts only auto-scorable items and computes pct', () => {
    const correctKey = key.find((k) => k.id === 'q1')!.correct
    const ordKey = key.find((k) => k.id === 'q2')!.correct
    const answers = [
      { id: 'q1', choice: correctKey }, // right
      { id: 'q2', choice: ordKey }, // right
      { id: 'q3', choice: { buggyLine: 1 } }, // wrong (correct is 2)
      { id: 'q4', choice: 'because' }, // not scored
    ]
    const s = scoreLearner(answers, key)
    expect(s.scorable).toBe(3) // q1,q2,q3
    expect(s.correct).toBe(2)
    expect(s.pct).toBeCloseTo(2 / 3)
  })
})

describe('buildGenQuiz (hardened 4-option comprehension)', () => {
  const raw = [
    {
      id: 'g1',
      prompt: 'Which customers can be invoiced?',
      options: [
        { text: 'All except SUSPENDED/TERMINATED', correct: true },
        { text: 'Only ACTIVE', correct: false },
        { text: 'Only ACTIVE + INACTIVE', correct: false },
        { text: 'Any non-DRAFT', correct: false },
      ],
    },
  ]
  it('strips the correct flag, assigns 4 keys, and records the right key', () => {
    const { quiz, key } = buildGenQuiz(raw, 'm1')
    const q = quiz[0]
    expect(q.options).toHaveLength(4)
    expect(q.options.map((o: any) => o.key)).toEqual(['a', 'b', 'c', 'd'])
    expect(q.options.every((o: any) => !('correct' in o))).toBe(true)
    const correctOpt = q.options.find((o: any) => o.text === 'All except SUSPENDED/TERMINATED')
    expect(key[0].correct).toBe(correctOpt.key)
  })
  it('skips malformed items (no correct option or <2 options)', () => {
    expect(buildGenQuiz([{ id: 'x', prompt: 'p', options: [{ text: 'a', correct: false }, { text: 'b', correct: false }] }], 'm').quiz).toHaveLength(0)
    expect(buildGenQuiz([{ id: 'y', prompt: 'p', options: [{ text: 'only', correct: true }] }], 'm').quiz).toHaveLength(0)
  })
  it('rejects items with duplicate option texts (the observed corruption) and reports why', () => {
    const dup = [
      {
        id: 'g5',
        prompt: 'p',
        options: [
          { text: 'RBAC is permission-slug based', correct: true },
          { text: 'B', correct: false },
          { text: 'C', correct: false },
          { text: '  rbac is  permission-slug based ', correct: false }, // ws/case variant of option 1
        ],
      },
    ]
    const { quiz, rejected } = buildGenQuiz(dup, 'm')
    expect(quiz).toHaveLength(0)
    expect(rejected).toEqual([{ id: 'g5', reason: 'duplicate option texts' }])
  })
})

describe('scoreLearner — coverage guard (fail-loud, not score-as-wrong)', () => {
  const key = [
    { id: 'g1', type: 'mcq', correct: 'a' },
    { id: 'g2', type: 'mcq', correct: 'b' },
  ]
  it('flags a run whose answers use ids not in the key (the observed silent-zero bug)', () => {
    const s = scoreLearner([{ id: 'old-q-1', choice: 'a' }, { id: 'old-q-2', choice: 'b' }], key as any)
    expect(s.complete).toBe(false)
    expect(s.answered).toBe(0)
    expect(s.expected).toBe(2)
    expect(s.unknownIds).toEqual(['old-q-1', 'old-q-2'])
  })
  it('flags a partial run (answered < expected)', () => {
    const s = scoreLearner([{ id: 'g1', choice: 'a' }], key as any)
    expect(s.complete).toBe(false)
    expect(s.answered).toBe(1)
  })
  it('marks a full run complete and still scores real wrong answers as wrong', () => {
    const s = scoreLearner([{ id: 'g1', choice: 'a' }, { id: 'g2', choice: 'x' }], key as any)
    expect(s.complete).toBe(true)
    expect(s.correct).toBe(1) // g2 wrong but ANSWERED — a wrong answer, not a coverage hole
  })
})

describe('tallyAdversarial', () => {
  it('counts verdicts across modules', () => {
    const t = tallyAdversarial([
      { claims: [{ verdict: 'supported' }, { verdict: 'refuted' }] },
      { claims: [{ verdict: 'supported' }, { verdict: 'unverifiable' }, { verdict: 'supported' }] },
    ] as any)
    expect(t).toMatchObject({ total: 5, supported: 3, refuted: 1, unverifiable: 1 })
  })
})
