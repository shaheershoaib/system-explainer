/**
 * The format layer for local files: each known format becomes markdown deterministically, with no
 * model. Child processes (pdftotext, unzip, tar) get argument arrays and absolute paths, so a file
 * named "-x" is never read as a flag; OOXML is parsed with regexes that never process a DOCTYPE or
 * an entity declaration (XXE-safe) and output is capped at 20 MB (zip bombs).
 */
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { kindForFile, knownExtension } from './detect'
import {
  attendeesLine,
  dayOf,
  firstHeading,
  leadingDate,
  readFrontMatter,
  SourceError,
  titleFromFileName,
  unique,
  type Draft,
} from './frontmatter'
import { FIX } from './report'
import { imageMediaType } from './transcribe'
import type { SourceKind, SourceProblem } from './types'

export const MAX_BYTES = 20 * 1024 * 1024
const MAX_FOLDER_FILES = 2000
const SKIP_DIRS = new Set(['node_modules', '.git', '.system-explainer'])

export interface LocalCtx {
  which: (bin: string) => string | null
  /** --transcribe was passed: images and text-less PDFs are queued for transcription instead of refused. */
  transcribe: boolean
  /**
   * A previous run's transcription of this file, when the file has not changed since: reused as is,
   * so a re-run (and reverify, which never calls a model) does not pay to read the same image twice.
   */
  reuse?: (abs: string) => Draft | null
}

/** A file whose text has to come from the model; transcribed after every free read succeeded. */
export interface PendingTranscription {
  abs: string
  kind: 'pdf' | 'image'
  meta: Omit<Draft, 'content'>
}

export type FileResult = { draft: Draft } | { pending: PendingTranscription }

// ── child processes ────────────────────────────────────────────────────────────────────────────

export interface RunResult {
  ok: boolean
  code: number | string | null
  stdout: Buffer
  stderr: string
  tooBig: boolean
}

export function run(bin: string, args: string[], opts: { timeout?: number; env?: NodeJS.ProcessEnv; maxBuffer?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { encoding: 'buffer', maxBuffer: opts.maxBuffer ?? MAX_BYTES, timeout: opts.timeout ?? 120_000, env: opts.env, windowsHide: true }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: number | string }) | null
      resolve({ ok: !e, code: e ? (e.code ?? null) : 0, stdout: stdout ?? Buffer.alloc(0), stderr: (stderr ?? Buffer.alloc(0)).toString('utf8'), tooBig: e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
    })
  })
}

const firstLine = (s: string) => s.trim().split('\n')[0]?.slice(0, 200) ?? ''

// ── text helpers ───────────────────────────────────────────────────────────────────────────────

/** UTF-8 text with no NUL byte in the first 8 KB, else null (a binary format). */
export function decodeText(buf: Buffer): string | null {
  const head = buf.subarray(0, 8192)
  if (head.includes(0)) return null
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true })
  } catch {
    return null
  }
  return buf.toString('utf8')
}

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '--', ndash: '-', hellip: '...',
  lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', copy: '(c)', reg: '(R)', trade: '(TM)', middot: '-', bull: '-',
}

function codePoint(n: number, literal: string): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : literal
}

/** HTML entities: the common named ones and numeric references, in one pass (no double decoding). */
export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') return codePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10), m)
    return NAMED[e.toLowerCase()] ?? m
  })
}

/** XML: the five standard entities and numeric references only. Custom entities stay literal. */
export function decodeXml(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, e: string) => {
    if (e[0] === '#') return codePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10), m)
    return NAMED[e]
  })
}

