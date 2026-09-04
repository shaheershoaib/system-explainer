import { useMemo } from 'react'
import clsx from 'clsx'
import type { Cardinality, Entity } from '@schema/bundle'
import { layoutEr, placeEdgeBadges, type Pt } from '../../../generator/diagram-layout'

const cardShort: Record<Cardinality, string> = {
  'one-to-one': '1–1',
  'one-to-many': '1–∞',
  'many-to-one': '∞–1',
  'many-to-many': '∞–∞',
}

export function ErDiagram({ entities, title }: { entities: Entity[]; title?: string }) {
  const { layout, edges } = useMemo(() => {
    const layout = layoutEr(entities)
    const center = (id: string): Pt | null => {
      const n = layout.nodes.find((x) => x.id === id)
      return n ? { x: n.x + n.w / 2, y: n.y + n.h / 2 } : null
    }
    const drawn = layout.edges.flatMap((e) => {
      const a = center(e.from)
      const b = center(e.to)
      return a && b ? [{ e, a, b }] : []
    })
    // cardinality badges are 32x18: keep their centers 34+ apart (reciprocal edges share a
    // midpoint) and off the node boxes
    const at = placeEdgeBadges(drawn.map((d): [Pt, Pt] => [d.a, d.b]), { minDist: 34, obstacles: layout.nodes })
    return { layout, edges: drawn.map((d, i) => ({ ...d, badge: at[i] })) }
  }, [entities])

  return (
    <figure className="my-2">
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label={title ?? 'Entity relationship diagram'}
        className="block h-auto w-full"
      >
        {title && <desc>{title}</desc>}
        {edges.map(({ e, a, b, badge }, i) => {
          const label = e.cardinality ? cardShort[e.cardinality] : ''
          return (
            <g key={i}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--color-line)" strokeWidth={2} />
              {label && (
                <>
                  <rect x={badge.x - 16} y={badge.y - 9} width={32} height={18} rx={5} fill="var(--color-surface)" stroke="var(--color-line)" />
                  <text x={badge.x} y={badge.y + 3} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--color-muted)">
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
