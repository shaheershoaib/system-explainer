import { useMemo } from 'react'
import clsx from 'clsx'
import type { Cardinality, Entity } from '@schema/bundle'
import { layoutEr } from '../../../generator/diagram-layout'

const cardShort: Record<Cardinality, string> = {
  'one-to-one': '1–1',
  'one-to-many': '1–∞',
  'many-to-one': '∞–1',
  'many-to-many': '∞–∞',
}

export function ErDiagram({ entities, title }: { entities: Entity[]; title?: string }) {
  const layout = useMemo(() => layoutEr(entities), [entities])
  const center = (id: string) => {
    const n = layout.nodes.find((x) => x.id === id)
    return n ? { x: n.x + n.w / 2, y: n.y + n.h / 2 } : null
  }

  return (
    <figure className="my-2">
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label={title ?? 'Entity relationship diagram'}
        className="block h-auto w-full"
      >
        {title && <desc>{title}</desc>}
        {layout.edges.map((e, i) => {
          const a = center(e.from)
          const b = center(e.to)
          if (!a || !b) return null
          const mx = (a.x + b.x) / 2
          const my = (a.y + b.y) / 2
          const label = e.cardinality ? cardShort[e.cardinality] : ''
          return (
            <g key={i}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--color-line)" strokeWidth={2} />
              {label && (
                <>
                  <rect x={mx - 16} y={my - 9} width={32} height={18} rx={5} fill="var(--color-surface)" stroke="var(--color-line)" />
                  <text x={mx} y={my + 3} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--color-muted)">
                    {label}
                  </text>
                </>
              )}
            </g>
          )
        })}
        {layout.nodes.map((n) => (
          <foreignObject key={n.id} x={n.x} y={n.y} width={n.w} height={n.h}>
            <div
              className={clsx(
                'flex h-full w-full items-center justify-center rounded-xl border px-2 text-center text-[13px] font-medium leading-tight',
                n.isReferenceData
                  ? 'border-dashed border-line bg-surface text-muted'
                  : 'border-accent-500 bg-accent-50 text-ink',
              )}
            >
              {n.label}
            </div>
          </foreignObject>
        ))}
      </svg>
    </figure>
  )
}
