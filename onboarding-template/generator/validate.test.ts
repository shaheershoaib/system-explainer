import { describe, it, expect } from 'vitest'
import { validateBundle } from './validate'
import type { OnboardingBundle } from '../schema/bundle'

/** A minimal, fully-valid bundle. Each test clones and mutates it to trigger one failure. */
function minimalBundle(): OnboardingBundle {
  return structuredClone({
    schemaVersion: '1.0.0',
    system: { id: 'sys', name: 'Sys', oneLiner: 'does a thing for someone' },
    actors: [
      { id: 'a1', name: 'A1', role: 'first actor', relationships: [{ to: 'a2', label: 'works with' }] },
      { id: 'a2', name: 'A2', role: 'second actor' },
    ],
    entities: [
      {
        id: 'e1',
        name: 'E1',
        definition: 'the parent',
        relationships: [{ to: 'e2', cardinality: 'one-to-many', label: 'parent of' }],
      },
      { id: 'e2', name: 'E2', definition: 'the child' },
    ],
    modules: [
      {
        id: 'm1',
        title: 'Module One',
        order: 1,
        objective: 'understand the basics',
        lessons: [{ id: 'l1', title: 'Lesson One', blocks: [{ type: 'prose', md: 'hello' }] }],
        quiz: [
          {
            id: 'q1',
            type: 'mcq',
            prompt: 'Pick the right one',
            options: [
              { id: 'o1', text: 'right', correct: true },
              { id: 'o2', text: 'wrong', correct: false, ifChosen: 'here is why not' },
            ],
            explanation: 'because',
            misconception: { id: 'mc1', trap: 'a tempting wrong belief', correction: 'the fix' },
          },
        ],
      },
    ],
  }) as OnboardingBundle
}

describe('validateBundle', () => {
  it('accepts a minimal valid bundle and returns the typed bundle', () => {
    const res = validateBundle(minimalBundle())
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.bundle.system.id).toBe('sys')
  })

  it('rejects a dangling entity relationship', () => {
    const b = minimalBundle()
    b.entities[0].relationships![0].to = 'does-not-exist'
    const res = validateBundle(b)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join('\n')).toMatch(/entity .*relationship|does-not-exist/i)
  })

  it('rejects a dangling actor relationship', () => {
    const b = minimalBundle()
    b.actors[0].relationships![0].to = 'ghost'
    const res = validateBundle(b)
    expect(res.ok).toBe(false)
  })

  it('rejects a prerequisite that references a missing module', () => {
    const b = minimalBundle()
    b.modules[0].prerequisites = ['nope']
    const res = validateBundle(b)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join('\n')).toMatch(/prerequisite/i)
  })

  it('rejects a prerequisite cycle', () => {
    const b = minimalBundle()
    b.modules.push({
      id: 'm2',
      title: 'Module Two',
      order: 2,
      objective: 'next',
      prerequisites: ['m1'],
      lessons: [{ id: 'l2', title: 'L2', blocks: [{ type: 'prose', md: 'x' }] }],
      quiz: [],
    })
    b.modules[0].prerequisites = ['m2'] // m1 -> m2 -> m1
    const res = validateBundle(b)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join('\n')).toMatch(/cycle/i)
  })

  it('rejects duplicate misconception ids across modules (dashboard keys must be unique)', () => {
    const b = minimalBundle()
    b.modules.push({
      id: 'm2',
      title: 'Module Two',
      order: 2,
      objective: 'next',
      lessons: [{ id: 'l2', title: 'L2', blocks: [{ type: 'prose', md: 'x' }] }],
      quiz: [
        {
          id: 'q2',
          type: 'mcq',
          prompt: 'another',
          options: [
            { id: 'o1', text: 'a', correct: true },
            { id: 'o2', text: 'b', correct: false },
          ],
          explanation: 'e',
          misconception: { id: 'mc1', trap: 'dup', correction: 'fix' }, // duplicate mc1
        },
      ],
    })
    const res = validateBundle(b)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join('\n')).toMatch(/misconception/i)
  })

  it('rejects an MCQ with no correct option', () => {
    const b = minimalBundle()
    const q = b.modules[0].quiz[0]
    if (q.type === 'mcq') q.options.forEach((o) => (o.correct = false))
    const res = validateBundle(b)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join('\n')).toMatch(/correct/i)
  })

  it('rejects duplicate entity ids', () => {
    const b = minimalBundle()
    b.entities[1].id = 'e1'
    const res = validateBundle(b)
    expect(res.ok).toBe(false)
  })

  it('rejects an incompatible (major-bumped) schemaVersion', () => {
    const b = minimalBundle()
    b.schemaVersion = '2.0.0'
    const res = validateBundle(b)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join('\n')).toMatch(/version/i)
  })

  it('rejects malformed input (zod shape failure) without throwing', () => {
    const res = validateBundle({ nonsense: true })
    expect(res.ok).toBe(false)
  })
})

