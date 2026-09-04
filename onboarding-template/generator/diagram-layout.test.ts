import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  layoutEr,
  layoutContext,
  orderRanksByBarycenter,
  countCrossings,
  placeEdgeBadges,
  type DiagramLayout,
  type Pt,
} from './diagram-layout'
import type { Entity, Actor } from '../schema/bundle'

const here = path.dirname(fileURLToPath(import.meta.url))

const overlaps = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

function assertNoOverlaps(layout: DiagramLayout) {
  for (let i = 0; i < layout.nodes.length; i++)
    for (let j = i + 1; j < layout.nodes.length; j++)
      expect(
        overlaps(layout.nodes[i], layout.nodes[j]),
        `nodes "${layout.nodes[i].id}" and "${layout.nodes[j].id}" overlap`,
      ).toBe(false)
}

function assertInBounds(layout: DiagramLayout) {
  for (const n of layout.nodes) {
    expect(n.x).toBeGreaterThanOrEqual(0)
    expect(n.y).toBeGreaterThanOrEqual(0)
    expect(n.x + n.w).toBeLessThanOrEqual(layout.width + 0.001)
    expect(n.y + n.h).toBeLessThanOrEqual(layout.height + 0.001)
  }
}

const chain: Entity[] = [
  {
    id: 'customer',
    name: 'Customer',
    definition: 'the buyer record',
    relationships: [
      { to: 'account', cardinality: 'one-to-many' },
      { to: 'region', cardinality: 'one-to-one' },
    ],
  },
  { id: 'account', name: 'Account', definition: 'billing unit', relationships: [{ to: 'contract', cardinality: 'one-to-many' }] },
  {
    id: 'contract',
    name: 'Contract',
    definition: 'contract',
    relationships: [
      { to: 'lineitem', cardinality: 'one-to-many' },
      { to: 'supplier', cardinality: 'many-to-one' },
    ],
  },
  { id: 'lineitem', name: 'Line Item', definition: 'order line' },
  { id: 'region', name: 'Region', definition: 'record of', isReferenceData: true },
  { id: 'supplier', name: 'Supplier', definition: 'record of', isReferenceData: true },
]

describe('layoutEr', () => {
  it('lays out one node per entity, in bounds, with no overlaps', () => {
    const l = layoutEr(chain)
    expect(l.nodes).toHaveLength(chain.length)
    expect(l.width).toBeGreaterThan(0)
    expect(l.height).toBeGreaterThan(0)
    assertInBounds(l)
    assertNoOverlaps(l)
  })

  it('places parents above children (so cardinality reads top-down)', () => {
    const l = layoutEr(chain)
    const y = (id: string) => l.nodes.find((n) => n.id === id)!.y
    expect(y('customer')).toBeLessThan(y('account'))
    expect(y('account')).toBeLessThan(y('contract'))
    expect(y('contract')).toBeLessThan(y('lineitem'))
  })

  it('emits an edge per relationship, all referencing real nodes', () => {
    const l = layoutEr(chain)
    const ids = new Set(l.nodes.map((n) => n.id))
    expect(l.edges.length).toBe(5) // 2 + 1 + 2 relationships
    for (const e of l.edges) {
      expect(ids.has(e.from)).toBe(true)
      expect(ids.has(e.to)).toBe(true)
    }
  })

  it('does not loop forever on a cyclic entity graph', () => {
    const cyclic: Entity[] = [
      { id: 'a', name: 'A', definition: '', relationships: [{ to: 'b', cardinality: 'one-to-many' }] },
      { id: 'b', name: 'B', definition: '', relationships: [{ to: 'a', cardinality: 'one-to-many' }] },
    ]
    const l = layoutEr(cyclic)
    expect(l.nodes).toHaveLength(2)
    assertNoOverlaps(l)
  })

  it('routes edges so none cross an unrelated node (reference lane keeps it clean)', () => {
    const l = layoutEr(chain)
    const center = (id: string) => {
      const n = l.nodes.find((x) => x.id === id)!
      return { x: n.x + n.w / 2, y: n.y + n.h / 2 }
    }
    const through = (
      a: { x: number; y: number },
      b: { x: number; y: number },
      n: { x: number; y: number; w: number; h: number },
    ) => {
      for (let t = 0.12; t <= 0.88; t += 0.04) {
        const x = a.x + (b.x - a.x) * t
        const y = a.y + (b.y - a.y) * t
        if (x > n.x && x < n.x + n.w && y > n.y && y < n.y + n.h) return true
      }
      return false
    }
    for (const e of l.edges) {
      const a = center(e.from)
      const b = center(e.to)
      for (const n of l.nodes) {
        if (n.id === e.from || n.id === e.to) continue
        expect(through(a, b, n), `edge ${e.from}->${e.to} crosses ${n.id}`).toBe(false)
      }
    }
  })
})

