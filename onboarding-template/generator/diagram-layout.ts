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

export interface Pt {
  x: number
  y: number
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
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
 * bounded relaxation (longest path) so a cyclic graph still terminates. Within a
 * rank, nodes are ordered by a barycenter sweep (orderRanksByBarycenter) so the
 * edges between neighbouring ranks cross as little as possible; `orderRanks: false`
 * keeps insertion order (the before-state, for measuring).
 */
export function layoutEr(entities: Entity[], opts: { orderRanks?: boolean } = {}): DiagramLayout {
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
  // order each rank against its neighbours so the spine edges cross as little as possible
  const spineEdges: Array<[string, string]> = []
  for (const e of spine)
    for (const r of e.relationships ?? []) if (spineIds.has(r.to) && r.to !== e.id) spineEdges.push([e.id, r.to])
  const unordered = ranks.map((r) => byRank.get(r)!)
  const rows = opts.orderRanks === false ? unordered : orderRanksByBarycenter(unordered, spineEdges)
  const rowWidth = (n: number) => n * ER.w + (n - 1) * ER.hGap
  const spineSpan = Math.max(ER.w, ...rows.map((row) => rowWidth(row.length)))

  const nodes: LaidOutNode[] = []
  const yOf = new Map<string, number>()
  rows.forEach((row, rowIdx) => {
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

/** Undirected adjacency of `edges`, restricted to the ids present in `ranks`. */
function adjacencyOf(ranks: string[][], edges: Array<[string, string]>): Map<string, string[]> {
  const known = new Set(ranks.flat())
  const adj = new Map<string, string[]>()
  for (const [a, b] of edges) {
    if (!known.has(a) || !known.has(b) || a === b) continue
    if (!adj.has(a)) adj.set(a, [])
    if (!adj.has(b)) adj.set(b, [])
    adj.get(a)!.push(b)
    adj.get(b)!.push(a)
  }
  return adj
}

/** Crossings among the edges that join the same pair of ranks: two cross when their endpoints interleave. */
function countRankCrossings(ranks: string[][], edges: Array<[string, string]>): number {
  const pos = new Map<string, { rank: number; idx: number }>()
  ranks.forEach((row, rank) => row.forEach((id, idx) => pos.set(id, { rank, idx })))
  const byPair = new Map<string, Array<[number, number]>>()
  for (const [a, b] of edges) {
    const p = pos.get(a)
    const q = pos.get(b)
    if (!p || !q || p.rank === q.rank) continue
    const [lo, hi] = p.rank < q.rank ? [p, q] : [q, p]
    const key = `${lo.rank}:${hi.rank}`
    if (!byPair.has(key)) byPair.set(key, [])
    byPair.get(key)!.push([lo.idx, hi.idx])
  }
  let crossings = 0
  for (const list of byPair.values())
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) if ((list[i][0] - list[j][0]) * (list[i][1] - list[j][1]) < 0) crossings++
  return crossings
}

/**
 * Barycenter ordering, the Sugiyama step that untangles a layered graph. Four sweeps
 * (top→bottom, bottom→top, twice), each re-sorting a rank by the mean index of its
 * neighbours in the rank just swept; an edge in either direction counts. Nodes with no
 * neighbour there keep their slot and the sort is stable, so ties preserve the incoming
 * order and the result is deterministic. The best ordering seen (fewest crossings) is
 * returned, so the output never crosses more than the input. Pure: `ranks` is not mutated.
 */
export function orderRanksByBarycenter(ranks: string[][], edges: Array<[string, string]>): string[][] {
  const adj = adjacencyOf(ranks, edges)
  let rows = ranks.map((r) => [...r])
  let best = rows
  let bestCrossings = countRankCrossings(rows, edges)
  const reorder = (row: string[], against: string[]): string[] => {
    const idx = new Map(against.map((id, i) => [id, i]))
    const bary = new Map<string, number>()
    for (const id of row) {
      const near = (adj.get(id) ?? []).filter((n) => idx.has(n))
      if (near.length) bary.set(id, near.reduce((s, n) => s + idx.get(n)!, 0) / near.length)
    }
    const sorted = row.filter((id) => bary.has(id)).sort((a, b) => bary.get(a)! - bary.get(b)!)
    let k = 0
    return row.map((id) => (bary.has(id) ? sorted[k++] : id))
  }
  for (let sweep = 0; sweep < 4; sweep++) {
    rows = [...rows]
    if (sweep % 2 === 0) for (let i = 1; i < rows.length; i++) rows[i] = reorder(rows[i], rows[i - 1])
    else for (let i = rows.length - 2; i >= 0; i--) rows[i] = reorder(rows[i], rows[i + 1])
    const c = countRankCrossings(rows, edges)
    if (c < bestCrossings) {
      best = rows
      bestCrossings = c
    }
  }
  return best
}

/**
 * Edge crossings in a laid-out ER diagram: pairs of edges that join the same two ranks
 * (rows of spine nodes, read off `y`) whose endpoints interleave (read off `x`). Reference
 * lane nodes have no rank and are skipped.
 */
export function countCrossings(layout: DiagramLayout): number {
  const rowsByY = new Map<number, LaidOutNode[]>()
  for (const n of layout.nodes) {
    if (n.isReferenceData) continue
    if (!rowsByY.has(n.y)) rowsByY.set(n.y, [])
    rowsByY.get(n.y)!.push(n)
  }
  const ranks = [...rowsByY.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, row]) => [...row].sort((a, b) => a.x - b.x).map((n) => n.id))
  return countRankCrossings(ranks, layout.edges.map((e): [string, string] => [e.from, e.to]))
}

const BADGE_T = [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65]
// only to escape a node box the edge runs straight through (every near t is inside it)
const BADGE_T_FAR = [0.3, 0.7, 0.25, 0.75, 0.2, 0.8]

/**
 * One badge point per edge, in edge order. A badge starts at its edge's midpoint and, when
 * its center would sit within `minDist` of an earlier badge or inside an obstacle box (a
 * node), slides along its own edge toward t = 0.35 / 0.65 to the first clear spot. When the
 * edge runs through a box that swallows that whole range, it slides further (to t = 0.2 / 0.8)
 * to get off the box; failing that it takes the least-crowded near spot. Deterministic:
 * depends only on the input order.
 */
export function placeEdgeBadges(edges: Array<[Pt, Pt]>, opts: { minDist?: number; obstacles?: Box[] } = {}): Pt[] {
  const { minDist = 22, obstacles = [] } = opts
  const placed: Pt[] = []
  const inside = (p: Pt) => obstacles.some((b) => p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h)
  const clearance = (p: Pt) => Math.min(Infinity, ...placed.map((q) => Math.hypot(p.x - q.x, p.y - q.y)))
  const clear = (p: Pt) => clearance(p) >= minDist
  return edges.map(([a, b]) => {
    const at = (t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
    const near = BADGE_T.map(at)
    const pick =
      near.find((p) => clear(p) && !inside(p)) ??
      BADGE_T_FAR.map(at).find((p) => clear(p) && !inside(p)) ??
      near.find(clear) ??
      near.reduce((best, p) => (clearance(p) > clearance(best) ? p : best))
    placed.push(pick)
    return pick
  })
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