const stripDoctype = (xml: string) => xml.replace(/<!DOCTYPE[^[>]*(?:\[[\s\S]*?\])?\s*>/gi, '')

// ── HTML ───────────────────────────────────────────────────────────────────────────────────────

export interface HtmlText {
  title?: string
  text: string
  /** The page has <script> elements (a JavaScript-rendered page when the text is short). */
  scripts: boolean
  /** The page has a password field (a sign-in page). */
  passwordField: boolean
}

const DROP = /<(script|style|noscript|iframe|svg|template|head)\b[\s\S]*?(?:<\/\1\s*>|$)/gi
const BLOCK = /<\/?(?:p|div|section|article|header|footer|nav|main|aside|ul|ol|table|thead|tbody|tfoot|tr|blockquote|hr|dl|dt|dd|figure|figcaption|form|fieldset|address|details|summary|body|html)\b[^>]*>/gi

/** HTML -> markdown-ish text. Comments and script/style/noscript/iframe/svg/template are removed first: they are where instructions aimed at an AI hide. */
export function htmlToMarkdown(html: string): HtmlText {
  const scripts = /<script\b/i.test(html)
  const passwordField = /<input\b[^>]*type\s*=\s*["']?password/i.test(html)
  const plain = (s: string) => decodeHtmlEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
  const rawTitle = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  let s = html.replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(DROP, '')
  const pres: string[] = []
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_m, inner: string) => {
    pres.push('```\n' + decodeHtmlEntities(inner.replace(/<[^>]+>/g, '')).replace(/^\n|\n$/g, '') + '\n```')
    return `<div>\u0000${pres.length - 1}\u0000</div>`
  })
  s = s
    .replace(/\s+/g, ' ')
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, n: string, inner: string) => `\n\n${'#'.repeat(Number(n))} ${plain(inner)}\n\n`)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/li\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, ' | ')
    .replace(BLOCK, '\n')
    .replace(/<[^>]+>/g, '')
  s = decodeHtmlEntities(s)
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => pres[Number(i)])
    .trim()
  const title = (rawTitle && plain(rawTitle)) || firstHeading(s) || undefined
  return { title, text: s, scripts, passwordField }
}

// ── transcripts ────────────────────────────────────────────────────────────────────────────────

const TIMING = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->/

const hms = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds))
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':')
}

/** WebVTT / SRT -> one `[HH:MM:SS] Name: text` line per cue (no name when the cue has none). */
export function parseTranscript(text: string): { lines: string[]; speakers: string[] } {
  const lines: string[] = []
  const speakers: string[] = []
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)) {
    const rows = block.split('\n').map((l) => l.trim()).filter(Boolean)
    if (!rows.length || /^(?:WEBVTT|NOTE|STYLE|REGION)\b/.test(rows[0])) continue
    const at = rows.findIndex((r) => r.includes('-->'))
    const m = at >= 0 ? TIMING.exec(rows[at]) : null
    if (!m) continue
    const start = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3])
    let body = rows.slice(at + 1).join(' ')
    let name = /<v(?:\.[\w.-]+)?\s+([^>]+)>/.exec(body)?.[1].trim()
    body = decodeHtmlEntities(body.replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '')).replace(/\s+/g, ' ').trim()
    if (!name) {
      const said = /^([A-Z][A-Za-z0-9.'-]*(?: [A-Za-z0-9.'-]+){0,3}):\s+(.+)$/.exec(body)
      if (said) [name, body] = [said[1], said[2]]
    }
    if (!body) continue
    if (name) speakers.push(name)
    lines.push(`[${hms(start)}] ${name ? `${name}: ` : ''}${body}`)
  }
  return { lines, speakers: unique(speakers) }
}

// ── email ──────────────────────────────────────────────────────────────────────────────────────

function parseHeaders(block: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const m = /^([!-9;-~]+):[ \t]*(.*)$/.exec(line)
    if (m && !map.has(m[1].toLowerCase())) map.set(m[1].toLowerCase(), m[2].trim())
  }
  return map
}

function charsetDecode(bytes: Buffer, charset = 'utf-8'): string {
  try {
    return new TextDecoder(charset).decode(bytes)
  } catch {
    return bytes.toString('utf8')
  }
}

function quotedPrintable(s: string): Buffer {
  const t = s.replace(/=\r?\n/g, '')
  const out: number[] = []
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) {
      out.push(parseInt(t.slice(i + 1, i + 3), 16))
      i += 2
    } else out.push(t.charCodeAt(i) & 0xff)
  }
  return Buffer.from(out)
}

/** RFC 2047 encoded words (=?charset?B|Q?...?=) in a header value read as latin1. */
function decodeHeader(v: string): string {
  const raw = Buffer.from(v, 'latin1')
  const text = decodeText(raw) ?? v
  return text.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, cs: string, enc: string, data: string) =>
    charsetDecode(enc.toUpperCase() === 'B' ? Buffer.from(data, 'base64') : quotedPrintable(data.replace(/_/g, ' ')), cs),
  )
}

const param = (header: string | undefined, name: string) => new RegExp(`${name}\\s*=\\s*"?([^";]+)"?`, 'i').exec(header ?? '')?.[1]