const actors: Actor[] = [
  { id: 'operator', name: 'Operator', role: 'operator', relationships: [{ to: 'supplier', label: 'administers billing for' }] },
  { id: 'supplier', name: 'Supplier', role: 'fulfiller', relationships: [{ to: 'buyer', label: 'fulfils for' }] },
  { id: 'buyer', name: 'Buyer', role: 'places orders', relationships: [{ to: 'catalog', label: 'lists items via' }] },
  { id: 'catalog', name: 'Catalog Service', role: 'item source' },
  { id: 'reseller', name: 'Reseller', role: 'reseller rep' },
  { id: 'region', name: 'Region', role: 'territory' },
  { id: 'bank', name: 'External Payment System', role: 'moves money' },
]

describe('layoutContext', () => {
  it('places the system plus one node per actor, no overlaps, in bounds', () => {
    const l = layoutContext('Billing', actors)
    expect(l.nodes).toHaveLength(actors.length + 1)
    expect(l.nodes.some((n) => n.kind === 'system')).toBe(true)
    assertInBounds(l)
    assertNoOverlaps(l)
  })

  it('emits a spoke from the system to every actor', () => {
    const l = layoutContext('Billing', actors)
    const spokes = l.edges.filter((e) => e.variant === 'spoke')
    expect(spokes).toHaveLength(actors.length)
  })

  it('emits actor-relationship edges that reference real nodes', () => {
    const l = layoutContext('Billing', actors)
    const ids = new Set(l.nodes.map((n) => n.id))
    const rels = l.edges.filter((e) => e.variant === 'actor-rel')
    expect(rels.length).toBe(3)
    for (const e of rels) {
      expect(ids.has(e.from)).toBe(true)
      expect(ids.has(e.to)).toBe(true)
    }
  })

  it('handles a small actor set without overlaps', () => {
    const l = layoutContext('Tiny', actors.slice(0, 3))
    assertNoOverlaps(l)
  })
})

/** The entities the HomePage system map renders for the zustand course (its scope rule, verbatim). */
function zustandErEntities(): Entity[] {
  const file = path.resolve(here, '..', 'bundles', 'zustand', 'bundle.json')
  const bundle = JSON.parse(readFileSync(file, 'utf8')) as { entities: Entity[] }
  const related = bundle.entities.filter((e) => (e.relationships?.length ?? 0) > 0)
  const scope =
    bundle.entities.length <= 18
      ? bundle.entities.map((e) => e.id)
      : [...new Set(related.flatMap((e) => [e.id, ...(e.relationships ?? []).map((r) => r.to)]))]
  return bundle.entities.filter((e) => scope.includes(e.id))
}

describe('orderRanksByBarycenter', () => {
  it('reorders the lower rank so the crossing disappears, without mutating its input', () => {
    const ranks = [['a', 'b'], ['x', 'y']]
    const edges: Array<[string, string]> = [['a', 'y'], ['b', 'x']]
    expect(orderRanksByBarycenter(ranks, edges)).toEqual([['a', 'b'], ['y', 'x']])
    expect(ranks).toEqual([['a', 'b'], ['x', 'y']])
  })

  it('keeps nodes without neighbours in their slot and preserves the order of ties (stable)', () => {
    const ranks = [['a', 'b'], ['lonely', 'x', 'y', 'z']]
    // x and y both hang off b (a tie); z hangs off a; lonely touches nothing in rank 0
    const edges: Array<[string, string]> = [['b', 'x'], ['y', 'b'], ['a', 'z']]
    expect(orderRanksByBarycenter(ranks, edges)).toEqual([['a', 'b'], ['lonely', 'z', 'x', 'y']])
  })
})

