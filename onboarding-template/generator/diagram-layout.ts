import type { Actor, Cardinality, Entity } from '../schema/bundle'

export interface LaidOutNode {
  id: string
  label: string
  x: number
  y: number
  w: number
  h: number
  kind: 'entity' | 'actor' | 'system'
  isReferenceData?: boolean
}

export interface LaidOutEdge {
  from: string
  to: string
  label?: string
  cardinality?: Cardinality
  variant: 'er' | 'spoke' | 'actor-rel'
}

export interface DiagramLayout {
  width: number
  height: number
  nodes: LaidOutNode[]
  edges: LaidOutEdge[]
}

const ER = { w: 168, h: 64, hGap: 28, vGap: 80, margin: 24, laneGap: 60 }

/**
 * Layered ER layout with a reference-data side lane.
 *
 * Spine entities (non-reference) are ranked top→down (parent above child) in a
 * center column. Reference-data entities ("record of an actor") sit in a right
 * lane, each aligned to the row of the spine entity that links it. This keeps
 * every edge either a short vertical (the spine chain) or a short horizontal
 * (spine→reference) — so edges never slice through an unrelated node and the
 * cardinality labels never land on one. A one-to-many edge A→B ranks A above B;
 * many-to-one ranks B above A; many-to-many adds no rank constraint. Ranks use
 * bounded relaxation (longest path) so a cyclic graph still terminates.
 */
export function layoutEr(entities: Entity[]): DiagramLayout {
  const idSet = new Set(entities.map((e) => e.id))
  const byId = new Map(entities.map((e) => [e.id, e]))
  const spine = entities.filter((e) => !e.isReferenceData)
  const refs = entities.filter((e) => e.isReferenceData)
  const spineIds = new Set(spine.map((e) => e.id))

  // rank the spine via longest-path on spine-only parent→child edges
  const children = new Map<string, string[]>()
  spine.forEach((e) => children.set(e.id, []))
  for (const e of entities) {
    for (const r of e.relationships ?? []) {
      if (!idSet.has(r.to) || r.to === e.id) continue
      let parent: string | undefined
      let child: string | undefined
      if (r.cardinality === 'one-to-many' || r.cardinality === 'one-to-one') {
        parent = e.id
        child = r.to
      } else if (r.cardinality === 'many-to-one') {
        parent = r.to
        child = e.id
      } else continue
      if (parent && child && spineIds.has(parent) && spineIds.has(child)) children.get(parent)!.push(child)
    }
  }
  const rank = new Map<string, number>()
  spine.forEach((e) => rank.set(e.id, 0))
  for (let iter = 0; iter < spine.length; iter++) {
    let changed = false
    for (const [p, kids] of children) {
      for (const c of kids) {
        if (rank.get(c)! < rank.get(p)! + 1) {
          rank.set(c, rank.get(p)! + 1)
          changed = true
        }
      }
    }
    if (!changed) break
  }

  const byRank = new Map<number, string[]>()
  for (const e of spine) {
    const r = rank.get(e.id)!
    if (!byRank.has(r)) byRank.set(r, [])
    byRank.get(r)!.push(e.id)
  }
  const ranks = [...byRank.keys()].sort((a, b) => a - b)
  const rowWidth = (n: number) => n * ER.w + (n - 1) * ER.hGap
  const spineSpan = Math.max(ER.w, ...ranks.map((r) => rowWidth(byRank.get(r)!.length)))

  const nodes: LaidOutNode[] = []
  const yOf = new Map<string, number>()
  ranks.forEach((r, rowIdx) => {
    const row = byRank.get(r)!
    const startX = ER.margin + (spineSpan - rowWidth(row.length)) / 2
    const y = ER.margin + rowIdx * (ER.h + ER.vGap)
    row.forEach((id, i) => {
      nodes.push({ id, label: byId.get(id)!.name, x: startX + i * (ER.w + ER.hGap), y, w: ER.w, h: ER.h, kind: 'entity' })
      yOf.set(id, y)
    })
  })

  // reference entities → right lane, aligned to a linking spine row, de-collided vertically
  const laneX = ER.margin + spineSpan + ER.laneGap
  const linkRowY = (ref: Entity): number => {
    for (const r of ref.relationships ?? []) if (yOf.has(r.to)) return yOf.get(r.to)!
    for (const e of spine) for (const r of e.relationships ?? []) if (r.to === ref.id && yOf.has(e.id)) return yOf.get(e.id)!
    return ER.margin
  }
  const placed = refs.map((ref) => ({ ref, y: linkRowY(ref) })).sort((a, b) => a.y - b.y)
  let lastBottom = -Infinity
  for (const { ref, y } of placed) {
    const yy = Math.max(y, lastBottom + 24)
    lastBottom = yy + ER.h
    nodes.push({ id: ref.id, label: byId.get(ref.id)!.name, x: laneX, y: yy, w: ER.w, h: ER.h, kind: 'entity', isReferenceData: true })
  }

  const edges: LaidOutEdge[] = []
  for (const e of entities) {
    for (const r of e.relationships ?? []) {
      if (idSet.has(r.to)) edges.push({ from: e.id, to: r.to, label: r.label, cardinality: r.cardinality, variant: 'er' })
    }
  }

  const right = Math.max(...nodes.map((n) => n.x + n.w))
  const bottom = Math.max(...nodes.map((n) => n.y + n.h))
  return { width: right + ER.margin, height: bottom + ER.margin, nodes, edges }
}

const CTX = { w: 156, h: 60, sysW: 168, sysH: 64, margin: 64 }

/** Radial context diagram: the system at the center, actors on a ring around it. */
export function layoutContext(systemName: string, actors: Actor[]): DiagramLayout {
  const n = actors.length
  // Radius large enough that adjacent ring nodes (chord 2R·sin(π/n)) never collide.
  const minChordR = n > 1 ? (CTX.w + 36) / (2 * Math.sin(Math.PI / n)) : 0
  const R = Math.max(190, minChordR)
  const cx = R + CTX.w / 2 + CTX.margin
  const cy = R + CTX.h / 2 + CTX.margin

  const nodes: LaidOutNode[] = [
    {
      id: '__system__',
      label: systemName,
      x: cx - CTX.sysW / 2,
      y: cy - CTX.sysH / 2,
      w: CTX.sysW,
      h: CTX.sysH,
      kind: 'system',
    },
  ]
  actors.forEach((a, i) => {
    const theta = (i / n) * Math.PI * 2 - Math.PI / 2 // start at top
    nodes.push({
      id: a.id,
      label: a.name,
      x: cx + R * Math.cos(theta) - CTX.w / 2,
      y: cy + R * Math.sin(theta) - CTX.h / 2,
      w: CTX.w,
      h: CTX.h,
      kind: 'actor',
    })
  })

  const actorIds = new Set(actors.map((a) => a.id))
  const edges: LaidOutEdge[] = []
  for (const a of actors) edges.push({ from: '__system__', to: a.id, variant: 'spoke' })
  for (const a of actors)
    for (const r of a.relationships ?? [])
      if (actorIds.has(r.to)) edges.push({ from: a.id, to: r.to, label: r.label, variant: 'actor-rel' })

  return { width: cx * 2, height: cy * 2, nodes, edges }
}
