import { useMemo } from 'react'
import clsx from 'clsx'
import type { Actor } from '@schema/bundle'
import { layoutContext } from '../../../generator/diagram-layout'

export function ContextDiagram({
  systemName,
  actors,
  title,
}: {
  systemName: string
  actors: Actor[]
  title?: string
}) {
  const layout = useMemo(() => layoutContext(systemName, actors), [systemName, actors])
  const center = (id: string) => {
    const n = layout.nodes.find((x) => x.id === id)
    return n ? { x: n.x + n.w / 2, y: n.y + n.h / 2 } : null
  }
  const nameOf = (id: string) => actors.find((a) => a.id === id)?.name ?? id
  const rels = layout.edges.filter((e) => e.variant === 'actor-rel' && e.label)
  const C = { x: layout.width / 2, y: layout.height / 2 }
  const firstActor = layout.nodes.find((n) => n.kind === 'actor')
  const ringR = firstActor
    ? Math.hypot(firstActor.x + firstActor.w / 2 - C.x, firstActor.y + firstActor.h / 2 - C.y)
    : 200

  return (
    <figure className="my-2">
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label={title ?? 'Context diagram of external actors'}
        className="block h-auto w-full"
      >
        {title && <desc>{title}</desc>}
        <defs>
          <marker id="ctx-arrow" markerWidth={9} markerHeight={9} refX={7} refY={3} orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0,0 L7,3 L0,6 Z" fill="var(--color-accent-400)" />
          </marker>
        </defs>

        {/* spokes: the system coordinating each actor */}
        {layout.edges
          .filter((e) => e.variant === 'spoke')
          .map((e, i) => {
            const a = center(e.from)
            const b = center(e.to)
            if (!a || !b) return null
            return <line key={`s${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--color-line)" strokeWidth={1.5} strokeDasharray="3 3" />
          })}

        {/* actor-to-actor relationships — bowed OUTWARD so they never cross the
            center node. Labels live in the legend below (a dense radial can't place
            long verbs inline without collisions, and this generalizes to any system). */}
        {layout.edges
          .filter((e) => e.variant === 'actor-rel')
          .map((e, i) => {
            const a = center(e.from)
            const b = center(e.to)
            if (!a || !b) return null
            const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
            let dx = mid.x - C.x
            let dy = mid.y - C.y
            let len = Math.hypot(dx, dy)
            if (len < 24) {
              dx = -(b.y - a.y)
              dy = b.x - a.x
              len = Math.hypot(dx, dy) || 1
            }
            dx /= len
            dy /= len
            const ctrl = { x: C.x + dx * (ringR + 34), y: C.y + dy * (ringR + 34) }
            return (
              <path
                key={`r${i}`}
                d={`M ${a.x} ${a.y} Q ${ctrl.x} ${ctrl.y} ${b.x} ${b.y}`}
                fill="none"
                stroke="var(--color-accent-400)"
                strokeWidth={1.5}
                markerEnd="url(#ctx-arrow)"
              />
            )
          })}

        {layout.nodes.map((n) => (
          <foreignObject key={n.id} x={n.x} y={n.y} width={n.w} height={n.h}>
            <div
              className={clsx(
                'flex h-full w-full items-center justify-center rounded-xl border px-2 text-center font-medium leading-tight',
                n.kind === 'system'
                  ? 'border-accent-600 bg-accent-500 text-[14px] text-white shadow-sm'
                  : 'border-line bg-surface text-[12.5px] text-ink',
              )}
            >
              {n.label}
            </div>
          </foreignObject>
        ))}
      </svg>

      {rels.length > 0 && (
        <figcaption className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-muted sm:grid-cols-2">
          {rels.map((r, i) => (
            <div key={i} className="flex flex-wrap items-baseline gap-1">
              <span className="font-medium text-ink">{nameOf(r.from)}</span>
              <span className="text-accent-500">→</span>
              <span className="font-medium text-ink">{nameOf(r.to)}</span>
              <span>· {r.label}</span>
            </div>
          ))}
        </figcaption>
      )}
    </figure>
  )
}
