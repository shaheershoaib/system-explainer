import { describe, it, expect } from 'vitest'
import { layoutEr, layoutContext, type DiagramLayout } from './diagram-layout'
import type { Entity, Actor } from '../schema/bundle'

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
