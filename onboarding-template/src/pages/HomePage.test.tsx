import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { OnboardingBundle } from '@schema/bundle'

// HomePage reads the bundle through useBundle; serve one directly instead of fetching bundle.json.
let current: OnboardingBundle
vi.mock('../lib/useBundle', () => ({
  useBundle: () => current,
  useBundleState: () => ({ status: 'ready', bundle: current }),
}))

import { HomePage } from './HomePage'

const bundle = (provenance?: OnboardingBundle['provenance']): OnboardingBundle => ({
  schemaVersion: '1.1.0',
  system: { id: 'sys', name: 'Remit course', oneLiner: 'How remits work' },
  actors: [],
  entities: [],
  modules: [{ id: 'm1', title: 'Module one', order: 1, objective: 'Learn it', lessons: [], quiz: [] }],
  provenance,
})

const grounding = { repoRef: 'org/repo@0123456789abcdef', total: 10, verified: 9, partial: 0, drifted: 1, missingFile: 0 }
const sources: NonNullable<OnboardingBundle['provenance']>['sources'] = []

const renderHome = () =>
  render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>,
  )

const pill = () => screen.getByText(/9\/10 verified/).closest('span')!

describe('HomePage unreachable-sources banner', () => {
  it('lists each unreadable source with why, when there are some', () => {
    current = bundle({
      sources,
      corpus: {
        mode: 'documents',
        docs: 4,
        unreachable: [
          { source: 'meetings/scan-0412.pdf', why: 'scanned PDF with no text layer' },
          { source: 'https://wiki.example.com/private', why: 'HTTP 403, login required' },
        ],
      },
    })
    renderHome()
    expect(
      screen.getByRole('heading', { name: 'This course was built without 2 sources that could not be read' }),
    ).toBeInTheDocument()
    expect(screen.getByText('meetings/scan-0412.pdf')).toBeInTheDocument()
    expect(screen.getByText('scanned PDF with no text layer')).toBeInTheDocument()
    expect(screen.getByText('https://wiki.example.com/private')).toBeInTheDocument()
    expect(screen.getByText('HTTP 403, login required')).toBeInTheDocument()
  })

  it('uses the singular for one source', () => {
    current = bundle({ sources, corpus: { mode: 'documents', docs: 3, unreachable: [{ source: 'a.pdf', why: 'encrypted' }] } })
    renderHome()
    expect(screen.getByRole('heading', { name: 'This course was built without 1 source that could not be read' })).toBeInTheDocument()
  })

  it.each([
    ['no provenance', undefined],
    ['no corpus', { sources }],
    ['corpus without unreachable', { sources, corpus: { mode: 'documents' as const, docs: 3 } }],
    ['empty unreachable', { sources, corpus: { mode: 'documents' as const, docs: 3, unreachable: [] } }],
  ])('shows no banner with %s', (_name, provenance) => {
    current = bundle(provenance)
    renderHome()
    expect(screen.queryByText(/could not be read/)).toBeNull()
  })
})

describe('HomePage grounding wording', () => {
  it('says code snippets and the repo for a code bundle, exactly as before', () => {
    current = bundle({ sources, grounding, corpus: { mode: 'code', docs: 0 } })
    renderHome()
    expect(pill()).toHaveAttribute('title', '9/10 code snippets verified against org/repo@0123456 · 1 drifted')
  })

  it('is unchanged when the bundle has no corpus summary at all', () => {
    current = bundle({ sources, grounding })
    renderHome()
    expect(pill()).toHaveAttribute('title', '9/10 code snippets verified against org/repo@0123456 · 1 drifted')
  })

  it('says quotes verified against the source documents in documents mode', () => {
    current = bundle({ sources, grounding, corpus: { mode: 'documents', docs: 4 } })
    renderHome()
    const title = pill().getAttribute('title')!
    expect(title).toBe('9/10 quotes verified against 4 source documents · 1 drifted')
    expect(title).not.toMatch(/snippet|org\/repo/)
  })

  it('uses the singular for one source document', () => {
    current = bundle({ sources, grounding, corpus: { mode: 'documents', docs: 1 } })
    renderHome()
    expect(pill().getAttribute('title')).toContain('against 1 source document ')
  })

  it('names snippets and quotes together in mixed mode', () => {
    current = bundle({ sources, grounding, corpus: { mode: 'mixed', docs: 4 } })
    renderHome()
    expect(pill().getAttribute('title')).toBe(
      '9/10 snippets and quotes verified against org/repo@0123456 and 4 source documents · 1 drifted',
    )
  })
})