function partText(headers: Map<string, string>, body: string): string {
  const cte = (headers.get('content-transfer-encoding') ?? '').toLowerCase()
  const bytes = cte === 'base64' ? Buffer.from(body.replace(/\s+/g, ''), 'base64') : cte === 'quoted-printable' ? quotedPrintable(body) : Buffer.from(body, 'latin1')
  return charsetDecode(bytes, param(headers.get('content-type'), 'charset'))
}

function splitPart(s: string): [Map<string, string>, string] {
  const i = s.search(/\r?\n\r?\n/)
  return i < 0 ? [parseHeaders(s), ''] : [parseHeaders(s.slice(0, i)), s.slice(i).replace(/^\r?\n\r?\n/, '')]
}

/** The first text/plain and text/html bodies of a (possibly nested multipart) message. */
function bodies(headers: Map<string, string>, body: string, depth = 0): { plain?: string; html?: string } {
  const type = (headers.get('content-type') ?? 'text/plain').toLowerCase()
  const boundary = param(headers.get('content-type'), 'boundary')
  if (type.startsWith('multipart/') && boundary && depth < 5) {
    const found: { plain?: string; html?: string } = {}
    const end = body.indexOf(`--${boundary}--`)
    for (const chunk of (end >= 0 ? body.slice(0, end) : body).split(`--${boundary}`).slice(1)) {
      const [h, b] = splitPart(chunk.replace(/^\r?\n/, ''))
      if (/attachment/i.test(h.get('content-disposition') ?? '')) continue
      const sub = bodies(h, b, depth + 1)
      found.plain ??= sub.plain
      found.html ??= sub.html
    }
    return found
  }
  if (type.startsWith('text/html')) return { html: partText(headers, body) }
  if (type.startsWith('text/')) return { plain: partText(headers, body) }
  return {}
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** The calendar day as written in a Date header (not shifted to UTC). */
function headerDay(v: string | undefined): string | undefined {
  const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/.exec(v ?? '')
  const month = m ? MONTHS.indexOf(m[2].toLowerCase()) : -1
  if (m && month >= 0) return leadingDate(`${m[3]}-${String(month + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`)
  const t = Date.parse(v ?? '')
  return Number.isNaN(t) ? undefined : dayOf(new Date(t))
}

const displayNames = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((a) => /^\s*"?([^"<]+?)"?\s*</.exec(a)?.[1].trim())
    .filter((n): n is string => Boolean(n))

export function parseEmail(raw: Buffer): { title?: string; date?: string; text: string; speakers: string[] } {
  const [headers, body] = splitPart(raw.toString('latin1'))
  const h = (k: string) => (headers.has(k) ? decodeHeader(headers.get(k)!) : undefined)
  const found = bodies(headers, body)
  const text = found.plain ?? (found.html ? htmlToMarkdown(found.html).text : '')
  const head = (['From', 'To', 'Date', 'Subject'] as const).filter((k) => h(k.toLowerCase())).map((k) => `${k}: ${h(k.toLowerCase())}`)
  return {
    title: h('subject'),
    date: headerDay(headers.get('date')),
    text: [...head, '', text.trim()].join('\n'),
    speakers: unique([...displayNames(h('from')), ...displayNames(h('to'))]),
  }
}

// ── OOXML (docx, pptx) ─────────────────────────────────────────────────────────────────────────

interface Zip {
  list(): Promise<string[]>
  member(name: string): Promise<string | null>
}

function openZip(abs: string, which: LocalCtx['which']): Zip {
  // unzip treats glob characters in the archive name as a pattern, so such paths go through tar.
  const unzip = /[*?[\]]/.test(abs) ? null : which('unzip')
  const tar = which('tar')
  if (!unzip && !tar) throw new SourceError('neither unzip nor tar is installed, so the document cannot be opened.', FIX.unzip, 'unzip and tar not on PATH')
  const failed = (r: RunResult): never => {
    if (r.tooBig) throw new SourceError('it expands to more than 20 MB of text, so it was not read (possibly a zip bomb).', FIX.tooLarge, 'over 20 MB when unzipped')
    throw new SourceError('it is not a valid Office file (the zip archive could not be opened).', FIX.binary, firstLine(r.stderr) || `exit ${r.code}`)
  }
  return {
    async list() {
      const r = unzip ? await run(unzip, ['-Z1', abs]) : await run(tar!, ['-tf', abs])
      return r.ok ? r.stdout.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean) : failed(r)
    },
    async member(name) {
      const r = unzip ? await run(unzip, ['-p', abs, name]) : await run(tar!, ['-xOf', abs, name])
      if (r.ok) return r.stdout.toString('utf8')
      if (r.code === 11 || /not found|no match/i.test(r.stderr)) return null
      return failed(r)
    },
  }
}

