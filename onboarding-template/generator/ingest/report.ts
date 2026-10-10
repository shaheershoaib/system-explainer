/**
 * The loud part: the problem block printed before anything is generated, the `sources` catalog,
 * and the fixed fix-texts for FORMAT-level problems (a tool missing on this machine, a format with
 * no parser). Fixes for anything else are written by the access agent for the specific source;
 * nothing here names a service.
 */
import type { SourceKind, SourceProblem } from './types'

const COPY_TEXT = 'Or copy the text into a .md or .txt file and pass that file.'

export const FIX = {
  pdftotext: [
    'On macOS run: brew install poppler (it provides pdftotext), then retry.',
    'On Debian or Ubuntu run: sudo apt-get install poppler-utils, then retry.',
    'Or pass --transcribe to have Claude read the PDF (costs API tokens).',
    "Or copy the PDF's text into a .md or .txt file and pass that file.",
  ],
  scannedPdf: [
    'Pass --transcribe to have Claude read the scanned pages (costs API tokens).',
    'Or add a text layer with OCR (for example: brew install ocrmypdf, then ocrmypdf <file> <file>-ocr.pdf) and pass the new file.',
    COPY_TEXT,
  ],
  image: ['Pass --transcribe to have Claude read the image (costs API tokens).', "Or type the image's text into a .md file and pass that file."],
  spreadsheet: [
    'Export the sheet as CSV from the app that opens it (usually File -> Export or File -> Save As -> CSV) and pass the .csv file.',
  ],
  audioVideo: [
    "Pass the meeting's transcript instead: most meeting and video tools can export one as .vtt, .srt or .txt.",
    'Or, inside Claude Code, run /watch <file or url> to produce a transcript, save it into a folder, and pass that folder.',
  ],
  binary: ['Export it as PDF, Markdown or plain text and pass that file.'],
  unzip: [
    'Install unzip (macOS ships it; on Debian or Ubuntu run: sudo apt-get install unzip), then retry.',
    'Or export the document as PDF or plain text and pass that file.',
  ],
  tooLarge: ['Split it into smaller files, or export just the part you need as text, and pass those.'],
  transcribeFailed: ['Retry; if it keeps failing, export the text yourself into a .md file and pass that file.'],
  inFolder: 'Or remove it from the folder, or pass --allow-partial to build without it.',
  network: (host: string) => [
    `Check your network connection and that ${host} opens in a browser, then retry.`,
    'Or save the page as a file (PDF or HTML) from your browser and pass that file.',
  ],
  missingPath: (cwd: string) => [
    `Check the path for typos; relative paths are resolved against ${cwd}.`,
    'Run system-explainer sources to see every supported format and the form each source takes.',
  ],
  /** Generic, service-free fixes when the access agent is not available for this run. */
  access: [
    'Let system-explainer work out how to reach it: set ANTHROPIC_API_KEY so the access agent can reason about this source (or run with --fake for an offline dry run), then retry.',
    'Or export the content to a file (PDF, HTML, Markdown or plain text) and pass that file.',
    'Or, inside Claude Code, ask Claude to fetch it with whatever connector you have for it and save it as Markdown into a folder, then pass that folder.',
  ],
  gitRemote: (url: string) => [
    `Run git ls-remote ${url} in a terminal to see the error; configure git credentials or an SSH key for that host, then retry.`,
    'Or clone it yourself and pass the local path.',
  ],
  secondRepo: (raw: string) => [
    'Course each repository separately (one system-explainer course run per repository).',
    `Or pass only this repository's docs folder (for example ${raw.replace(/\/+$/, '')}/docs) instead of the whole repository.`,
  ],
  deferred: [
    'Fix the sources listed above and rerun.',
    'Or pass --allow-partial to build without the unreadable sources; this one is then read.',
  ],
  replay: 'Run system-explainer ingest (or course) again so the access agent can work out how to reach it afresh.',
}

export interface FormatOptions {
  /** --allow-partial: the course is built without them. */
  partial?: boolean
  /** How many sources were given, for "2 of 5". */
  total?: number
  /** True when a model was already called this run (the access agent), so "no API call was made" would be false. */
  usedApi?: boolean
}

/** The loud block printed when sources could not be read. */
export function formatProblems(problems: SourceProblem[], opts: FormatOptions = {}): string {
  if (!problems.length) return ''
  const n = problems.length
  const count = opts.total ? `${n} of ${opts.total} sources` : `${n} source${n === 1 ? '' : 's'}`
  const lead = `✗ ${count} could not be read.`
  const tail = opts.partial
    ? ` The course will be built WITHOUT ${n === 1 ? 'it' : 'them'}; ${n === 1 ? 'it' : 'they'} will be listed in the course and in the proof report.`
    : opts.usedApi
      ? ' Nothing was generated; the only API calls made were the access agent working out how to reach sources.'
      : ' Nothing was generated and no API call was made.'
  const out = [lead + tail, '']
  for (const p of problems) {
    out.push(`  ${p.kind} ${p.source}`)
    if (p.observed) out.push(`    seen ${p.observed}`)
    out.push(`    why  ${p.why}`)
    p.fixes.forEach((f, i) => {
      const text = p.fixes.length > 1 ? `${i + 1}. ${f}` : f
      out.push(`${i === 0 ? '    fix  ' : '         '}${text.replace(/\n/g, '\n           ')}`)
    })
    out.push('')
  }
  return out.join('\n')
}

export interface CatalogRow {
  kind: SourceKind
  label: string
  examples: string[]
  reachableNow: boolean
  status: string
  fixes: string[]
}

