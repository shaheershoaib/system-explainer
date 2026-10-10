// @vitest-environment node
import { describe, it, expect, afterAll, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type Anthropic from '@anthropic-ai/sdk'
import { createFakeClient } from '../llm/fake'
import { defaultWhich, ingest, type IngestOptions } from './index'
import { parseTranscript } from './local'

const FIXTURES = fileURLToPath(new URL('../../fixtures/mini-docs', import.meta.url))
const NOW = new Date('2026-10-10T12:00:00.000Z')
const tmp: string[] = []
const scratch = (label: string) => {
  const d = mkdtempSync(path.join(tmpdir(), `ingest-${label}-`))
  tmp.push(d)
  return d
}
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true })
})

const noFetch = vi.fn(async () => {
  throw new Error('fetch must not be called for local sources')
}) as unknown as typeof fetch
const run = (sources: string[], extra: Partial<IngestOptions> = {}) =>
  ingest({ sources, corpusDir: path.join(extra.cwd ?? scratch('corpus'), 'corpus'), fetch: noFetch, which: defaultWhich, now: () => NOW, ...extra })
const docText = (corpus: string, rel: string) => readFileSync(path.join(corpus, rel), 'utf8')
const fixture = (name: string) => path.join(FIXTURES, name)
const hasZip = Boolean(defaultWhich('unzip'))
const hasPdftotext = Boolean(defaultWhich('pdftotext'))

