import { describe, it, expect, afterAll, vi } from 'vitest'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type Anthropic from '@anthropic-ai/sdk'
import { assemble, AssembleError } from './assemble-bundle'
import { runCourse, type CourseOptions } from './course'
import { createFakeCoursePlayer, roleOf } from './fake-course-roles'
import { createFakeClient, type FakeStep } from './llm/fake'
import { validateBundle } from './validate'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.resolve(here, '..', 'fixtures', 'mini-repo')
const tmp: string[] = []
const scratch = (label: string) => {
  const d = mkdtempSync(path.join(tmpdir(), `course-${label}-`))
  tmp.push(d)
  return d
}
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true })
})

/** A copy of the fixture, so the disk-bus writes (.system-explainer/) stay out of the repo. */
function freshRepo(): string {
  const repo = scratch('repo')
  cpSync(fixture, repo, { recursive: true })
  return repo
}
/** A minimal engine dir for assemble to write into. */
function engineDir(): string {
  const root = scratch('engine')
  mkdirSync(path.join(root, 'bundles'))
  mkdirSync(path.join(root, 'public'))
  return root
}
type Script = Parameters<typeof createFakeClient>[0]
const options = (repo: string, root: string, script: Script): CourseOptions => ({
  client: createFakeClient(script),
  model: 'claude-opus-5',
  repoPath: repo,
  systemName: 'tinystore',
  root,
})
const readBundle = (p: string) => JSON.parse(readFileSync(p, 'utf8'))

describe('runCourse (offline, fake model)', () => {
  it('courses the fixture repo end to end: one grounded module per source file, a validated bundle, usage and cost', async () => {
    const repo = freshRepo()
    const root = engineDir()
    const events: { type: string; label: string }[] = []
    const res = await runCourse({ ...options(repo, root, createFakeCoursePlayer(repo)), onEvent: (e) => events.push(e) })

    expect(res.modules).toEqual(['events', 'index', 'store'])
    expect(res.workDir).toBe(path.join(repo, '.system-explainer', 'auto-course', 'tinystore'))
    for (const f of ['plan.json', 'datamodel.json', 'drafts/events.json', 'drafts/store.json', 'modules/events.json', 'modules/index.json', 'modules/store.json'])
      expect(existsSync(path.join(res.workDir, f)), f).toBe(true)
    const plan = JSON.parse(readFileSync(path.join(res.workDir, 'plan.json'), 'utf8'))
    expect(plan).toMatchObject({ systemName: 'tinystore', audience: 'developer', depth: 'L3', repoUrl: null })
    expect(plan.domains.map((d: { id: string }) => d.id)).toEqual(['events', 'index', 'store'])

    expect(res.bundlePath).toBe(path.join(root, 'bundles', 'tinystore', 'bundle.json'))
    const bundle = readBundle(res.bundlePath)
    expect(validateBundle(bundle).ok).toBe(true)
    expect(bundle.system).toMatchObject({ id: 'tinystore', audience: 'developer', depth: 'L3' })
    expect(bundle.modules.map((m: { id: string }) => m.id)).toEqual(res.modules)
    expect(readBundle(path.join(root, 'public', 'bundle.json')).system.id).toBe('tinystore')

    // the fake copies verbatim runs, so the real grounding gate marks every snippet verified and exact
    expect(res.grounding).toBeDefined()
    expect(res.grounding!.total).toBe(3)
    expect(res.grounding!.verified).toBe(res.grounding!.total)
    expect(res.grounding!.exact).toBeGreaterThanOrEqual(1)
    expect(res.grounding!.drifted + res.grounding!.missingFile).toBe(0)
    expect(bundle.provenance.grounding).toMatchObject({ total: 3, verified: 3 })
    expect(res.dataModelEntities).toBeGreaterThanOrEqual(2)
    expect(res.dataModelEntities).toBeLessThanOrEqual(4)

    // one agent per role instance; the author+verify pairs ran concurrently, so compare as a set
    const labels = res.agents.map((a) => a.label)
    expect(labels[0]).toBe('enumerate')
    expect(labels[1]).toBe('data-model')
    expect(labels.at(-1)).toBe('completeness:r1')
    expect([...labels].sort()).toEqual(['author:events', 'author:index', 'author:store', 'completeness:r1', 'data-model', 'enumerate', 'verify:events', 'verify:index', 'verify:store'])
    expect(res.agents.every((a) => a.stopReason === 'submitted')).toBe(true)
    expect(res.agents.every((a) => a.turns >= 1)).toBe(true)

    expect(res.usage.input_tokens).toBeGreaterThan(0)
    expect(res.usage.input_tokens).toBe(res.agents.reduce((n, a) => n + a.usage.input_tokens, 0))
    expect(typeof res.estimatedCostUsd).toBe('number')
    expect(res.estimatedCostUsd).toBeGreaterThan(0)
    expect(res.seconds).toBeGreaterThanOrEqual(0)
    expect(events.filter((e) => e.type === 'phase').map((e) => e.label)).toEqual(['Enumerate', 'Data model', 'Author + verify', 'Completeness', 'Assemble'])
  })

  it('drops a domain whose author never submits, records both attempts, and still assembles the rest', async () => {
    const repo = freshRepo()
    const root = engineDir()
    const base = createFakeCoursePlayer(repo)
    const stubborn = (i: number, p: Anthropic.MessageCreateParamsNonStreaming): FakeStep =>
      roleOf(p) === 'author' && String(p.messages[0].content).includes('MODULE ID: store') ? { text: 'Still reading, one moment.' } : base(i, p)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const res = await runCourse(options(repo, root, stubborn))
      expect(res.modules).toEqual(['events', 'index'])
      expect(existsSync(path.join(res.workDir, 'modules', 'store.json'))).toBe(false)
      expect(validateBundle(readBundle(res.bundlePath)).ok).toBe(true)

      const failed = res.agents.filter((a) => a.stopReason !== 'submitted')
      expect(failed.map((a) => a.label)).toEqual(['author:store', 'author:store (retry)'])
      expect(failed.map((a) => a.stopReason)).toEqual(['ended_without_submit', 'ended_without_submit'])
      expect(res.agents.some((a) => a.label === 'verify:store')).toBe(false)
      expect(res.usage.input_tokens).toBe(res.agents.reduce((n, a) => n + a.usage.input_tokens, 0))
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/dropping domain "store"/))
    } finally {
      warn.mockRestore()
    }
  })

  it('unknown model: usage is still summed but the cost estimate is null', async () => {
    const repo = freshRepo()
    const res = await runCourse({ ...options(repo, engineDir(), createFakeCoursePlayer(repo)), model: 'not-a-priced-model', concurrency: 1 })
    expect(res.modules).toHaveLength(3)
    expect(res.usage.output_tokens).toBeGreaterThan(0)
    expect(res.estimatedCostUsd).toBeNull()
  })
})