const coreProps = (xml: string | null) => ({
  title: decodeXml(/<dc:title>([\s\S]*?)<\/dc:title>/.exec(xml ?? '')?.[1] ?? '').trim() || undefined,
  date: leadingDate(/<dcterms:modified\b[^>]*>([^<]+)</.exec(xml ?? '')?.[1]),
})

/** word/document.xml -> markdown: paragraph per line, Heading1-6 / Title styles -> #, numbered paragraphs -> "- ". */
export function docxToMarkdown(xml: string): string {
  const blocks: { text: string; list: boolean }[] = []
  for (const p of stripDoctype(xml).match(/<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) ?? []) {
    const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(p)?.[1] ?? ''
    const level = /^Title$/i.test(style) ? 1 : Number(/^Heading([1-6])$/i.exec(style)?.[1] ?? 0)
    const list = /<w:numPr\b/.test(p)
    let text = ''
    for (const t of p.replace(/<w:pPr\b[\s\S]*?<\/w:pPr>/, '').matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab(?:\s[^>]*)?\/>|<w:(?:br|cr)(?:\s[^>]*)?\/>/g)) {
      text += t[1] !== undefined ? decodeXml(t[1]) : t[0].startsWith('<w:tab') ? '\t' : '\n'
    }
    if (!text.trim()) continue
    blocks.push({ text: level ? `${'#'.repeat(level)} ${text.trim()}` : list ? `- ${text.trim()}` : text, list: list && !level })
  }
  return blocks.map((b, i) => (i === 0 ? '' : b.list && blocks[i - 1].list ? '\n' : '\n\n') + b.text).join('')
}

/** DrawingML paragraphs (slides, notes) -> lines; slide-number fields are dropped. */
function drawingParagraphs(xml: string): string[] {
  const out: string[] = []
  for (const p of stripDoctype(xml).replace(/<a:fld\b[\s\S]*?<\/a:fld>/g, '').match(/<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/g) ?? []) {
    let text = ''
    for (const t of p.matchAll(/<a:t>([\s\S]*?)<\/a:t>|<a:br(?:\s[^>]*)?\/>/g)) text += t[1] !== undefined ? decodeXml(t[1]) : '\n'
    if (text.trim()) out.push(text.trim())
  }
  return out
}

async function readDocx(abs: string, which: LocalCtx['which']): Promise<{ title?: string; date?: string; text: string }> {
  const zip = openZip(abs, which)
  const doc = await zip.member('word/document.xml')
  if (doc === null) throw new SourceError('it has no word/document.xml, so it is not a Word document.', FIX.binary, 'word/document.xml missing')
  const core = coreProps(await zip.member('docProps/core.xml'))
  const text = docxToMarkdown(doc)
  return { title: core.title ?? firstHeading(text), date: core.date, text }
}

async function readPptx(abs: string, which: LocalCtx['which']): Promise<{ title?: string; date?: string; text: string }> {
  const zip = openZip(abs, which)
  const names = new Set(await zip.list())
  const slides = [...names]
    .map((n) => Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(n)?.[1]))
    .filter((n) => n > 0)
    .sort((a, b) => a - b)
    .slice(0, 500)
  if (!slides.length) throw new SourceError('it has no slides (no ppt/slides/slideN.xml), so it is not a PowerPoint deck.', FIX.binary, 'no slide parts')
  const parts: string[] = []
  let total = 0
  let firstLineOfDeck: string | undefined
  for (const n of slides) {
    const lines = drawingParagraphs((await zip.member(`ppt/slides/slide${n}.xml`)) ?? '')
    firstLineOfDeck ??= lines[0]
    // Slide N's notes part is named by the slide's relationships, not by N.
    const rels = await zip.member(`ppt/slides/_rels/slide${n}.xml.rels`)
    const notesN = /Target="\.\.\/notesSlides\/notesSlide(\d+)\.xml"/.exec(rels ?? '')?.[1]
    const notesName = notesN ? `ppt/notesSlides/notesSlide${notesN}.xml` : null
    const notes = notesName && names.has(notesName) ? drawingParagraphs((await zip.member(notesName)) ?? '') : []
    const part = [`## Slide ${n}`, '', ...lines, ...(notes.length ? ['', 'Speaker notes:', ...notes] : [])].join('\n')
    total += part.length
    if (total > MAX_BYTES) throw new SourceError('its slides hold more than 20 MB of text, so it was not read.', FIX.tooLarge, 'over 20 MB of slide text')
    parts.push(part)
  }
  const core = coreProps(await zip.member('docProps/core.xml'))
  return { title: core.title ?? firstLineOfDeck, date: core.date, text: parts.join('\n\n') }
}

