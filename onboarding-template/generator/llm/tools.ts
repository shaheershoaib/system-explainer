/**
 * The sandbox: the read-only repo tools (list_dir, read_file, search, git_log, git_show) plus a
 * write_file confined to the work directory. Every path goes through resolveInside, every child
 * process gets an argument array (never a shell string), and execute() never throws - a failure
 * is a tool_result with is_error so the model can adapt.
 */
import type Anthropic from '@anthropic-ai/sdk'
import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'

const execFileP = promisify(execFile)

export interface SandboxOptions {
  repoDir: string
  workDir: string
  /** default 400 lines */
  maxReadLines?: number
  /** default 64 KiB */
  maxReadBytes?: number
  /** default 200 */
  maxSearchHits?: number
}
export interface ToolOutcome {
  content: string
  is_error?: boolean
}
export interface Sandbox {
  definitions: Anthropic.Tool[]
  execute(name: string, input: unknown): Promise<ToolOutcome>
}
export interface SearchHit {
  path: string
  line: number
  text: string
}
export interface SearchOptions {
  glob?: string
  fixedStrings?: boolean
}

export class SandboxError extends Error {}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next'])
/** ripgrep's --max-count; the JS fallback mirrors it so both paths report the same hits. */
const PER_FILE_MAX = 50
const MAX_SCAN_FILE_BYTES = 1024 * 1024
const EXEC_MAX_BUFFER = 16 * 1024 * 1024
const REF_OK = /^[0-9a-fA-F]{4,40}$|^[\w./-]{1,100}$/

/**
 * Resolve `rel` under `root`, refusing absolute paths, `..` escapes, and symlinks that realpath
 * outside root. Returns the absolute (lexical) path. Exported for tests.
 */
export function resolveInside(root: string, rel: string): string {
  if (path.isAbsolute(rel)) throw new SandboxError(`absolute paths are not allowed: ${rel}`)
  const rootAbs = path.resolve(root)
  const target = path.resolve(rootAbs, rel)
  if (!within(rootAbs, target)) throw new SandboxError(`path escapes the allowed directory: ${rel}`)
  // A symlink can point anywhere, so compare real paths too. The target may not exist yet (a
  // write_file destination), hence the deepest-existing-ancestor variant.
  if (!within(realish(rootAbs), realish(target))) throw new SandboxError(`path resolves outside the allowed directory: ${rel}`)
  return target
}

const within = (root: string, p: string) => p === root || p.startsWith(root + path.sep)

/** realpath of the deepest existing ancestor, with the not-yet-existing remainder re-appended. */
function realish(p: string): string {
  let dir = p
  const rest: string[] = []
  while (!existsSync(dir)) {
    const parent = path.dirname(dir)
    if (parent === dir) return p
    rest.unshift(path.basename(dir))
    dir = parent
  }
  return path.join(realpathSync(dir), ...rest)
}

const toPosix = (p: string) => p.split(path.sep).join('/')
const isBinary = (buf: Buffer) => buf.subarray(0, 8192).includes(0)

const IN = {
  list_dir: z.strictObject({ path: z.string().optional() }),
  read_file: z.strictObject({
    path: z.string(),
    start_line: z.number().int().min(1).optional(),
    end_line: z.number().int().min(1).optional(),
  }),
  search: z.strictObject({ pattern: z.string().min(1), glob: z.string().optional(), fixed_strings: z.boolean().optional() }),
  git_log: z.strictObject({ path: z.string().optional(), max: z.number().int().min(1).max(500).optional() }),
  git_show: z.strictObject({ ref: z.string(), path: z.string().optional(), max_lines: z.number().int().min(1).optional() }),
  write_file: z.strictObject({ path: z.string(), content: z.string() }),
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input)
  if (r.success) return r.data
  const issues = r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
  throw new SandboxError(`invalid input: ${issues.join('; ')}`)
}

type Props = Record<string, { type: 'string' | 'integer' | 'boolean'; description: string }>

