import { useMemo } from 'react'
import clsx from 'clsx'
import type { Architecture } from '@schema/bundle'
import { placeEdgeBadges, type Pt } from '../../../generator/diagram-layout'

const KIND_ORDER = ['frontend', 'backend', 'service', 'job', 'datastore', 'external'] as const
const KIND_STYLE: Record<string, { box: string; label: string }> = {
  frontend: { box: 'border-accent-500 bg-accent-50 text-ink', label: 'Frontend' },
  backend: { box: 'border-emerald-400 bg-emerald-50 text-ink', label: 'Backend' },
  service: { box: 'border-amber-400 bg-amber-50 text-ink', label: 'Service' },
  job: { box: 'border-violet-400 bg-violet-50 text-ink', label: 'Job' },
  datastore: { box: 'border-sky-400 bg-sky-50 text-ink', label: 'Datastore' },
  external: { box: 'border-dashed border-line bg-surface text-muted', label: 'External' },
}

const A = { w: 168, h: 64, hGap: 28, vGap: 64, margin: 22 }

interface Node {
  id: string
  name: string
  tech?: string
  kind: string
  x: number
  y: number
}

function computeLayout(arch: Architecture) {
  const rows = KIND_ORDER.map((k) => arch.components.filter((c) => c.kind === k)).filter((r) => r.length > 0)
  const rowW = (n: number) => n * A.w + (n - 1) * A.hGap
  const maxW = Math.max(A.w, ...rows.map((r) => rowW(r.length)))
  const nodes: Node[] = []
  rows.forEach((row, ri) => {
    const startX = A.margin + (maxW - rowW(row.length)) / 2
    row.forEach((c, i) => nodes.push({ id: c.id, name: c.name, tech: c.tech, kind: c.kind, x: startX + i * (A.w + A.hGap), y: A.margin + ri * (A.h + A.vGap) }))
  })
  return { nodes, width: maxW + A.margin * 2, height: rows.length * A.h + (rows.length - 1) * A.vGap + A.margin * 2 }
}

/**
 * Connections are numbered by their position in `connections` (1-based): badge n sits on
 * edge n and the legend under the SVG spells n out. Labels never ride the edges themselves,
 * where a dense diagram piles them onto each other and onto other edges and nodes.
 */
function computeEdges(arch: Architecture, nodes: Node[]) {
  const center = (id: string): Pt | null => {
    const n = nodes.find((x) => x.id === id)
    return n ? { x: n.x + A.w / 2, y: n.y + A.h / 2 } : null
  }
  const drawn = (arch.connections ?? []).flatMap((cn, i) => {
    const a = center(cn.from)
    const b = center(cn.to)
    return a && b ? [{ n: i + 1, cn, a, b }] : []
  })
  const boxes = nodes.map((n) => ({ x: n.x, y: n.y, w: A.w, h: A.h }))
  const at = placeEdgeBadges(drawn.map((d): [Pt, Pt] => [d.a, d.b]), { obstacles: boxes })
  return drawn.map((d, i) => ({ ...d, badge: at[i] }))
}

export function ArchitectureDiagram({
  architecture,
  title,
  hrefFor,
}: {
  architecture: Architecture
  title?: string
  /** Optional resolver: a component's `tech` → a source permalink (makes nodes clickable). */
  hrefFor?: (tech?: string) => string | undefined
}) {
  const layout = useMemo(() => computeLayout(architecture), [architecture])
  const edges = useMemo(() => computeEdges(architecture, layout.nodes), [architecture, layout])
  const nameOf = (id: string) => architecture.components.find((c) => c.id === id)?.name ?? id
  return (
    <figure className="my-2">
      <svg viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label={title ?? 'System architecture diagram'} className="block h-auto w-full">
        {title && <desc>{title}</desc>}
        <defs>
          <marker id="arch-arrow" markerWidth={9} markerHeight={9} refX={7} refY={3} orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0,0 L7,3 L0,6 Z" fill="var(--color-muted)" />
          </marker>
        </defs>
        {edges.map(({ n, a, b }) => (
          <line key={n} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--color-line)" strokeWidth={1.5} markerEnd="url(#arch-arrow)" />
        ))}
        {layout.nodes.map((n) => {
          const href = hrefFor?.(n.tech)
          const inner = (
            <div
              className={clsx(
                'flex h-full w-full flex-col items-center justify-center rounded-xl border px-2 text-center leading-tight',
                KIND_STYLE[n.kind]?.box,
                href && 'transition-shadow hover:ring-2 hover:ring-accent-400',
              )}
            >
              <span className="text-[13px] font-semibold">{n.name}</span>
              <span className="text-[10px] text-muted">{KIND_STYLE[n.kind]?.label}{n.tech ? ` · ${n.tech}` : ''}</span>
            </div>
          )
          return (
            <foreignObject key={n.id} x={n.x} y={n.y} width={A.w} height={A.h}>
              {href ? (
                <a href={href} target="_blank" rel="noreferrer" className="block h-full w-full no-underline" title={`Open ${n.tech} in the repo`}>
                  {inner}
                </a>
              ) : (
                inner
              )}
            </foreignObject>
          )
        })}
        {/* numbered badges, drawn last so a node box never hides one */}
        {edges.map(({ n, badge }) => (
          <g key={n}>
            <circle cx={badge.x} cy={badge.y} r={9} fill="var(--color-surface)" stroke="var(--color-line)" />
            <text x={badge.x} y={badge.y + 3.5} textAnchor="middle" fontSize={10} fontWeight={600} fill="var(--color-ink)">
              {n}
            </text>
          </g>
        ))}
      </svg>

      {edges.length > 0 && (
        <figcaption className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-muted sm:grid-cols-2">
          {edges.map(({ n, cn }) => (
            <div key={n} className="flex flex-wrap items-baseline gap-1">
              <span className="w-4 shrink-0 text-right tabular-nums">{n}.</span>
              <span className="font-medium text-ink">{nameOf(cn.from)}</span>
              <span className="text-accent-500">→</span>
              <span className="font-medium text-ink">{nameOf(cn.to)}</span>
              {cn.label && <span>· {cn.label}</span>}
            </div>
          ))}
        </figcaption>
      )}
    </figure>
  )
}