const CREDENTIAL_PARTS = new Set(['TOKEN', 'TOKENS', 'KEY', 'KEYS', 'APIKEY', 'SECRET', 'SECRETS', 'PASSWORD', 'PASSWD', 'PASS', 'AUTH', 'COOKIE', 'COOKIES', 'PAT', 'CREDENTIAL', 'CREDENTIALS', 'BEARER', 'JWT'])

/**
 * Whether an environment variable NAME looks like it holds a credential. Matched on whole name parts
 * (split on _ - .), never on substrings: a substring test offers PATH, MANPATH and every *PATH
 * variable to the access agent as a "credential" because they contain PAT.
 */
export function isCredentialName(name: string): boolean {
  const upper = name.toUpperCase()
  if (upper.endsWith('_SOCK')) return false // SSH_AUTH_SOCK and friends are socket paths
  return upper.split(/[_.-]+/).some((p) => CREDENTIAL_PARTS.has(p)) || /(?:TOKEN|APIKEY|SECRET|PASSWORD)$/.test(upper)
}

/** Names (never values) of environment variables that look like credentials, minus the model key. */
export function credentialNames(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .filter((k) => env[k] && isCredentialName(k) && k !== 'ANTHROPIC_API_KEY' && k !== 'ANTHROPIC_AUTH_TOKEN')
    .sort()
}

/** Backs `system-explainer sources`: one row per format, plus the access agent for everything else. */
export function sourceCatalog(env: Record<string, string | undefined>, which: (bin: string) => string | null): CatalogRow[] {
  const has = (bin: string) => which(bin) !== null
  const builtIn = (kind: SourceKind, label: string, examples: string[]): CatalogRow => ({ kind, label, examples, reachableNow: true, status: 'built in', fixes: [] })
  const unzipTool = has('unzip') ? 'unzip found' : has('tar') ? 'tar found (unzip not found)' : 'unzip and tar not found'
  const zipOk = has('unzip') || has('tar')
  const modelKey = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN)
  const creds = credentialNames(env)
  return [
    { kind: 'repo', label: 'Code repository (a directory with .git), read in place', examples: ['.', '../my-service'], reachableNow: true, status: 'built in', fixes: [] },
    builtIn('folder', 'Folder: every readable file inside, recursively', ['./docs', '~/meeting-notes']),
    builtIn('markdown', 'Markdown and plain text (.md .markdown .txt .rst .org .adoc)', ['notes.md', 'faq.txt']),
    builtIn('html', 'HTML page saved to disk (scripts, styles and comments are dropped)', ['guide.html']),
    builtIn('transcript', 'Meeting transcript (.vtt .srt)', ['2026-09-16-review.vtt']),
    builtIn('csv', 'CSV / TSV', ['export.csv']),
    builtIn('json', 'JSON', ['data.json']),
    builtIn('email', 'Email (.eml)', ['thread.eml']),
    {
      kind: 'word',
      label: 'Word document (.docx)',
      examples: ['roadmap.docx'],
      reachableNow: zipOk,
      status: unzipTool,
      fixes: zipOk ? [] : FIX.unzip,
    },
    { kind: 'slides', label: 'PowerPoint deck (.pptx), with speaker notes', examples: ['plan.pptx'], reachableNow: zipOk, status: unzipTool, fixes: zipOk ? [] : FIX.unzip },
    {
      kind: 'pdf',
      label: 'PDF with a text layer (scanned PDFs need --transcribe)',
      examples: ['handbook.pdf'],
      reachableNow: has('pdftotext'),
      status: has('pdftotext') ? 'pdftotext found' : 'pdftotext not found',
      fixes: has('pdftotext') ? [] : FIX.pdftotext,
    },
    { kind: 'image', label: 'Image (.png .jpg .gif .webp)', examples: ['whiteboard.png'], reachableNow: false, status: 'only with --transcribe (Claude reads it; costs API tokens)', fixes: FIX.image },
    { kind: 'spreadsheet', label: 'Spreadsheet (.xlsx .xls .numbers .ods)', examples: ['budget.xlsx'], reachableNow: false, status: 'no parser: export CSV', fixes: FIX.spreadsheet },
    { kind: 'audio-video', label: 'Audio or video recording', examples: ['meeting.mp4'], reachableNow: false, status: 'no transcriber: pass the transcript', fixes: FIX.audioVideo },
    {
      kind: 'git-remote',
      label: 'Any git remote (https or ssh) that git ls-remote accepts: shallow-cloned, then read as the repository',
      examples: ['https://git.example.com/team/app.git', 'git@git.example.com:team/app.git'],
      reachableNow: has('git'),
      status: has('git') ? 'git found' : 'git not found',
      fixes: has('git') ? [] : ['Install git (https://git-scm.com/downloads), then retry.'],
    },
    builtIn('web', 'Public web page or file URL: one GET, parsed by content type (HTML, text, Markdown, PDF, JSON)', ['https://example.com/handbook']),
    {
      kind: 'remote',
      label: 'Anything else: the access agent works out how to reach it from what you provide (a link, an id, a description)',
      examples: ['https://app.example.com/page/123', '"last week\'s planning notes"'],
      reachableNow: modelKey,
      status:
        (modelKey ? 'access agent available (ANTHROPIC_API_KEY set)' : 'needs ANTHROPIC_API_KEY (or --fake for an offline dry run)') +
        (creds.length ? `; credentials it may ask to use (each only with --grant ENV=host): ${creds.join(', ')}` : ''),
      fixes: modelKey ? [] : [FIX.access[0]],
    },
  ]
}