// ── PDF ────────────────────────────────────────────────────────────────────────────────────────

/** Pages of text from pdftotext, or null when pdftotext is not installed. */
export async function pdfPages(abs: string, which: LocalCtx['which']): Promise<string[] | null> {
  const bin = which('pdftotext')
  if (!bin) return null
  const r = await run(bin, ['-layout', '-enc', 'UTF-8', abs, '-'])
  if (r.tooBig) throw new SourceError('its text is larger than 20 MB, so it was not read.', FIX.tooLarge, 'pdftotext output over 20 MB')
  if (!r.ok) {
    if (/password/i.test(r.stderr)) {
      throw new SourceError('the PDF is password-protected, so its text cannot be extracted.', ['Open it, print it to a new PDF without a password, and pass that file.'], firstLine(r.stderr))
    }
    throw new SourceError('pdftotext could not read it, so it is probably not a valid PDF.', FIX.binary, firstLine(r.stderr) || `pdftotext exit ${r.code}`)
  }
  const pages = r.stdout.toString('utf8').split('\f')
  if (pages.length > 1 && !pages.at(-1)!.trim()) pages.pop()
  return pages
}

/** Fewer than ~40 non-space characters per page: a scan with no usable text layer. */
export const hasTextLayer = (pages: string[]) => pages.join('').replace(/\s+/g, '').length >= 40 * Math.max(1, pages.length)

export const pagesToMarkdown = (pages: string[]) => pages.map((p, i) => `[page ${i + 1}]\n${p.replace(/^\n+|\s+$/g, '')}`).join('\n\n')

const PDF_MISSING = () => new SourceError("pdftotext is not installed, so the PDF's text cannot be extracted.", FIX.pdftotext, 'pdftotext not on PATH')

// ── one file ───────────────────────────────────────────────────────────────────────────────────

