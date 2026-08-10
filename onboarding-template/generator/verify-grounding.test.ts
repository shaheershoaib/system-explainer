import { describe, it, expect } from 'vitest'
import {
  distinctiveTokens,
  coverageOf,
  statusFor,
  exactMatch,
  findLineRange,
  verifyGrounding,
  summarize,
  collectOpenQuestions,
  type FileReader,
} from './verify-grounding'
import type { OnboardingBundle } from '../schema/bundle'

describe('distinctiveTokens', () => {
  it('keeps domain identifiers and drops keywords + short tokens', () => {
    const toks = distinctiveTokens('const setState = (partial) => listeners.forEach(l => l(state))')
    expect(toks).toContain('setState')
    expect(toks).toContain('listeners')
    expect(toks).toContain('forEach')
    expect(toks).not.toContain('const') // keyword
    expect(toks).not.toContain('l') // length < 3
  })
})

describe('coverageOf', () => {
  const source = `
    const setState = (partial, replace) => {
      const nextState = typeof partial === 'function' ? partial(state) : partial
      if (!Object.is(nextState, state)) {
        const previousState = state
        state = Object.assign({}, state, nextState)
        listeners.forEach((listener) => listener(state, previousState))
      }
    }`

  it('is ~1 for a faithful-but-simplified snippet (types stripped) of the source', () => {
    // identifiers all present even though the snippet drops TS type annotations
    const snippet = `const setState = (partial, replace) => {
  const nextState = typeof partial === 'function' ? partial(state) : partial
  if (!Object.is(nextState, state)) {
    state = Object.assign({}, state, nextState)
    listeners.forEach((listener) => listener(state, previousState))
  }
}`
    expect(coverageOf(snippet, source)).toBeGreaterThan(0.85)
  })

  it('drops toward 0 when the cited code has drifted away (identifiers gone)', () => {
    const drifted = 'export function unrelated(banana, kiwi) { return banana + kiwi }'
    expect(coverageOf('const setState = (partial) => listeners.forEach(notify)', drifted)).toBeLessThan(0.3)
  })
})

describe('statusFor', () => {
  it('holds verbatim snippets to a higher bar than adapted ones', () => {
    expect(statusFor(0.7, 'adapted')).toBe('verified')
    expect(statusFor(0.7, 'verbatim')).toBe('partial')
    expect(statusFor(0.2)).toBe('drifted')
  })
})

function bundleWithCode(): OnboardingBundle {
  return {
    schemaVersion: '1.0.0',
    system: { id: 's', name: 'S', oneLiner: 'x' },
    actors: [],
    entities: [{ id: 'e1', name: 'E1', definition: 'd' }],
    modules: [
      {
        id: 'm1',
        title: 'M1',
        order: 1,
        objective: 'o',
        lessons: [
          {
            id: 'l1',
            title: 'L1',
            blocks: [
              { type: 'code', language: 'ts', code: 'export function add(a, b) { return a + b }', sourcePath: 'src/math.ts' },
              { type: 'code', language: 'ts', code: 'whatever()', sourcePath: 'src/missing.ts' },
              { type: 'code', language: 'ts', code: 'const inline = 1' }, // no sourcePath
              {
                type: 'callout',
                variant: 'gotcha',
                md: 'careful',
                smeQuestion: 'Is the rounding correct for our use case?',
              },
              {
                type: 'decisions',
                items: [{ title: 'D', rationale: 'r', status: 'open-question', sme: 'Confirm the contract owner.' }],
              },
            ],
          },
        ],
        quiz: [],
      },
    ],
  } as OnboardingBundle
}

