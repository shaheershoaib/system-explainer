import type { DiagramRef, Flow } from '@schema/bundle'
import { useBundle } from '../../lib/useBundle'
import { sourceUrl } from '../../lib/persona'
import { ErDiagram } from './ErDiagram'
import { ContextDiagram } from './ContextDiagram'
import { ArchitectureDiagram } from './ArchitectureDiagram'

// A component's `tech` is clickable only when it's a concrete repo file path: it must
// contain a directory separator AND end in an extension. The `/` requirement rejects
// framework names that merely look like files (e.g. "Next.js", "Vue.js").
const looksLikePath = (tech?: string) => !!tech && tech.includes('/') && /^[\w./-]+\.\w+$/.test(tech)

function FlowDiagram({ flow }: { flow: Flow }) {
  return (
    <ol className="relative ml-3 border-l border-line">
      {flow.steps.map((s, i) => (
        <li key={i} className="mb-4 ml-5">
          <span className="absolute -left-3 flex h-6 w-6 items-center justify-center rounded-full bg-accent-500 text-xs font-bold text-white">
            {i + 1}
          </span>
          <div className="rounded-lg border border-line bg-surface p-3">
            <div className="text-sm font-medium text-ink">{s.label}</div>
            {(s.actor || s.entity || s.note) && (
              <div className="mt-1 text-xs text-muted">
                {[s.actor, s.entity, s.note].filter(Boolean).join(' · ')}
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  )
}

/** Resolves a DiagramRef against the bundle and renders the matching diagram. */
export function Diagram({ dref }: { dref: DiagramRef }) {
  const bundle = useBundle()

  let body: React.ReactNode = null
  if (dref.kind === 'er') {
    const ents = dref.scope ? bundle.entities.filter((e) => dref.scope!.includes(e.id)) : bundle.entities
    body = <ErDiagram entities={ents} title={dref.title} />
  } else if (dref.kind === 'context') {
    const actors = dref.scope ? bundle.actors.filter((a) => dref.scope!.includes(a.id)) : bundle.actors
    body = <ContextDiagram systemName={bundle.system.name} actors={actors} title={dref.title} />
  } else if (dref.kind === 'architecture') {
    body = bundle.architecture ? (
      <ArchitectureDiagram
        architecture={bundle.architecture}
        title={dref.title}
        hrefFor={(tech) => (looksLikePath(tech) ? sourceUrl(bundle, tech!) : undefined)}
      />
    ) : null
  } else {
    const flow = bundle.flows?.find((f) => f.id === dref.flowId)
    body = flow ? <FlowDiagram flow={flow} /> : null
  }
  if (!body) return null

  return (
    <div className="my-4 rounded-2xl border border-line bg-canvas/60 p-3">
      {dref.title && (
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">{dref.title}</div>
      )}
      {body}
    </div>
  )
}
