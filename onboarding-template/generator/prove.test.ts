import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type Anthropic from '@anthropic-ai/sdk'
import { createFakeProofPlayer } from './fake-proof-roles'
import { createFakeClient } from './llm/fake'
import { collectCitedPaths } from './proof'
import { runProve, type ProveEvent } from './prove'

type Params = Anthropic.MessageCreateParamsNonStreaming

const here = path.dirname(fileURLToPath(import.meta.url))
const ZUSTAND_BUNDLE = path.resolve(here, '..', 'bundles', 'zustand', 'bundle.json')
const BUNDLE_REL = 'bundles/zustand/bundle.json'

const tmp: string[] = []
const scratch = (label: string) => {
  const d = mkdtempSync(path.join(tmpdir(), `prove-${label}-`))
  tmp.push(d)
  return d
}
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true })
})

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'))

/** A temp engine root holding a copy of the real zustand bundle (4 validated modules with cited paths), optionally edited. */
function engineRoot(edit?: (bundle: any) => void): string {
  const root = scratch('root')
  const bundle = readJson(ZUSTAND_BUNDLE)
  edit?.(bundle)
  mkdirSync(path.join(root, 'bundles', 'zustand'), { recursive: true })
  writeFileSync(path.join(root, BUNDLE_REL), JSON.stringify(bundle))
  return root
}

/** Empty placeholder files at every path the bundle cites: the fake skeptic only needs them to exist. */
function placeholderRepo(bundle: any): string {
  const repo = scratch('repo')
  for (const m of bundle.modules)
    for (const p of collectCitedPaths(m, bundle.traces)) {
      mkdirSync(path.dirname(path.join(repo, p)), { recursive: true })
      writeFileSync(path.join(repo, p), '')
    }
  return repo
}

const systemOf = (p: Params) => String(p.system)
const userOf = (p: Params) => String(p.messages[0].content)
const toolNames = (p: Params) => ((p.tools ?? []) as Anthropic.Tool[]).map((t) => t.name)