// Strict tool schemas stay minimal on purpose: the API rejects numeric/string constraints under
// strict mode, so the finer validation (min 1, etc.) lives in the zod schemas above.
function tool(name: string, description: string, properties: Props, required: string[]): Anthropic.Tool {
  return { name, description, strict: true, input_schema: { type: 'object', properties, required, additionalProperties: false } }
}

const REPO_PATH = { type: 'string', description: 'Repo-relative path.' } as const

const DEFINITIONS: Anthropic.Tool[] = [
  tool(
    'list_dir',
    'List one directory of the repository: one entry per line, directories end with "/". Skips node_modules, .git, dist, build, coverage and .next.',
    { path: { type: 'string', description: 'Repo-relative directory; omit for the repository root.' } },
    [],
  ),
  tool(
    'read_file',
    'Read a text file from the repository as numbered lines "N<TAB>text" (1-based). Long files are truncated with a note; request a line range to read the rest.',
    {
      path: REPO_PATH,
      start_line: { type: 'integer', description: 'First line to return (1-based, inclusive).' },
      end_line: { type: 'integer', description: 'Last line to return (inclusive).' },
    },
    ['path'],
  ),
  tool(
    'search',
    'Search file contents with a regular expression (ripgrep syntax). Returns "path:line: text" hits, at most 50 per file.',
    {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts" or "src/**/*.py".' },
      fixed_strings: { type: 'boolean', description: 'Treat pattern as a literal string instead of a regex.' },
    },
    ['pattern'],
  ),
  tool(
    'git_log',
    'Recent commits (short sha, date, author, subject), newest first; optionally only those touching one path.',
    { path: REPO_PATH, max: { type: 'integer', description: 'Number of commits to return (default 20).' } },
    [],
  ),
  tool(
    'git_show',
    'Show one commit (message and diff) by sha or ref name, optionally restricted to one path.',
    {
      ref: { type: 'string', description: 'Commit sha (4-40 hex chars) or a ref name such as HEAD or main.' },
      path: REPO_PATH,
      max_lines: { type: 'integer', description: 'Cap on output lines (default 400).' },
    },
    ['ref'],
  ),
  tool(
    'write_file',
    'Write a file under the work directory, the only writable location. Parent directories are created; an existing file is overwritten.',
    {
      path: { type: 'string', description: 'Path relative to the work directory.' },
      content: { type: 'string', description: 'The full file content.' },
    },
    ['path', 'content'],
  ),
]