describe('verifyGrounding', () => {
  const reader: FileReader = (p) =>
    p === 'src/math.ts' ? 'export function add(a, b) { return a + b }\nexport const PI = 3.14' : null

  it('marks a grounded snippet verified, a missing file missing-file, and a sourceless block no-source', () => {
    const results = verifyGrounding(bundleWithCode(), reader)
    const byPath = (p?: string) => results.find((r) => r.ref.sourcePath === p)
    expect(byPath('src/math.ts')!.status).toBe('verified')
    expect(byPath('src/missing.ts')!.status).toBe('missing-file')
    expect(results.find((r) => !r.ref.sourcePath)!.status).toBe('no-source')
  })

  it('summarize tallies the statuses', () => {
    const s = summarize(verifyGrounding(bundleWithCode(), reader))
    expect(s.total).toBe(3)
    expect(s.verified).toBe(1)
    expect(s.missingFile).toBe(1)
    expect(s.noSource).toBe(1)
  })
})

describe('collectOpenQuestions', () => {
  it('gathers SME questions from callouts and open-question decisions', () => {
    const qs = collectOpenQuestions(bundleWithCode())
    expect(qs).toContain('Is the rounding correct for our use case?')
    expect(qs).toContain('Confirm the contract owner.')
  })
})

describe('exactMatch (line-exact verbatim)', () => {
  const file = 'export function add(a, b) {\n    return a + b\n}\nexport const PI = 3.14159'
  it('is true for a contiguous copy, tolerating whitespace / indentation', () => {
    expect(exactMatch('export function add(a, b) {\n  return a + b\n}', file)).toBe(true)
  })
  it('is false for an elided / non-contiguous snippet', () => {
    expect(exactMatch('export function add(a, b) {\n  // ...\n}\nexport const PI', file)).toBe(false)
  })
  it('is false for a too-short snippet (avoids trivial matches)', () => {
    expect(exactMatch('a + b', file)).toBe(false)
  })
})

describe('findLineRange (deep-link line numbers for exact matches)', () => {
  const file = ['import x', '', 'def add(a, b):', '    return a + b', '', 'PI = 3.14'].join('\n')
  it('locates a contiguous snippet as a 1-based inclusive range', () => {
    expect(findLineRange('def add(a, b):\n  return a + b', file)).toEqual({ start: 3, end: 4 })
  })
  it('tolerates blank lines in the file within the run', () => {
    expect(findLineRange('def add(a, b):\n  return a + b\nPI = 3.14', file)).toEqual({ start: 3, end: 6 })
  })
  it('returns null for a non-contiguous / absent snippet', () => {
    expect(findLineRange('def add(a, b):\nPI = 2.71', file)).toBeNull()
    expect(findLineRange('not here at all', file)).toBeNull()
  })
})

describe('verifyGrounding — exact mode', () => {
  function bundleExact(): OnboardingBundle {
    return {
      schemaVersion: '1.0.0',
      system: { id: 's', name: 'S', oneLiner: 'x' },
      actors: [],
      entities: [{ id: 'e', name: 'E', definition: 'd' }],
      modules: [
        {
          id: 'm1', title: 'M', order: 1, objective: 'o',
          lessons: [{ id: 'l1', title: 'L', blocks: [
            { type: 'code', language: 'ts', code: 'export function add(a, b) { return a + b }', sourcePath: 'm.ts' },
            { type: 'code', language: 'ts', code: 'export function add(a, b) { return a + b }', sourcePath: 'm.ts', excerpt: 'verbatim' },
            { type: 'code', language: 'ts', code: 'function add(x, y) { /* ... */ return x + y }', sourcePath: 'm.ts', excerpt: 'verbatim' },
          ] }],
          quiz: [],
        },
      ],
    } as OnboardingBundle
  }
  const reader: FileReader = (p) => (p === 'm.ts' ? 'export function add(a, b) { return a + b }\nexport const PI = 3.14159' : null)

  it('marks a contiguous copy exact + verified, and counts exact in the summary', () => {
    const results = verifyGrounding(bundleExact(), reader)
    expect(results[0].exact).toBe(true)
    expect(results[0].status).toBe('verified')
    expect(summarize(results).exact).toBe(2) // blocks 0 and 1 are exact copies
  })
  it('flags a snippet that CLAIMS verbatim but is not an exact copy (capped at partial)', () => {
    const results = verifyGrounding(bundleExact(), reader)
    expect(results[2].exact).toBe(false)
    expect(results[2].status).toBe('partial')
  })
})
