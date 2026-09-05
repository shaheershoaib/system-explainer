import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSandbox, resolveInside, searchFallback, SandboxError, type Sandbox } from './tools'

let repo: string
let work: string
let outside: string
let sb: Sandbox

const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

beforeAll(() => {
  outside = mkdtempSync(path.join(tmpdir(), 'llm-outside-'))
  writeFileSync(path.join(outside, 'secret.txt'), 'top secret\n')
  repo = mkdtempSync(path.join(tmpdir(), 'llm-repo-'))
  work = mkdtempSync(path.join(tmpdir(), 'llm-work-'))
  writeFileSync(path.join(repo, 'README.md'), '# Demo\n\nhello world\n')
  mkdirSync(path.join(repo, 'src'))
  writeFileSync(path.join(repo, 'src/a.ts'), "export const greet = () => 'hello'\nexport const other = 1\nconst weird = 'a.b('\n")
  mkdirSync(path.join(repo, 'sub/nested'), { recursive: true })
  writeFileSync(path.join(repo, 'sub/b.txt'), 'hello from b\n')
  writeFileSync(path.join(repo, 'sub/nested/c.md'), 'hello from c\n')
  writeFileSync(path.join(repo, 'bin.dat'), Buffer.concat([Buffer.from('hello binary'), Buffer.from([0, 1, 2, 3])]))
  mkdirSync(path.join(repo, 'node_modules/pkg'), { recursive: true })
  writeFileSync(path.join(repo, 'node_modules/pkg/index.js'), 'hello from node_modules\n')
  writeFileSync(path.join(repo, 'many.txt'), Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n')
  writeFileSync(path.join(repo, 'repeat.txt'), Array.from({ length: 60 }, () => 'hello again').join('\n') + '\n')
  symlinkSync(path.join(outside, 'secret.txt'), path.join(repo, 'escape'))
  git('init', '-q')
  git('add', '-A')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initial commit')
  sb = createSandbox({ repoDir: repo, workDir: work, maxReadLines: 10, maxSearchHits: 3 })
})

afterAll(() => {
  for (const d of [repo, work, outside]) rmSync(d, { recursive: true, force: true })
})

describe('definitions', () => {
  it('exposes the six tools as strict, closed schemas', () => {
    expect(sb.definitions.map((t) => t.name)).toEqual(['list_dir', 'read_file', 'search', 'git_log', 'git_show', 'write_file'])
    for (const t of sb.definitions) {
      expect(t.strict).toBe(true)
      expect(t.input_schema.additionalProperties).toBe(false)
      expect(t.input_schema.type).toBe('object')
    }
  })
})

describe('resolveInside', () => {
  it('accepts paths that stay inside the root, including normalized ".." segments', () => {
    expect(resolveInside(repo, 'sub/../README.md')).toBe(path.join(repo, 'README.md'))
    expect(resolveInside(repo, '.')).toBe(repo)
    expect(resolveInside(repo, 'does/not/exist/yet.txt')).toBe(path.join(repo, 'does/not/exist/yet.txt'))
  })
  it('throws SandboxError for absolute paths, .. escapes, and symlinks that realpath outside', () => {
    expect(() => resolveInside(repo, '/etc/passwd')).toThrow(SandboxError)
    expect(() => resolveInside(repo, '../etc/passwd')).toThrow(SandboxError)
    expect(() => resolveInside(repo, 'sub/../../x')).toThrow(SandboxError)
    expect(() => resolveInside(repo, 'escape')).toThrow(SandboxError)
  })
})

describe('list_dir', () => {
  it('lists the root sorted, marks directories, skips node_modules', async () => {
    const out = await sb.execute('list_dir', {})
    expect(out.is_error).toBeUndefined()
    const lines = out.content.split('\n')
    expect(lines).toEqual([...lines].sort())
    expect(lines).toContain('README.md')
    expect(lines).toContain('src/')
    expect(lines).toContain('sub/')
    expect(lines).not.toContain('node_modules/')
  })
  it('lists a subdirectory with repo-relative entries', async () => {
    const out = await sb.execute('list_dir', { path: 'sub' })
    expect(out.content.split('\n')).toEqual(['sub/b.txt', 'sub/nested/'])
  })
  it('reports a missing directory as an error', async () => {
    const out = await sb.execute('list_dir', { path: 'nope' })
    expect(out.is_error).toBe(true)
    expect(out.content).toMatch(/no such file or directory: nope/)
  })
})

describe('read_file', () => {
  it('returns 1-based numbered lines', async () => {
    const out = await sb.execute('read_file', { path: 'src/a.ts' })
    expect(out.is_error).toBeUndefined()
    expect(out.content.split('\n')).toEqual(["1\texport const greet = () => 'hello'", '2\texport const other = 1', "3\tconst weird = 'a.b('"])
  })
  it('honors an inclusive line range', async () => {
    const out = await sb.execute('read_file', { path: 'many.txt', start_line: 5, end_line: 7 })
    expect(out.content.split('\n')).toEqual(['5\tline 5', '6\tline 6', '7\tline 7'])
  })
  it('truncates at maxReadLines with a note that says how much is left', async () => {
    const out = await sb.execute('read_file', { path: 'many.txt' })
    const lines = out.content.split('\n')
    expect(lines).toHaveLength(11)
    expect(lines[9]).toBe('10\tline 10')
    expect(lines[10]).toBe('... (truncated; 990 more lines; request a range)')
  })
  it('truncates at maxReadBytes too', async () => {
    const small = createSandbox({ repoDir: repo, workDir: work, maxReadBytes: 40 })
    const out = await small.execute('read_file', { path: 'many.txt' })
    const lines = out.content.split('\n')
    expect(lines.length).toBeLessThan(10)
    expect(lines.at(-1)).toMatch(/^\.\.\. \(truncated; \d+ more lines; request a range\)$/)
  })
  it('refuses binary files', async () => {
    const out = await sb.execute('read_file', { path: 'bin.dat' })
    expect(out.is_error).toBe(true)
    expect(out.content).toMatch(/binary file/)
  })
  it('refuses .. escapes, absolute paths, and symlinks pointing outside the repo', async () => {
    for (const p of ['../etc/passwd', '/etc/passwd', 'escape']) {
      const out = await sb.execute('read_file', { path: p })
      expect(out.is_error, p).toBe(true)
      expect(out.content, p).not.toContain('top secret')
    }
  })
})

describe('search', () => {
  const sorted = (s: string) => s.split('\n').sort()

  it('returns path:line: text hits, skipping node_modules, binaries and symlinks', async () => {
    const wide = createSandbox({ repoDir: repo, workDir: work })
    const out = await wide.execute('search', { pattern: 'hello', glob: '!repeat.txt' })
    expect(out.is_error).toBeUndefined()
    expect(sorted(out.content)).toEqual(['README.md:3: hello world', "src/a.ts:1: export const greet = () => 'hello'", 'sub/b.txt:1: hello from b', 'sub/nested/c.md:1: hello from c'])
  })
  it('restricts hits with a glob', async () => {
    const out = await sb.execute('search', { pattern: 'hello', glob: '*.md' })
    expect(sorted(out.content)).toEqual(['README.md:3: hello world', 'sub/nested/c.md:1: hello from c'])
  })
  it('treats the pattern literally with fixed_strings', async () => {
    const out = await sb.execute('search', { pattern: 'a.b(', fixed_strings: true })
    expect(out.content).toBe("src/a.ts:3: const weird = 'a.b('")
    const bad = await sb.execute('search', { pattern: 'a.b(' })
    expect(bad.is_error).toBe(true)
  })
  it('caps the hit list at maxSearchHits with a note', async () => {
    const out = await sb.execute('search', { pattern: 'hello again' })
    const lines = out.content.split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[3]).toBe('... (truncated; 47 more hits; narrow the pattern or add a glob)')
  })
  it('reports no matches without an error', async () => {
    const out = await sb.execute('search', { pattern: 'definitely_not_here_xyz' })
    expect(out).toEqual({ content: '(no matches)' })
  })
  it('searchFallback: same hits, 50 per file, glob and literal modes', async () => {
    const hits = await searchFallback(repo, 'hello')
    expect(hits.map((h) => `${h.path}:${h.line}`)).toEqual(['README.md:3', 'repeat.txt:1', ...Array.from({ length: 49 }, (_, i) => `repeat.txt:${i + 2}`), 'src/a.ts:1', 'sub/b.txt:1', 'sub/nested/c.md:1'])
    expect(hits.find((h) => h.path === 'README.md')).toEqual({ path: 'README.md', line: 3, text: 'hello world' })
    expect(await searchFallback(repo, 'hello', { glob: 'sub/**/*.md' })).toEqual([{ path: 'sub/nested/c.md', line: 1, text: 'hello from c' }])
    expect(await searchFallback(repo, 'hello', { glob: '*.{txt,md}' })).toHaveLength(53)
    expect((await searchFallback(repo, 'hello', { glob: '!*.txt' })).map((h) => h.path)).toEqual(['README.md', 'src/a.ts', 'sub/nested/c.md'])
    expect(await searchFallback(repo, 'a.b(', { fixedStrings: true })).toHaveLength(1)
    await expect(searchFallback(repo, 'a.b(')).rejects.toThrow(SandboxError)
  })
})