describe('validateBundle — simulations', () => {
  function withSim(): OnboardingBundle {
    const b = minimalBundle()
    b.simulations = [
      {
        id: 'sim1',
        title: 'Follow it',
        subject: 'a case',
        variables: [
          { key: 'status', label: 'Status', kind: 'text', initial: 'new' },
          { key: 'amt', label: 'Amount', kind: 'money', initial: 0 },
        ],
        steps: [
          { id: 's1', title: 'One', narrative: 'x', effects: [{ set: { status: 'done' }, add: { amt: 100 } }] },
          {
            id: 's2',
            title: 'Two',
            narrative: 'y',
            decision: {
              prompt: 'pick',
              options: [
                { id: 'o1', label: 'A', outcome: 'ok', effects: [{ add: { amt: 50 } }] },
                { id: 'o2', label: 'B', outcome: 'no' },
              ],
            },
          },
        ],
      },
    ]
    b.modules[0].lessons[0].blocks.push({ type: 'simulation', simulationId: 'sim1' })
    return b
  }

  it('accepts a valid simulation and block reference', () => {
    expect(validateBundle(withSim()).ok).toBe(true)
  })

  it('rejects a simulation block referencing a missing simulation', () => {
    const b = withSim()
    b.modules[0].lessons[0].blocks.push({ type: 'simulation', simulationId: 'ghost' })
    const r = validateBundle(b)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/missing simulation/i)
  })

  it('rejects an effect that touches an undeclared variable', () => {
    const b = withSim()
    b.simulations![0].steps[0].effects = [{ set: { ghost: 'x' } }]
    const r = validateBundle(b)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/undeclared variable/i)
  })

  it('rejects duplicate simulation ids', () => {
    const b = withSim()
    b.simulations!.push(structuredClone(b.simulations![0]))
    const r = validateBundle(b)
    expect(r.ok).toBe(false)
  })
})

describe('validateBundle — screens', () => {
  function withScreen(): OnboardingBundle {
    const b = minimalBundle()
    b.screens = [
      {
        id: 'scr1',
        title: 'A page',
        imageUrl: 'assets/screens/scr1.png',
        annotations: [{ id: 'a1', x: 0.1, y: 0.1, w: 0.3, h: 0.2, label: '1', md: 'the thing', entity: 'e1' }],
      },
    ]
    b.modules[0].lessons[0].blocks.push({ type: 'screen', screenId: 'scr1' })
    return b
  }

  it('accepts a valid screen and block reference', () => {
    expect(validateBundle(withScreen()).ok).toBe(true)
  })

  it('rejects a screen block referencing a missing screen', () => {
    const b = withScreen()
    b.modules[0].lessons[0].blocks.push({ type: 'screen', screenId: 'ghost' })
    const r = validateBundle(b)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/missing screen/i)
  })

  it('rejects an annotation that links a missing entity', () => {
    const b = withScreen()
    b.screens![0].annotations[0].entity = 'nope'
    const r = validateBundle(b)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/missing entity/i)
  })

  it('rejects annotation coordinates outside [0,1]', () => {
    const b = withScreen()
    b.screens![0].annotations[0].x = 1.5
    const r = validateBundle(b)
    expect(r.ok).toBe(false)
  })
})

