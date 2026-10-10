import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import type { QuoteBlock as QuoteBlockData } from '@schema/bundle'
import { BlockRenderer } from './BlockRenderer'
import { QuoteBlock } from './QuoteBlock'

const base: QuoteBlockData = {
  type: 'quote',
  text: 'We decided to freeze the remit cutoff.\nNobody changes it without Kwame.',
  sourcePath: 'notes/2026-09-02-standup.md',
  cite: { title: 'Standup notes', kind: 'transcript', date: '2026-09-02', speaker: 'Priya Rao' },
}

const show = (over: Partial<QuoteBlockData> = {}, cite: Partial<QuoteBlockData['cite']> = {}) =>
  render(<QuoteBlock block={{ ...base, ...over, cite: { ...base.cite, ...cite } }} />)

describe('QuoteBlock', () => {
  it('renders the quote as plain text in a blockquote, keeping line breaks', () => {
    const { container } = show()
    const bq = container.querySelector('blockquote')!
    expect(bq).toBeInTheDocument()
    expect(bq.textContent).toBe(base.text)
    expect(bq.querySelector('br')).toBeNull()
    expect(bq.firstElementChild).toHaveClass('whitespace-pre-line')
  })

  it('never interprets the text as HTML', () => {
    const { container } = show({ text: '<img src=x onerror=alert(1)> <b>bold</b>' })
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(container.querySelector('blockquote')!.textContent).toBe('<img src=x onerror=alert(1)> <b>bold</b>')
  })

  it('is a figure whose figcaption carries the citation: speaker, title, kind label and date', () => {
    show()
    const fig = screen.getByRole('figure')
    const cap = fig.querySelector('figcaption')!
    expect(within(cap).getByText('Priya Rao')).toBeInTheDocument()
    expect(within(cap).getByText('Standup notes')).toBeInTheDocument()
    expect(within(cap).getByText('Transcript')).toBeInTheDocument()
    expect(within(cap).getByText('2026-09-02')).toBeInTheDocument()
    expect(fig.querySelector('blockquote')).toBeInTheDocument()
  })

  it.each([
    ['transcript', 'Transcript'],
    ['pdf', 'PDF'],
    ['word', 'Word doc'],
    ['slides', 'Slides'],
    ['email', 'Email'],
    ['web', 'Web page'],
    ['html', 'Web page'],
    ['markdown', 'Document'],
    ['text', 'Document'],
    ['csv', 'Data'],
    ['json', 'Data'],
    ['remote', 'Online source'],
    ['PDF', 'PDF'],
    // anything else is a service label an agent wrote: shown as given
    ['Acme Wiki', 'Acme Wiki'],
    ['constructor', 'constructor'],
  ])('labels the kind %s as %s', (kind, label) => {
    show({}, { kind, speaker: undefined, date: undefined })
    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it('omits the parts that are absent without stray separators', () => {
    show({}, { kind: undefined, date: undefined, speaker: undefined })
    const cap = screen.getByRole('figure').querySelector('figcaption')!
    expect(cap.textContent).toBe('Standup notes')
  })

  it('shows the caption and the source path with its line range', () => {
    show({ caption: 'What the team agreed', lineRange: { start: 12, end: 14 } })
    expect(screen.getByText('What the team agreed')).toBeInTheDocument()
    expect(screen.getByText('notes/2026-09-02-standup.md')).toBeInTheDocument()
    expect(screen.getByText('lines 12-14')).toBeInTheDocument()
  })

  it('shows no line range when there is none', () => {
    show()
    expect(screen.queryByText(/^lines /)).toBeNull()
  })

  it.each([
    ['verified', 'Verified'],
    ['partial', 'Partial match'],
    ['drifted', 'Drifted'],
    ['missing-file', 'Source missing'],
  ] as const)('shows the %s badge', (verified, label) => {
    show({ verified })
    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it('shows no badge when the quote was never stamped or has no source', () => {
    const { unmount } = show()
    expect(screen.queryByText(/Verified|Partial match|Drifted|Source missing/)).toBeNull()
    unmount()
    show({ verified: 'no-source' })
    expect(screen.queryByText(/Verified|Partial match|Drifted|Source missing/)).toBeNull()
  })

  it('links an https url safely', () => {
    show({}, { url: 'https://example.com/notes/42' })
    const a = screen.getByRole('link', { name: 'Standup notes' })
    expect(a).toHaveAttribute('href', 'https://example.com/notes/42')
    expect(a).toHaveAttribute('target', '_blank')
    expect(a.getAttribute('rel')).toContain('noopener')
    expect(a.getAttribute('rel')).toContain('noreferrer')
  })

  it.each([
    'javascript:alert(1)',
    ' JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    '/relative/path',
    'not a url',
  ])('renders no link for %s', (url) => {
    const { container } = show({}, { url })
    expect(container.querySelector('a')).toBeNull()
    expect(screen.getByText('Standup notes')).toBeInTheDocument()
  })

  it('is rendered by BlockRenderer for a quote block', () => {
    render(<BlockRenderer block={base} />)
    expect(screen.getByRole('figure')).toBeInTheDocument()
    expect(screen.getByText('Standup notes')).toBeInTheDocument()
  })
})