export function createSandbox(opts: SandboxOptions): Sandbox {
  const repoDir = path.resolve(opts.repoDir)
  const workDir = path.resolve(opts.workDir)
  const maxReadLines = opts.maxReadLines ?? 400
  const maxReadBytes = opts.maxReadBytes ?? 64 * 1024
  const maxSearchHits = opts.maxSearchHits ?? 200
  const repoRel = (abs: string) => toPosix(path.relative(repoDir, abs)) || '.'

  async function listDir(raw: unknown): Promise<string> {
    const { path: p = '.' } = parse(IN.list_dir, raw)
    const dir = resolveInside(repoDir, p)
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((e) => fsError(e, p))
    const base = repoRel(dir)
    const lines = entries
      .filter((e) => !(e.isDirectory() && SKIP_DIRS.has(e.name)))
      .map((e) => (base === '.' ? e.name : `${base}/${e.name}`) + (e.isDirectory() ? '/' : ''))
      .sort()
    return lines.length ? lines.join('\n') : '(empty directory)'
  }

  async function readFile(raw: unknown): Promise<string> {
    const { path: p, start_line, end_line } = parse(IN.read_file, raw)
    const buf = await fs.readFile(resolveInside(repoDir, p)).catch((e) => fsError(e, p))
    if (isBinary(buf)) throw new SandboxError(`binary file: ${p}`)
    const lines = buf.toString('utf8').split('\n')
    if (lines.at(-1) === '') lines.pop()
    if (!lines.length) return '(empty file)'
    const start = start_line ?? 1
    const end = Math.min(end_line ?? lines.length, lines.length)
    if (start > lines.length) throw new SandboxError(`start_line ${start} is past the end of the file (${lines.length} lines)`)
    if (end < start) throw new SandboxError(`end_line ${end} is before start_line ${start}`)
    return numbered(lines, start, end)
  }

  function numbered(lines: string[], start: number, end: number): string {
    const out: string[] = []
    let bytes = 0
    for (let i = start; i <= end; i++) {
      const text = lines[i - 1]
      const line = `${i}\t${text.length > maxReadBytes ? text.slice(0, maxReadBytes) + ' ...' : text}`
      const size = Buffer.byteLength(line) + 1
      if (out.length && (out.length >= maxReadLines || bytes + size > maxReadBytes)) {
        out.push(`... (truncated; ${end - i + 1} more lines; request a range)`)
        break
      }
      out.push(line)
      bytes += size
    }
    return out.join('\n')
  }

  async function search(raw: unknown): Promise<string> {
    const { pattern, glob, fixed_strings } = parse(IN.search, raw)
    const hits = (await rgSearch(pattern, glob, fixed_strings)) ?? (await searchFallback(repoDir, pattern, { glob, fixedStrings: fixed_strings }))
    if (!hits.length) return '(no matches)'
    const shown = hits.slice(0, maxSearchHits).map((h) => `${h.path}:${h.line}: ${h.text}`)
    if (hits.length > maxSearchHits) shown.push(`... (truncated; ${hits.length - maxSearchHits} more hits; narrow the pattern or add a glob)`)
    return shown.join('\n')
  }

  /** ripgrep, when installed. Returns null when it is not on PATH so the caller can fall back. */
  async function rgSearch(pattern: string, glob: string | undefined, fixed: boolean | undefined): Promise<SearchHit[] | null> {
    const args = ['--line-number', '--no-heading', '--color', 'never', '--max-count', String(PER_FILE_MAX)]
    args.push('--glob', `!{${[...SKIP_DIRS].join(',')}}`, '-e', pattern)
    if (glob) args.push('--glob', glob)
    if (fixed) args.push('-F')
    args.push('.')
    try {
      const { stdout } = await execFileP('rg', args, { cwd: repoDir, maxBuffer: EXEC_MAX_BUFFER, encoding: 'utf8' })
      return parseRg(stdout)
    } catch (err) {
      const e = err as Error & { code?: number | string; stdout?: string; stderr?: string }
      if (e.code === 'ENOENT') return null
      if (e.code === 1) return []
      // Exit 2 with output means some files were unreadable but the search itself ran.
      if (e.code === 2 && e.stdout) return parseRg(e.stdout)
      throw new SandboxError(`search failed: ${(e.stderr || e.message).trim()}`)
    }
  }

  async function git(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileP('git', ['-C', repoDir, ...args], { maxBuffer: EXEC_MAX_BUFFER, encoding: 'utf8' })
      return stdout
    } catch (err) {
      const e = err as Error & { stderr?: string }
      throw new SandboxError(`git failed: ${(e.stderr || e.message).trim()}`)
    }
  }

  async function gitLog(raw: unknown): Promise<string> {
    const { path: p, max = 20 } = parse(IN.git_log, raw)
    const args = ['log', '--no-color', '--date=short', '--format=%h %ad %an %s', '-n', String(max)]
    if (p) args.push('--', repoRel(resolveInside(repoDir, p)))
    return (await git(args)).trim() || '(no commits)'
  }

  async function gitShow(raw: unknown): Promise<string> {
    const { ref, path: p, max_lines = maxReadLines } = parse(IN.git_show, raw)
    // A leading "-" would let the model smuggle in an option such as --upload-pack=<cmd>.
    if (ref.startsWith('-') || !REF_OK.test(ref)) throw new SandboxError(`invalid ref: ${ref}`)
    const args = ['show', '--no-color', ref]
    if (p) args.push('--', repoRel(resolveInside(repoDir, p)))
    return capLines(await git(args), max_lines)
  }

  async function writeFile(raw: unknown): Promise<string> {
    const { path: p, content } = parse(IN.write_file, raw)
    const abs = resolveInside(workDir, p)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content)
    return `wrote ${toPosix(path.relative(workDir, abs))} (${Buffer.byteLength(content)} bytes)`
  }

  const handlers = new Map<string, (raw: unknown) => Promise<string>>([
    ['list_dir', listDir],
    ['read_file', readFile],
    ['search', search],
    ['git_log', gitLog],
    ['git_show', gitShow],
    ['write_file', writeFile],
  ])

  return {
    definitions: DEFINITIONS,
    async execute(name, input) {
      const run = handlers.get(name)
      if (!run) return { content: `unknown tool: ${name}`, is_error: true }
      try {
        return { content: await run(input) }
      } catch (err) {
        const message = err instanceof SandboxError ? err.message : `${name} failed: ${err instanceof Error ? err.message : String(err)}`
        return { content: message, is_error: true }
      }
    },
  }
}