describe('validateBundle — depth-pass content', () => {
  it('rejects an architecture connection to a missing component', () => {
    const b = minimalBundle()
    b.architecture = { components: [{ id: 'spa', name: 'SPA', kind: 'frontend' }], connections: [{ from: 'spa', to: 'ghost' }] }
    const r = validateBundle(b)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/architecture connection/i)
  })

  it('rejects a code-map entry linking a missing entity', () => {
    const b = minimalBundle()
    b.modules[0].lessons[0].blocks.push({ type: 'code-map', entries: [{ label: 'X', entity: 'nope', files: [{ path: 'a.ts' }] }] })
    const r = validateBundle(b)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/code-map links missing entity/i)
  })

  it('accepts a valid architecture + new depth blocks', () => {
    const b = minimalBundle()
    b.architecture = {
      components: [
        { id: 'spa', name: 'SPA', kind: 'frontend' },
        { id: 'api', name: 'API', kind: 'backend' },
      ],
      connections: [{ from: 'spa', to: 'api', label: 'REST' }],
    }
    b.modules[0].lessons[0].blocks.push(
      { type: 'code-map', entries: [{ label: 'Thing', entity: 'e1', files: [{ path: 'a.ts', role: 'model' }] }] },
      { type: 'decisions', items: [{ title: 'D', rationale: 'because', status: 'open-question' }] },
      { type: 'sources', items: [{ label: 'Story 1.1', kind: 'story' }] },
      { type: 'exercise', kind: 'find-in-code', prompt: 'Find X', modelAnswer: 'a.ts' },
      { type: 'diagram', diagram: { kind: 'architecture' } },
    )
    expect(validateBundle(b).ok).toBe(true)
  })
})

describe('validateBundle — persona, grounding, spot-the-bug', () => {
  it('accepts an audience persona, grounding + review provenance, and code-block grounding fields', () => {
    const b = minimalBundle()
    b.system.audience = 'non-technical'
    b.system.depth = 'L1'
    b.provenance = {
      sources: [{ path: 'kb/one-job.md' }],
      grounding: { repoRef: 'abc123', verifiedAt: '2026-06-18', total: 2, verified: 2, partial: 0, drifted: 0, missingFile: 0 },
      review: { reviewedBy: 'Shaheer', reviewedAt: '2026-06-18', openQuestions: ['confirm the edge case'] },
    }
    b.modules[0].lessons[0].blocks.push({
      type: 'code',
      language: 'ts',
      code: 'const x = 1',
      sourcePath: 'src/x.ts',
      excerpt: 'verbatim',
      lineRange: { start: 1, end: 1 },
      verified: 'verified',
    })
    const r = validateBundle(b)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.bundle.system.audience).toBe('non-technical')
  })

  it('rejects an unknown audience value', () => {
    const b = minimalBundle()
    ;(b.system as { audience?: string }).audience = 'manager'
    expect(validateBundle(b).ok).toBe(false)
  })

  it('accepts a valid spot-the-bug quiz item and feeds its misconception into the bank', () => {
    const b = minimalBundle()
    b.modules[0].quiz.push({
      id: 'sb1',
      type: 'spot-bug',
      prompt: 'Click the line that breaks the update',
      language: 'ts',
      lines: ['state.count++', 'return state', 'set({ count: 1 })'],
      buggyLine: 1,
      explanation: 'mutating in place never notifies listeners',
      fix: 'return a new object via set',
      misconception: { id: 'mc-mutate', trap: 'in-place mutation notifies', correction: 'only set notifies' },
    })
    expect(validateBundle(b).ok).toBe(true)
  })

  it('rejects a spot-the-bug whose buggyLine is out of range', () => {
    const b = minimalBundle()
    b.modules[0].quiz.push({
      id: 'sb2',
      type: 'spot-bug',
      prompt: 'pick the bug',
      lines: ['a', 'b'],
      buggyLine: 5,
      explanation: 'x',
    })
    const r = validateBundle(b)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/buggyLine .* out of range/i)
  })

  it('still flags a duplicate misconception id contributed by a spot-the-bug item', () => {
    const b = minimalBundle()
    b.modules[0].quiz.push({
      id: 'sb3',
      type: 'spot-bug',
      prompt: 'pick the bug',
      lines: ['a', 'b'],
      buggyLine: 1,
      explanation: 'x',
      misconception: { id: 'mc1', trap: 'dup from spot-bug', correction: 'fix' }, // mc1 already used by q1
    })
    const r = validateBundle(b)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/misconception/i)
  })
})
