import { useState } from 'react'
import { Link } from 'react-router'
import clsx from 'clsx'
import { ArrowRight } from 'lucide-react'
import type { ScreenAnnotation } from '@schema/bundle'
import { useBundle } from '../../lib/useBundle'
import { Markdown } from '../Markdown'

/** Renders a captured prototype screenshot with concept-linked, clickable hotspots. */
export function ScreenWalkthrough({ screenId }: { screenId: string }) {
  const bundle = useBundle()
  const screen = bundle.screens?.find((s) => s.id === screenId)
  const [activeId, setActiveId] = useState<string | null>(screen?.annotations[0]?.id ?? null)
  if (!screen) return null

  const annotations = screen.annotations
  const activeIndex = annotations.findIndex((a) => a.id === activeId)
  const active = activeIndex >= 0 ? annotations[activeIndex] : undefined

  const concept = (a: ScreenAnnotation): { to: string; label: string } | null => {
    if (a.module) {
      const m = bundle.modules.find((x) => x.id === a.module)
      if (m) return { to: `/module/${m.id}`, label: `See “${m.title}”` }
    }
    if (a.entity) {
      const e = bundle.entities.find((x) => x.id === a.entity)
      const m = bundle.modules.find((x) => x.entitiesIntroduced?.includes(a.entity!))
      if (e) return { to: m ? `/module/${m.id}` : '/', label: m ? `See ${e.name} in “${m.title}”` : `See ${e.name}` }
    }
    return null
  }
  const activeConcept = active ? concept(active) : null

  return (
    <figure className="my-4 rounded-2xl border border-line bg-surface p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded-full bg-accent-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-accent-700">In the app</span>
        <span className="text-sm font-medium text-ink">{screen.title}</span>
        {screen.route && <code className="rounded bg-canvas px-1.5 py-0.5 font-mono text-[11px] text-muted">{screen.route}</code>}
      </div>

      <div
        className="relative w-full overflow-hidden rounded-lg border border-line bg-canvas"
        style={screen.width && screen.height ? { aspectRatio: `${screen.width} / ${screen.height}` } : undefined}
      >
        <img src={import.meta.env.BASE_URL + screen.imageUrl} alt={screen.caption ?? screen.title} className="block w-full" loading="lazy" />
        {annotations.map((a, i) => {
          const on = a.id === activeId
          return (
            <button
              key={a.id}
              onClick={() => setActiveId(a.id)}
              aria-label={`Highlight: ${a.label}`}
              style={{ left: `${a.x * 100}%`, top: `${a.y * 100}%`, width: `${a.w * 100}%`, height: `${a.h * 100}%` }}
              className={clsx(
                'absolute rounded-md border-2 transition-colors',
                on ? 'border-accent-500 bg-accent-500/10' : 'border-accent-400/40 hover:border-accent-400 hover:bg-accent-400/10',
              )}
            >
              <span
                className={clsx(
                  'absolute -left-2.5 -top-2.5 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold text-white shadow',
                  on ? 'bg-accent-600' : 'bg-accent-400',
                )}
              >
                {i + 1}
              </span>
            </button>
          )
        })}
      </div>

      {/* legend chips */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {annotations.map((a, i) => (
          <button
            key={a.id}
            onClick={() => setActiveId(a.id)}
            className={clsx(
              'rounded-full border px-2.5 py-1 text-xs transition-colors',
              a.id === activeId ? 'border-accent-500 bg-accent-50 text-accent-700' : 'border-line text-muted hover:border-accent-300',
            )}
          >
            <span className="font-semibold">{i + 1}.</span> {a.label}
          </button>
        ))}
      </div>

      {/* selected explanation */}
      {active && (
        <div className="mt-3 rounded-xl border border-accent-200 bg-accent-50/40 p-3">
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-600 text-[11px] font-bold text-white">{activeIndex + 1}</span>
            <span className="text-sm font-semibold text-ink">{active.label}</span>
          </div>
          <div className="mt-1 text-sm">
            <Markdown>{active.md}</Markdown>
          </div>
          {activeConcept && (
            <Link to={activeConcept.to} className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-accent-600 hover:text-accent-700">
              <ArrowRight className="h-3.5 w-3.5" aria-hidden /> {activeConcept.label}
            </Link>
          )}
        </div>
      )}
      {screen.caption && <figcaption className="mt-2 text-xs text-muted">{screen.caption}</figcaption>}
    </figure>
  )
}
