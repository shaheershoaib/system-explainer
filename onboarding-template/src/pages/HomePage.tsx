import { Link } from 'react-router'
import { ArrowRight, BadgeCheck, CircleCheck, Clock, Lock, Map, RefreshCw, ShieldCheck } from 'lucide-react'
import { useBundle } from '../lib/useBundle'
import { audienceOf, AUDIENCE_LABEL } from '../lib/persona'
import { completedModuleIds, conceptsDue, moduleUnlocked, useProgress } from '../lib/progress'
import { Layout } from '../components/Layout'
import { Diagram } from '../components/diagrams/Diagram'

const DEPTH_LABEL: Record<string, string> = { L1: 'Orientation', L2: 'Working knowledge', L3: 'Contributor depth' }

export function HomePage() {
  const bundle = useBundle()
  const { progress } = useProgress(bundle.system.id)
  const completed = completedModuleIds(progress)
  const modules = [...bundle.modules].sort((a, b) => a.order - b.order)
  const titleOf = (id: string) => bundle.modules.find((m) => m.id === id)?.title ?? id
  const grounding = bundle.provenance?.grounding
  const reviewedBy = bundle.provenance?.review?.reviewedBy
  const due = conceptsDue(progress.concepts, Date.now())

  return (
    <Layout>
      <section className="mb-7">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight text-ink">{bundle.system.name}</h1>
          {bundle.system.depth && (
            <span className="rounded-full bg-accent-50 px-2 py-0.5 text-[11px] font-semibold text-accent-700">
              {DEPTH_LABEL[bundle.system.depth]}
            </span>
          )}
          <span className="rounded-full border border-line bg-surface px-2 py-0.5 text-[11px] font-semibold text-muted">
            {AUDIENCE_LABEL[audienceOf(bundle)]}
          </span>
          {grounding && grounding.total > 0 && (
            <span
              title={`${grounding.verified}/${grounding.total} code snippets verified against ${grounding.repoRef ?? 'source'}${grounding.drifted ? ` · ${grounding.drifted} drifted` : ''}`}
              className={[
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
                grounding.drifted ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800',
              ].join(' ')}
            >
              <ShieldCheck className="h-3 w-3" aria-hidden />
              {grounding.verified}/{grounding.total} verified{grounding.exact ? ` · ${grounding.exact} exact` : ''}{grounding.drifted ? ` · ${grounding.drifted} drift` : ''}
            </span>
          )}
          {reviewedBy && (
            <span
              title={`Reviewed by ${reviewedBy}`}
              className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-800"
            >
              <BadgeCheck className="h-3 w-3" aria-hidden /> Human-verified
            </span>
          )}
        </div>
        <p className="mt-2 text-[15px] leading-relaxed text-muted">
          {bundle.system.elevatorPitch ?? bundle.system.oneLiner}
        </p>
        {bundle.provenance?.sourceLicense && (
          <p className="mt-1.5 text-[11px] text-muted/80">
            Contains code excerpts from {grounding?.repoRef ?? 'the source repository'} · {bundle.provenance.sourceLicense}
          </p>
        )}
      </section>

      <SystemMap />


      {due.length > 0 && (
        <Link
          to="/review"
          className="mb-5 flex items-center gap-3 rounded-2xl border border-accent-200 bg-accent-50/60 p-4 transition-colors hover:border-accent-300"
        >
          <RefreshCw className="h-5 w-5 shrink-0 text-accent-600" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-ink">
              {due.length} concept{due.length === 1 ? '' : 's'} due for review
            </div>
            <div className="text-xs text-muted">A quick spaced refresh of what you’ve missed or are still learning.</div>
          </div>
          <ArrowRight className="h-4 w-4 shrink-0 text-accent-600" aria-hidden />
        </Link>
      )}

      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
        {modules.length} module{modules.length === 1 ? '' : 's'}
      </h2>

      <ol className="space-y-3">
        {modules.map((m) => {
          const done = completed.has(m.id)
          const unlocked = moduleUnlocked(m.id, modules, completed)
          const missing = (m.prerequisites ?? []).filter((p) => !completed.has(p))

          const inner = (
            <div
              className={[
                'group flex items-start gap-4 rounded-2xl border p-4 transition-all',
                unlocked ? 'border-line bg-surface hover:border-accent-300 hover:shadow-sm' : 'border-line bg-canvas',
              ].join(' ')}
            >
              <div
                className={[
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-sm font-bold',
                  done ? 'bg-good text-white' : unlocked ? 'bg-accent-500 text-white' : 'bg-line text-muted',
                ].join(' ')}
              >
                {done ? <CircleCheck className="h-5 w-5" aria-hidden /> : unlocked ? m.order : <Lock className="h-4 w-4" aria-hidden />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-ink">{m.title}</h3>
                  {done && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">Done</span>}
                </div>
                <p className="mt-0.5 text-sm text-muted">{m.objective}</p>
                <div className="mt-2 flex items-center gap-3 text-xs text-muted">
                  {m.estMinutes && (
                    <span className="inline-flex items-center gap-1">
                      <Clock className="h-3.5 w-3.5" aria-hidden /> {m.estMinutes} min
                    </span>
                  )}
                  {!unlocked && missing.length > 0 && <span>Finish {missing.map(titleOf).join(', ')} first</span>}
                </div>
              </div>
              {unlocked && <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-accent-600" aria-hidden />}
            </div>
          )

          return (
            <li key={m.id}>
              {unlocked ? <Link to={`/module/${m.id}`}>{inner}</Link> : <div aria-disabled>{inner}</div>}
            </li>
          )
        })}
      </ol>

      {bundle.system.outOfScope && bundle.system.outOfScope.length > 0 && (
        <details className="mt-6 rounded-xl border border-line bg-surface p-4">
          <summary className="cursor-pointer text-sm font-medium text-ink">What this system is not</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
            {bundle.system.outOfScope.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </details>
      )}
    </Layout>
  )
}

/**
 * The system at a glance — the whole-system map as the landing hero (the instantly-explorable
 * artifact, not buried inside lesson N). ER always (when relationships exist); the architecture
 * diagram for developer audiences (its nodes click through to pinned source).
 */
function SystemMap() {
  const bundle = useBundle()
  const related = bundle.entities.filter((e) => (e.relationships?.length ?? 0) > 0)
  const erScope =
    bundle.entities.length <= 18
      ? bundle.entities.map((e) => e.id)
      : [...new Set(related.flatMap((e) => [e.id, ...(e.relationships ?? []).map((r) => r.to)]))]
  const showEr = related.length >= 2
  const showArch = !!bundle.architecture && audienceOf(bundle) !== 'non-technical'
  if (!showEr && !showArch) return null
  return (
    <section className="mb-7">
      <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
        <Map className="h-3.5 w-3.5" aria-hidden /> The system at a glance
      </h2>
      <div className="space-y-4">
        {showEr && <Diagram dref={{ kind: 'er', title: 'Data model', scope: erScope }} />}
        {showArch && <Diagram dref={{ kind: 'architecture', title: 'Architecture' }} />}
      </div>
    </section>
  )
}