describe('git tools', () => {
  it('git_log lists commits, optionally for one path', async () => {
    const out = await sb.execute('git_log', {})
    expect(out.is_error).toBeUndefined()
    expect(out.content).toMatch(/^[0-9a-f]{7,} \d{4}-\d{2}-\d{2} Test initial commit$/)
    const scoped = await sb.execute('git_log', { path: 'README.md', max: 5 })
    expect(scoped.content).toMatch(/initial commit/)
    const none = await sb.execute('git_log', { path: 'src' })
    expect(none.content).toMatch(/initial commit/)
  })
  it('git_show shows a commit and can be limited to a path', async () => {
    const out = await sb.execute('git_show', { ref: 'HEAD', max_lines: 5000 })
    expect(out.is_error).toBeUndefined()
    expect(out.content).toMatch(/initial commit/)
    expect(out.content).toMatch(/diff --git a\/src\/a\.ts/)
    const scoped = await sb.execute('git_show', { ref: 'HEAD', path: 'README.md', max_lines: 5000 })
    expect(scoped.content).toMatch(/diff --git a\/README\.md/)
    expect(scoped.content).not.toMatch(/diff --git a\/src/)
  })
  it('git_show caps its output', async () => {
    const out = await sb.execute('git_show', { ref: 'HEAD' })
    expect(out.content.split('\n')).toHaveLength(11)
    expect(out.content).toMatch(/\n\.\.\. \(truncated; \d+ more lines\)$/)
  })
  it('git_show refuses option-shaped and malformed refs', async () => {
    for (const ref of ['--upload-pack=x', '-p', 'HEAD;rm', 'a b']) {
      const out = await sb.execute('git_show', { ref })
      expect(out.is_error, ref).toBe(true)
      expect(out.content, ref).toMatch(/invalid ref/)
    }
  })
  it('git errors surface as tool errors, not exceptions', async () => {
    const out = await sb.execute('git_show', { ref: 'deadbeef' })
    expect(out.is_error).toBe(true)
    expect(out.content).toMatch(/git failed/)
  })
})