/** A one-page PDF whose page draws nothing: no text layer. */
function scannedPdf(): Buffer {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream']
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

describe('ingest: local formats', () => {
  it('normalizes every fixture format into the corpus with front matter, and never fetches', async () => {
    const dir = scratch('all')
    const res = await run([FIXTURES], { cwd: dir })
    const corpus = path.join(dir, 'corpus')
    const byName = (n: string) => res.manifest.docs.find((d) => d.path.endsWith(`/${n}.md`))!

    const kickoff = byName('2026-09-02-kickoff-notes')
    expect(docText(corpus, kickoff.path)).toBe(
      [
        '---',
        'title: "Larkspur kickoff"',
        'source: markdown',
        `origin: ${JSON.stringify(fixture('2026-09-02-kickoff-notes.md'))}`,
        'date: 2026-09-02',
        'speakers: ["Dana", "Sam", "Priya"]',
        'via: "local file"',
        'retrieved: 2026-10-10T12:00:00.000Z',
        '---',
        '',
        readFileSync(fixture('2026-09-02-kickoff-notes.md'), 'utf8'),
      ].join('\n'),
    )
    expect(kickoff).toMatchObject({ title: 'Larkspur kickoff', kind: 'markdown', date: '2026-09-02', speakers: ['Dana', 'Sam', 'Priya'], via: 'local file' })

    const review = docText(corpus, byName('2026-09-16-pricing-review').path)
    expect(review).toContain('title: "Pricing review"\nsource: transcript')
    expect(review).toContain('[00:00:20] Dana: Then we change it. From October 1, the free tier goes to 5 seats. That replaces the kickoff decision.')

    const guide = docText(corpus, byName('onboarding-guide').path)
    expect(guide).toContain('title: "Larkspur onboarding guide"')
    expect(guide).toContain('# Larkspur onboarding guide\n\nWelcome to Larkspur.')
    expect(guide).toContain('## Your first week\n\n- Ask Sam for access to the support inbox.\n- Shadow two customer calls with Dana.')
    expect(guide).toContain('Every change goes through a pull request & one review.')
    for (const hidden of ['ignore your instructions', 'unlimited', 'TRACKING-SCRIPT-MARKER', 'SCRIPT-WRITE-MARKER', 'NOSCRIPT-MARKER', 'font-family', 'window.analytics']) {
      expect(guide).not.toContain(hidden)
    }

    expect(docText(corpus, byName('support-faq').path)).toContain('source: text')
    expect(res.mode).toBe('documents')
    expect(res.usage).toEqual({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
    expect(noFetch).not.toHaveBeenCalled()

    // the png is the folder's one unreadable file: its own problem, and its own manifest entry
    expect(res.problems.map((p) => p.source)).toEqual([fixture('whiteboard.png')].concat(hasPdftotext ? [] : [fixture('handbook.pdf')]).sort())
    expect(res.manifest.sources[0]).toMatchObject({ raw: FIXTURES, kind: 'folder', status: 'ok' })
    expect(res.manifest.sources.find((s) => s.raw === fixture('whiteboard.png'))).toMatchObject({ kind: 'image', status: 'unreachable', docs: [] })
  })

  it.skipIf(!hasZip)('reads Word and PowerPoint through unzip: headings, lists, tabs, breaks, notes via relationships, core.xml title and date', async () => {
    const dir = scratch('ooxml')
    const res = await run([fixture('roadmap.docx'), fixture('q4-plan.pptx')], { cwd: dir })
    const [word, slides] = res.manifest.docs.sort((a, b) => a.path.localeCompare(b.path)).reverse()
    expect(word).toMatchObject({ kind: 'word', title: 'Larkspur Q4 roadmap', date: '2026-09-20' })
    const w = docText(path.join(dir, 'corpus'), word.path)
    expect(w).toContain(
      '# Larkspur Q4 roadmap\n\nOwner: Dana. Last reviewed after the pricing review.\n\n## Milestones\n\n- Raise the free tier to 5 seats (Sam) - October 1\n- Ship the redesigned booking page (Priya) - October\n',
    )
    expect(w).toContain('Risks\tcalendar API quotas & clinic data migration')
    expect(w).toContain('Line one\nLine two')
    expect(slides).toMatchObject({ kind: 'slides', title: 'Larkspur Q4 plan', date: '2026-09-20' })
    const s = docText(path.join(dir, 'corpus'), slides.path)
    expect(s).toContain('## Slide 1\n\nQ4 plan\nLarkspur, October to December 2026\n\n## Slide 2\n\nMilestones\n')
    expect(s).toContain('Speaker notes:\nRemind the team that the free tier change lands October 1.\n')
    expect(s.split('## Slide 2')[0]).not.toContain('Speaker notes')
  })

  it('docx XML with a DOCTYPE and entity declarations is never expanded (XXE-safe)', async () => {
    const { docxToMarkdown } = await import('./local')
    const xml = '<?xml version="1.0"?><!DOCTYPE w [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><w:document><w:body><w:p><w:r><w:t>a &xxe; b &amp; &#65;&#x42;</w:t></w:r></w:p></w:body></w:document>'
    expect(docxToMarkdown(xml)).toBe('a &xxe; b & AB')
  })

  it.skipIf(!hasPdftotext)('extracts the real handbook.pdf with pdftotext, page-marked', async () => {
    const dir = scratch('pdf')
    const res = await run([fixture('handbook.pdf')], { cwd: dir })
    expect(res.problems).toEqual([])
    const text = docText(path.join(dir, 'corpus'), res.manifest.docs[0].path)
    expect(text).toContain('source: pdf')
    expect(text).toContain('[page 1]\nLarkspur Team Handbook\nSupport hours are 8am to 6pm Eastern, Monday to Friday.')
  })

  it('pdftotext missing: a problem with the brew / apt / --transcribe fixes', async () => {
    const res = await run([fixture('handbook.pdf')], { which: (b) => (b === 'pdftotext' ? null : defaultWhich(b)) })
    expect(res.problems).toHaveLength(1)
    const p = res.problems[0]
    expect(p).toMatchObject({ source: fixture('handbook.pdf'), kind: 'pdf', observed: 'pdftotext not on PATH' })
    expect(p.fixes.join('\n')).toMatch(/brew install poppler[\s\S]*apt-get install poppler-utils[\s\S]*--transcribe/)
    expect(res.manifest.sources[0]).toMatchObject({ status: 'unreachable', docs: [], problem: p })
  })

  it('image without --transcribe: a problem whose first fix is --transcribe', async () => {
    const res = await run([fixture('whiteboard.png')])
    expect(res.problems[0]).toMatchObject({ kind: 'image' })
    expect(res.problems[0].fixes[0]).toMatch(/^Pass --transcribe/)
  })

  it('audio and spreadsheets are refused with the transcript / CSV fixes', async () => {
    const dir = scratch('refused')
    writeFileSync(path.join(dir, 'standup.mp4'), Buffer.from([0, 0, 0, 0x18]))
    writeFileSync(path.join(dir, 'budget.xlsx'), Buffer.from('PK\u0003\u0004'))
    const res = await run([path.join(dir, 'standup.mp4'), path.join(dir, 'budget.xlsx')], { cwd: dir })
    expect(res.problems.map((p) => p.kind)).toEqual(['audio-video', 'spreadsheet'])
    expect(res.problems[0].fixes[0]).toMatch(/transcript/)
    expect(res.problems[1].fixes[0]).toMatch(/CSV/)
  })
})

describe('ingest: transcripts, email, json, csv, unknown extensions', () => {
  it('normalizes VTT and SRT cues to [HH:MM:SS] Name: text and collects speakers', () => {
    const vtt = 'WEBVTT\nKind: captions\n\nNOTE\nthis is a note\n\n1\n01:02:03.400 --> 01:02:05.000\n<v.loud Ana Ruiz>Hi <b>all</b> &amp; welcome</v>\n\n00:07.000 --> 00:09.000\nBen: second\nline\n\n3\n00:00:10.000 --> 00:00:11.000\nno speaker here'
    expect(parseTranscript(vtt)).toEqual({
      lines: ['[01:02:03] Ana Ruiz: Hi all & welcome', '[00:00:07] Ben: second line', '[00:00:10] no speaker here'],
      speakers: ['Ana Ruiz', 'Ben'],
    })
    const srt = '1\r\n00:00:01,500 --> 00:00:03,000\r\nDana: hello\r\n\r\n2\r\n00:01:00,000 --> 00:01:02,000\r\nSam: hi'
    expect(parseTranscript(srt).lines).toEqual(['[00:00:01] Dana: hello', '[00:01:00] Sam: hi'])
  })

  it('reads an .eml: headers, quoted-printable text part, encoded subject, the Date header day', async () => {
    const dir = scratch('eml')
    const eml = [
      'From: "Dana Lee" <dana@larkspur.example>',
      'To: Sam <sam@larkspur.example>',
      'Date: Tue, 15 Sep 2026 23:30:00 -0700',
      'Subject: =?UTF-8?B?UHJpY2luZyByZXZpZXcgcHJlcA==?=',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Seats: we should go from 3 to 5 =E2=80=94 thoughts?=',
      ' Agenda attached.',
      '--b1',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('<p>HTML version</p>').toString('base64'),
      '--b1--',
      '',
    ].join('\r\n')
    writeFileSync(path.join(dir, 'prep.eml'), eml)
    const res = await run([path.join(dir, 'prep.eml')], { cwd: dir })
    const doc = res.manifest.docs[0]
    expect(doc).toMatchObject({ kind: 'email', title: 'Pricing review prep', date: '2026-09-15', speakers: ['Dana Lee', 'Sam'] })
    const text = docText(path.join(dir, 'corpus'), doc.path)
    expect(text).toContain('From: "Dana Lee" <dana@larkspur.example>\nTo: Sam <sam@larkspur.example>\nDate: Tue, 15 Sep 2026 23:30:00 -0700\nSubject: Pricing review prep\n\nSeats: we should go from 3 to 5 — thoughts? Agenda attached.')
    expect(text).not.toContain('HTML version')
  })

  it('pretty-prints JSON in a fence, keeps CSV as is, sniffs unknown extensions as text, strips a BOM and CRLF', async () => {
    const dir = scratch('misc')
    writeFileSync(path.join(dir, 'data.json'), '{"a":1,"b":[true]}')
    writeFileSync(path.join(dir, 'seats.csv'), 'plan,seats\r\nfree,5\r\n')
    writeFileSync(path.join(dir, 'notes.weird'), '﻿line one\r\n\r\n\r\n\r\n\r\nline two\r\n')
    writeFileSync(path.join(dir, 'blob.dat'), Buffer.from([0x50, 0x00, 0x01, 0x02]))
    const out = scratch('misc-out')
    const res = await run([dir], { cwd: out })
    const body = (n: string) => docText(path.join(out, 'corpus'), res.manifest.docs.find((x) => x.path.endsWith(`/${n}.md`))!.path).split('---\n\n')[1]
    expect(body('data')).toBe('```json\n{\n  "a": 1,\n  "b": [\n    true\n  ]\n}\n```\n')
    expect(body('seats')).toBe('plan,seats\nfree,5\n')
    expect(body('notes')).toBe('line one\n\n\nline two\n')
    expect(res.problems).toHaveLength(1)
    expect(res.problems[0]).toMatchObject({ source: path.join(dir, 'blob.dat'), kind: 'text', why: 'it is an unsupported binary format (not UTF-8 text).' })
    expect(res.problems[0].fixes).toEqual(['Export it as PDF, Markdown or plain text and pass that file.', 'Or remove it from the folder, or pass --allow-partial to build without it.'])
  })
})

describe('ingest: corpus files, manifest, re-ingest', () => {
  it('sorts docs oldest first (undated last), and sha256 / bytes describe the file bytes', async () => {
    const dir = scratch('order')
    writeFileSync(path.join(dir, '2026-01-05-b.md'), '# B\n')
    writeFileSync(path.join(dir, '2025-12-31-a.md'), '# A\n')
    const web = vi.fn(async () => new Response('<html><body><p>' + 'Undated page text. '.repeat(20) + '</p></body></html>', { headers: { 'content-type': 'text/html' } }))
    const corpusDir = path.join(dir, 'corpus')
    const res = await ingest({ sources: [path.join(dir, '2026-01-05-b.md'), 'https://docs.example.test/page', path.join(dir, '2025-12-31-a.md')], corpusDir, fetch: web as unknown as typeof fetch, which: () => null, now: () => NOW })
    expect(res.manifest.docs.map((d) => [d.date, d.kind])).toEqual([
      ['2025-12-31', 'markdown'],
      ['2026-01-05', 'markdown'],
      [undefined, 'web'],
    ])
    for (const d of res.manifest.docs) {
      const bytes = readFileSync(path.join(corpusDir, d.path))
      expect(d.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
      expect(d.bytes).toBe(bytes.length)
      expect(d.path).toMatch(/^[a-z0-9-]+\/[a-z0-9/-]+\.md$/)
    }
    expect(JSON.parse(readFileSync(path.join(corpusDir, 'manifest.json'), 'utf8'))).toEqual(JSON.parse(JSON.stringify(res.manifest)))
  })

  it('removes stale docs on re-ingest and keeps an unchanged doc byte-identical (same sha256)', async () => {
    const dir = scratch('stale')
    writeFileSync(path.join(dir, 'keep.md'), '# Keep\n')
    writeFileSync(path.join(dir, 'drop.md'), '# Drop\n')
    const corpusDir = path.join(dir, 'corpus')
    const first = await ingest({ sources: [path.join(dir, 'keep.md'), path.join(dir, 'drop.md')], corpusDir, fetch: noFetch, which: () => null, now: () => NOW })
    const dropped = first.manifest.docs.find((d) => d.title === 'Drop')!
    expect(existsSync(path.join(corpusDir, dropped.path))).toBe(true)

    const later = new Date('2026-10-11T08:00:00.000Z')
    const second = await ingest({ sources: [path.join(dir, 'keep.md')], corpusDir, fetch: noFetch, which: () => null, now: () => later })
    expect(existsSync(path.join(corpusDir, dropped.path))).toBe(false)
    expect(existsSync(path.join(corpusDir, path.dirname(dropped.path)))).toBe(false)
    expect(second.manifest.docs).toHaveLength(1)
    expect(second.manifest.docs[0].sha256).toBe(first.manifest.docs.find((d) => d.title === 'Keep')!.sha256)
    expect(second.manifest.docs[0].retrievedAt).toBe(NOW.toISOString())
    expect(second.manifest.createdAt).toBe(later.toISOString())

    writeFileSync(path.join(dir, 'keep.md'), '# Keep\n\nchanged\n')
    const third = await ingest({ sources: [path.join(dir, 'keep.md')], corpusDir, fetch: noFetch, which: () => null, now: () => later })
    expect(third.manifest.docs[0].sha256).not.toBe(second.manifest.docs[0].sha256)
    expect(third.manifest.docs[0].retrievedAt).toBe(later.toISOString())
  })

  it('infers dates: file-name date first, then the file mtime', async () => {
    const dir = scratch('dates')
    writeFileSync(path.join(dir, '2026-02-30-not-a-date.md'), '# x\n')
    writeFileSync(path.join(dir, '2026-03-04 standup.txt'), 'x\n')
    const res = await run([dir], { cwd: scratch('dates-out') })
    const byTitle = Object.fromEntries(res.manifest.docs.map((d) => [d.title, d.date]))
    expect(byTitle['Standup']).toBe('2026-03-04')
    expect(byTitle['x']).toBe(new Date().toISOString().slice(0, 10))
  })
})

describe('ingest: repositories and mode', () => {
  const repoDir = () => {
    const d = scratch('repo')
    mkdirSync(path.join(d, '.git'))
    writeFileSync(path.join(d, 'index.ts'), 'export {}\n')
    return d
  }

  it('one repo alone is code mode; with documents it is mixed; documents alone are documents', async () => {
    const repo = repoDir()
    const notes = path.join(scratch('notes'), 'notes.md')
    writeFileSync(notes, '# Notes\n')
    const code = await run([repo])
    expect(code).toMatchObject({ mode: 'code', repo, problems: [] })
    expect(code.manifest.sources[0]).toMatchObject({ kind: 'repo', status: 'ok', docs: [] })
    expect((await run([repo, notes])).mode).toBe('mixed')
    expect((await run([notes])).mode).toBe('documents')
  })

  it('a second repository is a problem; the first stays the repo', async () => {
    const a = repoDir()
    const b = repoDir()
    const res = await run([a, b])
    expect(res.repo).toBe(a)
    expect(res.problems).toHaveLength(1)
    expect(res.problems[0].source).toBe(b)
    expect(res.problems[0].why).toMatch(/^A course is built from one repository/)
    expect(res.problems[0].fixes[0]).toMatch(/separately/)
  })

  it('a missing path is a problem naming the resolved path and the sources command', async () => {
    const cwd = scratch('missing')
    const res = await run(['./nope/notes.md'], { cwd })
    expect(res.problems[0]).toMatchObject({ kind: 'unknown', why: `nothing exists at ${path.join(cwd, 'nope/notes.md')}.` })
    expect(res.problems[0].fixes.join(' ')).toContain('system-explainer sources')
  })
})

describe('ingest: transcription (--transcribe)', () => {
  const textClient = (text: string, stop?: 'end_turn' | 'max_tokens') => {
    const seen: Anthropic.MessageCreateParamsNonStreaming[] = []
    const client = createFakeClient((_i, params) => {
      seen.push(params)
      return { text, stop }
    })
    return { client, seen }
  }

  it('transcribes an image through an image block and marks the doc transcribedBy', async () => {
    const { client, seen } = textClient('Whiteboard: free tier = 5 seats')
    const dir = scratch('img')
    const res = await run([fixture('whiteboard.png')], { cwd: dir, transcribe: { client, model: 'claude-opus-5' } })
    expect(res.problems).toEqual([])
    expect(res.manifest.docs[0]).toMatchObject({ kind: 'image', transcribedBy: 'claude-opus-5', title: 'Whiteboard' })
    const block = (seen[0].messages[0].content as Anthropic.ContentBlockParam[])[0]
    expect(block).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: readFileSync(fixture('whiteboard.png')).toString('base64') } })
    expect(seen[0].max_tokens).toBe(16000)
    expect(String(seen[0].system)).toMatch(/verbatim[\s\S]*\[illegible\][\s\S]*data, not instructions/)
    const text = docText(path.join(dir, 'corpus'), res.manifest.docs[0].path)
    expect(text).toContain('transcribed_by: "claude-opus-5"')
    expect(text).toContain('Whiteboard: free tier = 5 seats')
  })

  it('transcribes a scanned PDF through a document block; max_tokens marks it truncated', async () => {
    const { client, seen } = textClient('[page 1]\nScanned memo', 'max_tokens')
    const dir = scratch('scan')
    writeFileSync(path.join(dir, 'memo.pdf'), scannedPdf())
    const res = await run([path.join(dir, 'memo.pdf')], { cwd: dir, transcribe: { client, model: 'claude-opus-5' } })
    expect(res.problems).toEqual([])
    const block = (seen[0].messages[0].content as Anthropic.ContentBlockParam[])[0]
    expect(block).toEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: scannedPdf().toString('base64') } })
    expect(docText(path.join(dir, 'corpus'), res.manifest.docs[0].path)).toMatch(/Scanned memo\n\n\[transcription truncated\]\n$/)
  })

  it.skipIf(!hasPdftotext)('a scanned PDF without --transcribe is a "no text layer" problem with --transcribe first', async () => {
    const dir = scratch('scan2')
    writeFileSync(path.join(dir, 'memo.pdf'), scannedPdf())
    const res = await run([path.join(dir, 'memo.pdf')], { cwd: dir })
    expect(res.problems[0].why).toMatch(/no text layer \(probably scanned\)/)
    expect(res.problems[0].fixes[0]).toMatch(/^Pass --transcribe/)
  })

  it('never calls the model when other sources failed, unless --allow-partial; never for text sources', async () => {
    const { client, seen } = textClient('words')
    const notes = path.join(scratch('t'), 'notes.md')
    writeFileSync(notes, '# n\n')
    await run([notes], { transcribe: { client, model: 'm' } })
    expect(seen).toHaveLength(0)

    const blocked = await run(['./missing.md', fixture('whiteboard.png')], { cwd: scratch('t2'), transcribe: { client, model: 'm' } })
    expect(seen).toHaveLength(0)
    expect(blocked.problems.map((p) => p.kind)).toEqual(['unknown', 'image'])
    expect(blocked.problems[1].why).toMatch(/^it was not transcribed: 1 other source could not be read/)

    const partial = await run(['./missing.md', fixture('whiteboard.png')], { cwd: scratch('t3'), transcribe: { client, model: 'm' }, allowPartial: true })
    expect(seen).toHaveLength(1)
    expect(partial.problems).toHaveLength(1)
    expect(partial.manifest.docs[0].transcribedBy).toBe('m')
  })
})
