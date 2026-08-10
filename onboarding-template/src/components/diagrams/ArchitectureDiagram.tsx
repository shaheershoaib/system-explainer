import { useMemo } from 'react'
import clsx from 'clsx'
import type { Architecture } from '@schema/bundle'

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
  const center = (id: string) => {
    const n = layout.nodes.find((x) => x.id === id)
    return n ? { x: n.x + A.w / 2, y: n.y + A.h / 2 } : null
  }
  return (
    <figure className="my-2">
      <svg viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label={title ?? 'System architecture diagram'} className="block h-auto w-full">
        {title && <desc>{title}</desc>}
        <defs>
          <marker id="arch-arrow" markerWidth={9} markerHeight={9} refX={7} refY={3} orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0,0 L7,3 L0,6 Z" fill="var(--color-muted)" />
          </marker>
        </defs>
        {(() => {
          type Box = { x: number; y: number; w: number; h: number }
          const placed: Box[] = []
          const hit = (p: Box, q: Box) => p.x < q.x + q.w && p.x + p.w > q.x && p.y < q.y + q.h && p.y + p.h > q.y
          return (architecture.connections ?? []).map((cn, i) => {
            const a = center(cn.from)
            const b = center(cn.to)
            if (!a || !b) return null
            const lx = (a.x + b.x) / 2
            let ly = (a.y + b.y) / 2
            if (cn.label) {
              const w = cn.label.length * 6 + 8
              let box: Box = { x: lx - w / 2, y: ly - 8, w, h: 16 }
              let n = 0
              while (placed.some((p) => hit(box, p)) && n < 8) {
                ly += 18
                box = { x: lx - w / 2, y: ly - 8, w, h: 16 }
                n++
              }
              placed.push(box)
            }
            return (
              <g key={i}>
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--color-line)" strokeWidth={1.5} markerEnd="url(#arch-arrow)" />
                {cn.label && (
                  <>
                    <rect x={lx - (cn.label.length * 6 + 8) / 2} y={ly - 8} width={cn.label.length * 6 + 8} height={16} rx={4} fill="var(--color-surface)" opacity={0.92} />
                    <text x={lx} y={ly + 3} textAnchor="middle" fontSize={10} fill="var(--color-muted)">{cn.label}</text>
                  </>
                )}
              </g>
            )
          })
        })()}
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
      </svg>
    </figure>
  )
}