export async function readLocalFile(abs: string, kind: SourceKind, ctx: LocalCtx, name: string): Promise<FileResult> {
  const stat = await fs.stat(abs)
  const fileDay = leadingDate(path.basename(abs))
  const base = { kind, origin: abs, name, via: 'local file' }
  const meta = (title: string | undefined, date: string | undefined, speakers?: string[]) => ({
    ...base,
    title: title?.trim() || titleFromFileName(abs),
    date: date ?? fileDay ?? dayOf(stat.mtime),
    ...(speakers?.length ? { speakers } : {}),
  })
  const draft = (content: string, title?: string, date?: string, speakers?: string[]): FileResult => ({ draft: { ...meta(title, date, speakers), content } })
  const textOf = async () => {
    if (stat.size > MAX_BYTES) throw new SourceError('it is larger than 20 MB, so it was not read.', FIX.tooLarge, `${stat.size} bytes`)
    const text = decodeText(await fs.readFile(abs))
    if (text === null) throw new SourceError('it is an unsupported binary format (not UTF-8 text).', FIX.binary, knownExtension(abs) ? 'not UTF-8 text' : `unknown extension "${path.extname(abs) || '(none)'}" and not UTF-8 text`)
    return text
  }

  switch (kind) {
    case 'markdown': {
      const text = await textOf()
      const fm = readFrontMatter(text)
      return draft(text, fm.title ?? firstHeading(text), fm.date, attendeesLine(text))
    }
    case 'text':
    case 'csv':
      return draft(await textOf())
    case 'json': {
      const text = await textOf()
      let pretty = text.trim()
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2)
      } catch {
        // not valid JSON: kept verbatim inside the fence
      }
      return draft('```json\n' + pretty + '\n```')
    }
    case 'html': {
      const h = htmlToMarkdown(await textOf())
      return draft(h.text, h.title)
    }
    case 'transcript': {
      const t = parseTranscript(await textOf())
      if (!t.lines.length) throw new SourceError('no timed cues were found in it, so it is not a usable transcript.', FIX.binary, 'no "-->" cue lines')
      return draft(t.lines.join('\n'), undefined, undefined, t.speakers)
    }
    case 'email': {
      if (stat.size > MAX_BYTES) throw new SourceError('it is larger than 20 MB, so it was not read.', FIX.tooLarge, `${stat.size} bytes`)
      const e = parseEmail(await fs.readFile(abs))
      return draft(e.text, e.title, e.date, e.speakers)
    }
    case 'word': {
      const d = await readDocx(abs, ctx.which)
      return draft(d.text, d.title, d.date)
    }
    case 'slides': {
      const d = await readPptx(abs, ctx.which)
      return draft(d.text, d.title, d.date)
    }
    case 'pdf': {
      const pages = await pdfPages(abs, ctx.which)
      if (pages && hasTextLayer(pages)) return draft(pagesToMarkdown(pages))
      const keptPdf = ctx.reuse?.(abs)
      if (keptPdf) return { draft: keptPdf }
      if (ctx.transcribe) return { pending: { abs, kind: 'pdf', meta: meta(undefined, undefined) } }
      if (!pages) throw PDF_MISSING()
      const chars = pages.join('').replace(/\s+/g, '').length
      throw new SourceError('this PDF has no text layer (probably scanned), so there is no text to extract.', FIX.scannedPdf, `pdftotext found ${chars} characters on ${pages.length} page(s)`)
    }
    case 'image': {
      const head = Buffer.alloc(16)
      const handle = await fs.open(abs, 'r')
      await handle.read(head, 0, 16, 0).finally(() => handle.close())
      if (!imageMediaType(head)) throw new SourceError('it is not a PNG, JPEG, GIF or WebP image.', FIX.binary, 'unrecognized image header')
      const keptImage = ctx.reuse?.(abs)
      if (keptImage) return { draft: keptImage }
      if (ctx.transcribe) return { pending: { abs, kind: 'image', meta: meta(undefined, undefined) } }
      throw new SourceError('images are read only with --transcribe (Claude reads the image), which this run did not enable.', FIX.image, 'image file')
    }
    case 'spreadsheet':
      throw new SourceError('spreadsheets have no parser in the format layer.', FIX.spreadsheet, `${path.extname(abs)} file`)
    case 'audio-video':
      throw new SourceError('audio and video are not transcribed by the CLI.', FIX.audioVideo, `${path.extname(abs)} file`)
    default:
      throw new SourceError(`a ${kind} source is not a local file format.`, FIX.binary)
  }
}

// ── folders ────────────────────────────────────────────────────────────────────────────────────

async function* walk(root: string, rel = ''): AsyncGenerator<string> {
  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true })
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
    const p = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) yield* walk(root, p)
    else if (e.isFile()) yield p
    else if (e.isSymbolicLink() && (await fs.stat(path.join(root, p)).catch(() => null))?.isFile()) yield p
  }
}

/** Slug base for a file inside a folder: the relative path without its extension. */
const nameFor = (rel: string) => rel.replace(/\.[^./]+$/, '')

export async function readFolder(abs: string, ctx: LocalCtx): Promise<{ results: FileResult[]; problems: SourceProblem[] }> {
  const files: string[] = []
  for await (const rel of walk(abs)) {
    files.push(rel)
    if (files.length > MAX_FOLDER_FILES) {
      throw new SourceError(`the folder holds more than ${MAX_FOLDER_FILES} files, which is more than a course can use.`, ['Pass a narrower folder (the subfolder with the documents you want taught).'], `over ${MAX_FOLDER_FILES} files`)
    }
  }
  if (!files.length) throw new SourceError('the folder has no files to read (dot-files, node_modules and .git are skipped).', [`Check that ${abs} is the folder you meant, or pass the files directly.`], 'empty folder')
  const results: FileResult[] = []
  const problems: SourceProblem[] = []
  for (const rel of files) {
    const file = path.join(abs, rel)
    const kind = kindForFile(rel)
    try {
      results.push(await readLocalFile(file, kind, ctx, nameFor(rel)))
    } catch (err) {
      problems.push(fileProblem(file, kind, err))
    }
  }
  return { results, problems }
}

function fileProblem(file: string, kind: SourceKind, err: unknown): SourceProblem {
  if (err instanceof SourceError) return { source: file, kind, ...(err.observed ? { observed: err.observed } : {}), why: err.why, fixes: [...err.fixes, FIX.inFolder] }
  return { source: file, kind, why: `reading it failed unexpectedly (${err instanceof Error ? err.message : String(err)}).`, fixes: [...FIX.binary, FIX.inFolder] }
}