function fsError(err: unknown, p: string): never {
  const code = (err as { code?: string }).code
  if (code === 'ENOENT') throw new SandboxError(`no such file or directory: ${p}`)
  if (code === 'EISDIR') throw new SandboxError(`is a directory: ${p}`)
  if (code === 'ENOTDIR') throw new SandboxError(`not a directory: ${p}`)
  throw err
}

function capLines(text: string, max: number): string {
  const lines = text.replace(/\n$/, '').split('\n')
  if (lines.length <= max) return lines.join('\n') || '(empty)'
  return [...lines.slice(0, max), `... (truncated; ${lines.length - max} more lines)`].join('\n')
}

const RG_LINE = /^(?:\.\/)?(.+?):(\d+):(.*)$/

function parseRg(stdout: string): SearchHit[] {
  const hits: SearchHit[] = []
  for (const line of stdout.split('\n')) {
    const m = RG_LINE.exec(line)
    if (m) hits.push({ path: m[1], line: Number(m[2]), text: m[3] })
  }
  return hits
}

/**
 * JS scan used when ripgrep is not installed: same skipped directories, files over 1 MiB and
 * binaries ignored, symlinks not followed, at most 50 hits per file. Exported for tests.
 */
export async function searchFallback(repoDir: string, pattern: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
  const matches = opts.fixedStrings ? (s: string) => s.includes(pattern) : regexMatcher(pattern)
  // ripgrep glob rules: a leading "!" excludes, and a glob without "/" matches the file name at any depth.
  const negate = opts.glob?.startsWith('!') ?? false
  const glob = negate ? opts.glob!.slice(1) : opts.glob
  const globRe = glob ? globToRegExp(glob) : null
  const globTarget = glob?.includes('/') ? (p: string) => p : path.posix.basename
  const hits: SearchHit[] = []
  for await (const rel of walk(path.resolve(repoDir))) {
    if (globRe && globRe.test(globTarget(rel)) === negate) continue
    const abs = path.join(repoDir, rel)
    if ((await fs.stat(abs)).size > MAX_SCAN_FILE_BYTES) continue
    const buf = await fs.readFile(abs)
    if (isBinary(buf)) continue
    let found = 0
    const lines = buf.toString('utf8').split('\n')
    for (let i = 0; i < lines.length && found < PER_FILE_MAX; i++) {
      if (!matches(lines[i])) continue
      hits.push({ path: rel, line: i + 1, text: lines[i] })
      found++
    }
  }
  return hits
}

function regexMatcher(pattern: string): (s: string) => boolean {
  try {
    const re = new RegExp(pattern)
    return (s) => re.test(s)
  } catch (err) {
    throw new SandboxError(`invalid regex: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function* walk(root: string, rel = ''): AsyncGenerator<string> {
  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true })
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(root, p)
    } else if (e.isFile()) yield p
  }
}

/** ripgrep-style glob: `*` and `?` stop at "/", `**` spans directories, `{a,b}` alternates. */
function globToRegExp(glob: string): RegExp {
  let re = ''
  let braces = 0
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/'
      re += slash ? '(?:.*/)?' : '.*'
      i += slash ? 2 : 1
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '{') {
      braces++
      re += '(?:'
    } else if (c === '}' && braces) {
      braces--
      re += ')'
    } else if (c === ',' && braces) re += '|'
    else re += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}