describe('write_file', () => {
  it('writes under workDir, creating parent directories', async () => {
    const out = await sb.execute('write_file', { path: 'drafts/m1.json', content: '{"a":1}' })
    expect(out).toEqual({ content: 'wrote drafts/m1.json (7 bytes)' })
    expect(readFileSync(path.join(work, 'drafts/m1.json'), 'utf8')).toBe('{"a":1}')
  })
  it('creates a workDir that does not exist yet', async () => {
    const fresh = path.join(work, 'later', 'deeper')
    const late = createSandbox({ repoDir: repo, workDir: fresh })
    const out = await late.execute('write_file', { path: 'x.txt', content: 'x' })
    expect(out.is_error).toBeUndefined()
    expect(existsSync(path.join(fresh, 'x.txt'))).toBe(true)
  })
  it('refuses to write outside workDir', async () => {
    const escape = path.join(work, '..', 'llm-escaped.txt')
    for (const p of ['../llm-escaped.txt', escape, path.join(repo, 'pwned.txt')]) {
      const out = await sb.execute('write_file', { path: p, content: 'x' })
      expect(out.is_error, p).toBe(true)
    }
    expect(existsSync(escape)).toBe(false)
    expect(existsSync(path.join(repo, 'pwned.txt'))).toBe(false)
  })
})

describe('execute', () => {
  it('rejects unknown tools and malformed input without throwing', async () => {
    expect(await sb.execute('teleport', {})).toEqual({ content: 'unknown tool: teleport', is_error: true })
    const missing = await sb.execute('read_file', {})
    expect(missing.is_error).toBe(true)
    expect(missing.content).toMatch(/invalid input: path/)
    const wrongType = await sb.execute('read_file', { path: 'README.md', start_line: 'one' })
    expect(wrongType.is_error).toBe(true)
    expect(wrongType.content).toMatch(/start_line/)
    const extra = await sb.execute('list_dir', { path: '.', recursive: true })
    expect(extra.is_error).toBe(true)
    expect(await sb.execute('list_dir', null)).toMatchObject({ is_error: true })
  })
})
