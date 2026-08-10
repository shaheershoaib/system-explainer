import { describe, it, expect } from 'vitest'
import { parseChangedFiles, affectedModules, pinnedSha } from './reverify'
import { readWorkDir } from './assemble-bundle'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

describe('parseChangedFiles', () => {
  it('splits git diff --name-only output into a set, dropping blanks', () => {
    const s = parseChangedFiles('src/app.py\n\nsrc/models.py\n')
    expect(s).toEqual(new Set(['src/app.py', 'src/models.py']))
  })
})

const bundleFixture = {
  provenance: { grounding: { repoRef: 'flask@36e4a82' } },
  modules: [
    {
      id: 'routing',
      title: 'Routing',
      lessons: [
        { id: 'l1', blocks: [{ type: 'code', sourcePath: 'src/app.py', code: 'x' }, { type: 'prose', md: 'p' }] },
        { id: 'l2', blocks: [{ type: 'code', sourcePath: 'src/blueprints.py', code: 'y' }] },
      ],
    },
    {
      id: 'sessions',
      title: 'Sessions',
      lessons: [{ id: 'l1', blocks: [{ type: 'code', sourcePath: 'src/sessions.py', code: 'z' }] }],
    },
  ],
}

describe('affectedModules', () => {
  it('maps changed files to the modules whose code blocks cite them', () => {
    const out = affectedModules(bundleFixture, new Set(['src/app.py', 'docs/README.md']))
    expect(out).toEqual([{ moduleId: 'routing', title: 'Routing', files: ['src/app.py'], blocks: 1 }])
  })
  it('returns empty when no cited file changed (docs-only diff)', () => {
    expect(affectedModules(bundleFixture, new Set(['docs/README.md']))).toEqual([])
  })
  it('counts multiple hit blocks and files per module', () => {
    const out = affectedModules(bundleFixture, new Set(['src/app.py', 'src/blueprints.py', 'src/sessions.py']))
    expect(out).toEqual([
      { moduleId: 'routing', title: 'Routing', files: ['src/app.py', 'src/blueprints.py'], blocks: 2 },
      { moduleId: 'sessions', title: 'Sessions', files: ['src/sessions.py'], blocks: 1 },
    ])
  })
})

describe('pinnedSha', () => {
  it('extracts the sha from provenance.grounding.repoRef', () => {
    expect(pinnedSha(bundleFixture)).toBe('36e4a82')
  })
  it('returns undefined when unpinned', () => {
    expect(pinnedSha({})).toBeUndefined()
  })
})

describe('readWorkDir (the disk-bus reader)', () => {
  function makeWorkDir() {
    const dir = mkdtempSync(path.join(tmpdir(), 'ua-workdir-'))
    mkdirSync(path.join(dir, 'modules'))
    writeFileSync(
      path.join(dir, 'plan.json'),
      JSON.stringify({ systemName: 'Demo', oneLiner: 'demo', elevatorPitch: 'pitch', outOfScope: [], audience: 'developer', depth: 'L3', repoUrl: null, domains: [{ id: 'b-mod', title: 'B' }, { id: 'a-mod', title: 'A' }] }),
    )
    writeFileSync(path.join(dir, 'datamodel.json'), JSON.stringify({ entities: [{ id: 'e1', name: 'E1', definition: 'd' }] }))
    const mod = (id: string) => ({ id, title: id.toUpperCase(), objective: 'o', concepts: [], lessons: [{ title: 'L', prose: 'p' }], quiz: [] })
    writeFileSync(path.join(dir, 'modules', 'a-mod.json'), JSON.stringify(mod('a-mod')))
    writeFileSync(path.join(dir, 'modules', 'b-mod.json'), JSON.stringify(mod('b-mod')))
    writeFileSync(path.join(dir, 'modules', 'extra.json'), JSON.stringify(mod('extra'))) // critic addition, not in plan
    return dir
  }
  it('reads plan + datamodel + modules, ordering by the plan with extras appended', () => {
    const out = readWorkDir(makeWorkDir())
    expect(out.system.name).toBe('Demo')
    expect(out.system.audience).toBe('developer')
    expect(out.dataModel.entities).toHaveLength(1)
    expect(out.modules.map((m: any) => m.id)).toEqual(['b-mod', 'a-mod', 'extra'])
  })
  it('fails LOUDLY on an unparseable module file instead of silently shrinking the course', () => {
    const dir = makeWorkDir()
    writeFileSync(path.join(dir, 'modules', 'corrupt.json'), '{ not json')
    expect(() => readWorkDir(dir)).toThrow(/unparseable module file/)
  })
  it('fails when modules/ is missing or empty', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ua-workdir-'))
    expect(() => readWorkDir(dir)).toThrow(/no modules/)
  })
})