describe('countCrossings', () => {
  const node = (id: string, x: number, y: number) => ({ id, label: id, x, y, w: 10, h: 10, kind: 'entity' as const })
  const er = (from: string, to: string) => ({ from, to, variant: 'er' as const })

  it('counts one crossing for an X between two rows and none once it is untangled', () => {
    const crossed: DiagramLayout = {
      width: 100,
      height: 100,
      nodes: [node('a', 0, 0), node('b', 50, 0), node('x', 0, 50), node('y', 50, 50)],
      edges: [er('a', 'y'), er('b', 'x')],
    }
    expect(countCrossings(crossed)).toBe(1)
    const straight = { ...crossed, edges: [er('a', 'x'), er('b', 'y')] }
    expect(countCrossings(straight)).toBe(0)
  })

  it('ignores reference-lane nodes and edges within one row', () => {
    const layout: DiagramLayout = {
      width: 100,
      height: 100,
      nodes: [node('a', 0, 0), node('b', 50, 0), { ...node('ref', 100, 0), isReferenceData: true }, node('x', 0, 50)],
      edges: [er('a', 'b'), er('a', 'ref'), er('b', 'ref'), er('b', 'x')],
    }
    expect(countCrossings(layout)).toBe(0)
  })
})

describe('layoutEr crossing reduction', () => {
  const cases: Array<[string, Entity[]]> = [
    ['chain fixture', chain],
    ['zustand bundle entities', zustandErEntities()],
  ]
  for (const [name, ents] of cases) {
    const before = countCrossings(layoutEr(ents, { orderRanks: false }))
    const after = countCrossings(layoutEr(ents))
    it(`${name}: ordered layout crosses ${after} times vs ${before} unordered (must not be more)`, () => {
      console.log(`[er crossings] ${name}: unordered=${before} ordered=${after}`)
      expect(after, `${name}: crossings unordered=${before} ordered=${after}`).toBeLessThanOrEqual(before)
    })
  }

  it('still lays out every zustand entity once, in bounds, with no overlaps', () => {
    const ents = zustandErEntities()
    const l = layoutEr(ents)
    expect(l.nodes).toHaveLength(ents.length)
    assertInBounds(l)
    assertNoOverlaps(l)
  })

  it('is deterministic: two calls produce identical layouts', () => {
    const ents = zustandErEntities()
    expect(layoutEr(ents)).toEqual(layoutEr(ents))
    expect(layoutEr(chain)).toEqual(layoutEr(chain))
  })
})

describe('placeEdgeBadges', () => {
  const edge: [Pt, Pt] = [{ x: 0, y: 0 }, { x: 200, y: 0 }]

  it('puts a lone badge at the midpoint of its edge', () => {
    expect(placeEdgeBadges([edge])).toEqual([{ x: 100, y: 0 }])
  })

  it('slides a later badge along its edge when two centers would sit closer than minDist', () => {
    const [first, second] = placeEdgeBadges([edge, edge])
    expect(first).toEqual({ x: 100, y: 0 })
    expect(Math.hypot(second.x - first.x, second.y - first.y)).toBeGreaterThanOrEqual(22)
    expect(second.x).toBeGreaterThanOrEqual(70 - 1e-9) // t stays within 0.35..0.65
    expect(second.x).toBeLessThanOrEqual(130 + 1e-9)
  })

  it('moves off an obstacle box when the edge has a clear spot', () => {
    const [p] = placeEdgeBadges([edge], { obstacles: [{ x: 90, y: -10, w: 20, h: 20 }] })
    expect(p.x > 90 && p.x < 110).toBe(false)
  })

  it('slides past t = 0.35 / 0.65 when the edge runs straight through a node box', () => {
    // a 168-wide node centered on the midpoint of a 400-long edge swallows t in 0.29..0.71
    const long: [Pt, Pt] = [{ x: 0, y: 0 }, { x: 400, y: 0 }]
    const [p] = placeEdgeBadges([long], { obstacles: [{ x: 116, y: -32, w: 168, h: 64 }] })
    expect(p.x > 116 && p.x < 284).toBe(false)
    expect(p.x).toBeGreaterThanOrEqual(80 - 1e-9) // never closer to an endpoint than t = 0.2
    expect(p.x).toBeLessThanOrEqual(320 + 1e-9)
  })

  it('is deterministic', () => {
    const edges: Array<[Pt, Pt]> = [edge, edge, [{ x: 0, y: 0 }, { x: 0, y: 200 }]]
    expect(placeEdgeBadges(edges)).toEqual(placeEdgeBadges(edges))
  })
})
