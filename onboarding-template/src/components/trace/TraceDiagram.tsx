import { Link } from 'react-router'
import { ArrowRight, FileCode2 } from 'lucide-react'
import type { OnboardingBundle, TraceStep } from '@schema/bundle'
import { useBundle } from '../../lib/useBundle'
import { sourceUrl } from '../../lib/persona'
import { Markdown } from '../Markdown'

/** `path` or `path:start[-end]` -> the repo permalink, deep-linked to the lines when given. */
function sourceHref(bundle: OnboardingBundle, sourcePath: string): string | undefined {
  const m = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(sourcePath)
  const base = sourceUrl(bundle, m?.[1] ?? sourcePath)
  if (!base) return undefined
  return m?.[2] ? `${base}#L${m[2]}-L${m[3] ?? m[2]}` : base
}

/**
 * "The life of one X": a vertical stepper tracing one unit of work through every hand-off, each
 * named with the exact observed label. Component ids resolve to the architecture node's name,
 * entity links go to the module that introduces the entity (as ScreenWalkthrough does), and a
 * cited source path opens the pinned commit.
 */
export function TraceDiagram({ traceId, title }: { traceId: string; title?: string }) {
  const bundle = useBundle()
  const trace = bundle.traces?.find((t) => t.id === traceId)
  if (!trace) return null

  const componentName = (id?: string) => (id ? bundle.architecture?.components.find((c) => c.id === id)?.name ?? id : undefined)
  const actorName = (id?: string) => (id ? bundle.actors.find((a) => a.id === id)?.name ?? id : undefined)
  const concept = (s: TraceStep): { to: string; label: string } | null => {
    if (!s.entity) return null
    const e = bundle.entities.find((x) => x.id === s.entity)
    if (!e) return null
    const m = bundle.modules.find((x) => x.entitiesIntroduced?.includes(s.entity!))
    return { to: m ? `/module/${m.id}` : '/', label: m ? `See ${e.name} in “${m.title}”` : `See ${e.name}` }
  }

  return (
    <section className="my-4 rounded-2xl border border-line bg-canvas/60 p-4">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">{title ?? trace.title}</span>
        <span className="text-xs text-muted">the life of {trace.subject}</span>
      </div>
      {trace.intro && (
        <div className="mt-1 text-sm text-muted">
          <Markdown>{trace.intro}</Markdown>
        </div>
      )}
      <ol className="relative ml-3 mt-3 border-l border-line">
        {trace.steps.map((s, i) => {
          const where = [componentName(s.component), actorName(s.actor)].filter(Boolean).join(' · ')
          const link = concept(s)
          const href = s.sourcePath ? sourceHref(bundle, s.sourcePath) : undefined
          return (
            <li key={s.id} className="mb-4 ml-5 last:mb-0">
              <span className="absolute -left-3 flex h-6 w-6 items-center justify-center rounded-full bg-accent-500 text-xs font-bold text-white">
                {i + 1}
              </span>
              <div className="rounded-lg border border-line bg-surface p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="break-all rounded-md border border-line bg-canvas px-2 py-0.5 font-mono text-[12.5px] text-accent-700">{s.label}</code>
                  {where && <span className="text-xs text-muted">{where}</span>}
                </div>
                {s.note && (
                  <div className="mt-1 text-sm">
                    <Markdown>{s.note}</Markdown>
                  </div>
                )}
                {(link || s.sourcePath) && (
                  <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                    {link && (
                      <Link to={link.to} className="inline-flex items-center gap-1 font-medium text-accent-600 hover:text-accent-700">
                        <ArrowRight className="h-3.5 w-3.5" aria-hidden /> {link.label}
                      </Link>
                    )}
                    {s.sourcePath &&
                      (href ? (
                        <a
                          href={href}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 font-mono text-[11px] text-muted underline decoration-dotted underline-offset-2 hover:text-ink"
                          title="Open the source at the verified commit"
                        >
                          <FileCode2 className="h-3.5 w-3.5" aria-hidden /> {s.sourcePath}
                        </a>
                      ) : (
                        <span className="inline-flex items-center gap-1 font-mono text-[11px] text-muted">
                          <FileCode2 className="h-3.5 w-3.5" aria-hidden /> {s.sourcePath}
                        </span>
                      ))}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>
      {trace.outro && (
        <div className="mt-3 text-sm text-muted">
          <Markdown>{trace.outro}</Markdown>
        </div>
      )}
    </section>
  )
}