describe('assemble (the back half as a function)', () => {
  function workDir(): string {
    const dir = scratch('work')
    mkdirSync(path.join(dir, 'modules'))
    writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ systemName: 'Demo', oneLiner: 'demo', elevatorPitch: 'pitch', outOfScope: [], audience: 'developer', depth: 'L3', repoUrl: null, domains: [{ id: 'a' }] }))
    writeFileSync(path.join(dir, 'modules', 'a.json'), JSON.stringify({ id: 'a', title: 'A', objective: 'o', concepts: [], lessons: [{ title: 'L', prose: 'p' }], quiz: [] }))
    return dir
  }
  it('returns the validated bundle and where it was written', () => {
    const root = engineDir()
    const res = assemble({ dir: workDir(), system: 'demo', root })
    expect(res.outPath).toBe(path.join(root, 'bundles', 'demo', 'bundle.json'))
    expect(res.grounding).toBeUndefined()
    expect(res.bundle.modules.map((m) => m.id)).toEqual(['a'])
    expect(validateBundle(readBundle(res.outPath)).ok).toBe(true)
    expect(existsSync(path.join(root, 'public', 'bundle.json'))).toBe(true)
  })
  it('throws an AssembleError instead of exiting when the repo does not exist', () => {
    const dir = workDir()
    const call = () => assemble({ dir, system: 'demo', repo: path.join(dir, 'nope'), root: engineDir() })
    expect(call).toThrow(AssembleError)
    expect(call).toThrow(/--repo not found/)
  })
})