describe('runProve', () => {
  it('drives skeptic, quizgen and both learners per module through the fake client and renders the report', async () => {
    const root = engineRoot()
    const repoPath = placeholderRepo(readJson(ZUSTAND_BUNDLE))
    const modules = ['vanilla-store', 'react-binding']
    const seen: Params[] = []
    const events: ProveEvent[] = []
    const player = createFakeProofPlayer()
    const client = createFakeClient((i, params) => {
      seen.push(params)
      return player(i, params)
    })

    const res = await runProve({ client, model: 'claude-sonnet-4-6', system: 'zustand', bundlePath: BUNDLE_REL, repoPath, root, modules, onEvent: (e) => events.push(e) })
    const run = path.join(root, 'proof-runs', 'zustand')

    expect(res.skipped).toBeUndefined()
    expect(res.modules).toEqual(modules)
    for (const id of modules) {
      const input = readJson(path.join(run, 'inputs', `${id}.claims.json`))
      const adv = readJson(path.join(run, 'adversarial', `${id}.json`))
      expect(adv.moduleId).toBe(id)
      expect(adv.claims.length).toBeGreaterThan(0)
      expect(adv.claims).toHaveLength(input.claims.length)
      expect(adv.claims.every((c: any) => c.verdict === 'supported')).toBe(true)
      expect(adv.claims[0].evidence).toContain(input.citedPaths[0])

      expect(readJson(path.join(run, 'genraw', `${id}.json`)).items).toHaveLength(5)
      const quiz = readJson(path.join(run, 'genquiz', `${id}.quiz.json`))
      const itemIds = quiz.quiz.map((q: any) => q.id)
      expect(itemIds).toEqual(['g1', 'g2', 'g3', 'g4', 'g5'])
      const taught = readJson(path.join(run, 'learner-gen', `${id}.json`))
      const cold = readJson(path.join(run, 'learner-gen-cold', `${id}.json`))
      expect(taught).toMatchObject({ moduleId: id, mode: 'taught' })
      expect(cold).toMatchObject({ moduleId: id, mode: 'cold' })
      expect(taught.answers.map((a: any) => a.id)).toEqual(itemIds)
      expect(cold.answers.map((a: any) => a.id)).toEqual(itemIds)
    }

    expect(res.reportPath).toBe(path.join(run, 'PROOF_REPORT.md'))
    const md = readFileSync(res.reportPath!, 'utf8')
    expect(md).toContain('## Layer 2')
    expect(md).toContain('modules covered: 2/4')
    expect(res.adversarial).toMatchObject({ refuted: 0, unverifiable: 0 })
    expect(res.adversarial!.supported).toBe(res.adversarial!.total)
    expect(res.effectiveness).toEqual({ taughtOverall: expect.any(Number), coldOverall: expect.any(Number) })
    // every learner covered every item, so the report excluded no run as invalid
    expect(readJson(path.join(run, 'proof-report.json')).effectiveness.invalidRuns).toEqual([])

    expect(res.agents).toHaveLength(8)
    expect(res.agents.map((a) => a.label).sort()).toEqual(modules.flatMap((id) => [`verify:${id}`, `quizgen:${id}`, `learn:taught:${id}`, `learn:cold:${id}`]).sort())
    expect(res.agents.every((a) => a.stopReason === 'submitted')).toBe(true)
    expect(res.usage.input_tokens).toBeGreaterThan(0)
    expect(res.usage.input_tokens).toBe(res.agents.reduce((n, a) => n + a.usage.input_tokens, 0))
    expect(res.estimatedCostUsd).toBeGreaterThan(0)
    expect(res.seconds).toBeGreaterThanOrEqual(0)

    // wiring: every system prompt leads with ROLE:, the skeptics read a real file through the repo
    // sandbox, the learners had no tools at all, and only the taught learner saw the lesson
    expect(seen.every((p) => systemOf(p).startsWith('ROLE: '))).toBe(true)
    const byRole = (role: string) => seen.filter((p) => systemOf(p).startsWith(`ROLE: ${role}\n`))
    expect(byRole('skeptic').every((p) => toolNames(p).includes('read_file'))).toBe(true)
    const reads = events.filter((e) => e.type === 'tool')
    expect(reads).toHaveLength(2)
    expect(reads.every((e) => e.label === 'read_file' && !e.detail?.includes('error'))).toBe(true)
    expect(byRole('learner-taught')).toHaveLength(2)
    expect(byRole('learner-taught').every((p) => toolNames(p).join() === 'submit_result' && userOf(p).includes('<lesson>'))).toBe(true)
    expect(byRole('learner-cold')).toHaveLength(2)
    expect(byRole('learner-cold').every((p) => toolNames(p).join() === 'submit_result' && !userOf(p).includes('<lesson>'))).toBe(true)
    expect(events.filter((e) => e.type === 'phase').map((e) => e.label)).toEqual(['Prep', 'Verify-true', 'Quizgen', 'Effective', 'Report'])
  })

  it('with affected: true and no cited file changed since the pinned sha, returns nothing-affected without an agent or a run dir', async () => {
    const repoPath = scratch('git')
    const git = (...args: string[]) => execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    writeFileSync(path.join(repoPath, 'README.md'), '# fixture\n')
    git('init', '-q')
    git('add', '-A')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initial')
    const sha = git('rev-parse', 'HEAD').trim()
    const root = engineRoot((b) => {
      b.provenance.grounding.repoRef = `x@${sha}`
    })
    let calls = 0
    const player = createFakeProofPlayer()
    const client = createFakeClient((i, params) => {
      calls++
      return player(i, params)
    })

    const res = await runProve({ client, model: 'claude-sonnet-4-6', system: 'zustand', bundlePath: BUNDLE_REL, repoPath, root, affected: true })

    expect(res).toMatchObject({ skipped: 'nothing-affected', modules: [], agents: [], estimatedCostUsd: 0 })
    expect(res.usage.input_tokens).toBe(0)
    expect(calls).toBe(0)
    expect(existsSync(path.join(root, 'proof-runs'))).toBe(false)
  })
})
