import clsx from 'clsx'
import { Link } from 'react-router'
import { AlertTriangle, FileCode2, Info, Lightbulb, ShieldAlert } from 'lucide-react'
import type { Block } from '@schema/bundle'
import { Markdown } from '../Markdown'
import { Diagram } from '../diagrams/Diagram'
import { PredictReveal } from './PredictReveal'
import { Exercise } from './Exercise'
import { SimulationPlayer } from '../sim/SimulationPlayer'
import { ScreenWalkthrough } from '../screen/ScreenWalkthrough'
import { useBundle } from '../../lib/useBundle'
import { sourceUrl } from '../../lib/persona'

export function BlockRenderer({ block }: { block: Block }) {
  switch (block.type) {
    case 'prose':
      return (
        <div className="my-2">
          {block.heading && <h3 className="mb-1 text-base font-semibold text-ink">{block.heading}</h3>}
          <Markdown>{block.md}</Markdown>
        </div>
      )
    case 'mental-model':
      return <MentalModel entities={block.entities} verbs={block.verbs} md={block.md} heading={block.heading} />
    case 'predict-reveal':
      return <PredictReveal prompt={block.prompt} hint={block.hint} reveal={block.reveal} />
    case 'diagram':
      return <Diagram dref={block.diagram} />
    case 'code':
      return <CodeSample {...block} />
    case 'worked-example':
      return <WorkedExample title={block.title} steps={block.steps} />
    case 'callout':
      return <Callout variant={block.variant} md={block.md} smeQuestion={block.smeQuestion} />
    case 'simulation':
      return <SimulationPlayer simulationId={block.simulationId} />
    case 'screen':
      return <ScreenWalkthrough screenId={block.screenId} />
    case 'code-map':
      return <CodeMap title={block.title} entries={block.entries} />
    case 'decisions':
      return <Decisions title={block.title} items={block.items} />
    case 'sources':
      return <Sources title={block.title} items={block.items} />
    case 'exercise':
      return <Exercise kind={block.kind} prompt={block.prompt} hint={block.hint} files={block.files} modelAnswer={block.modelAnswer} />
  }
}

function CodeMap({
  title,
  entries,
}: {
  title?: string
  entries: { label: string; entity?: string; verb?: string; files: { path: string; role?: string }[] }[]
}) {
  const bundle = useBundle()
  const moduleForEntity = (id?: string) => (id ? bundle.modules.find((m) => m.entitiesIntroduced?.includes(id)) : undefined)
  return (
    <div className="my-4 rounded-2xl border border-line bg-surface p-4">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{title ?? 'Where it lives in the code'}</div>
      <div className="space-y-3">
        {entries.map((e, i) => {
          const m = moduleForEntity(e.entity)
          return (
            <div key={i}>
              <div className="flex items-center gap-2">
                <span className="font-medium text-ink">{e.label}</span>
                {m && (
                  <Link to={`/module/${m.id}`} className="text-xs text-accent-600 hover:text-accent-700">
                    ↳ concept
                  </Link>
                )}
              </div>
              <ul className="mt-1 space-y-0.5">
                {e.files.map((f, j) => {
                  const href = sourceUrl(bundle, f.path)
                  const code = (
                    <code className={clsx('rounded bg-canvas px-1 py-0.5 font-mono text-[12.5px] text-accent-700', href && 'hover:bg-accent-100')}>
                      {f.path}
                    </code>
                  )
                  return (
                    <li key={j} className="flex flex-wrap items-baseline gap-2 text-sm">
                      {href ? (
                        <a href={href} target="_blank" rel="noreferrer" className="no-underline" title="Open in the repo">{code}</a>
                      ) : (
                        code
                      )}
                      {f.role && <span className="text-xs text-muted">{f.role}</span>}
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const DEC_STATUS = {
  locked: { label: 'Locked', cls: 'bg-emerald-100 text-emerald-700' },
  recommendation: { label: 'Recommendation', cls: 'bg-sky-100 text-sky-700' },
  'open-question': { label: 'Open question', cls: 'bg-amber-100 text-amber-700' },
} as const

function Decisions({
  title,
  items,
}: {
  title?: string
  items: { title: string; rationale: string; status: keyof typeof DEC_STATUS; sme?: string }[]
}) {
  return (
    <div className="my-4 rounded-2xl border border-line bg-surface p-4">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{title ?? 'Design decisions & open questions'}</div>
      <div className="space-y-3">
        {items.map((d, i) => (
          <div key={i} className="border-l-2 border-line pl-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-ink">{d.title}</span>
              <span className={clsx('rounded-full px-2 py-0.5 text-[10px] font-semibold', DEC_STATUS[d.status].cls)}>{DEC_STATUS[d.status].label}</span>
            </div>
            <div className="mt-0.5 text-sm text-muted">
              <Markdown>{d.rationale}</Markdown>
            </div>
            {d.sme && <div className="mt-1 text-xs text-muted"><span className="font-semibold">SME:</span> {d.sme}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}

const SRC_KIND: Record<string, string> = { story: 'Story', doc: 'Doc', sme: 'SME', code: 'Code' }

function Sources({
  title,
  items,
}: {
  title?: string
  items: { label: string; kind: string; detail?: string; ref?: string }[]
}) {
  return (
    <div className="my-3 rounded-xl border border-line bg-canvas/50 p-3">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">{title ?? 'Where this comes from'}</div>
      <ul className="space-y-1">
        {items.map((s, i) => (
          <li key={i} className="flex flex-wrap items-baseline gap-2 text-sm">
            <span className="rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] font-semibold text-muted">{SRC_KIND[s.kind] ?? s.kind}</span>
            <span className="text-ink">{s.label}</span>
            {s.detail && <span className="text-xs text-muted">— {s.detail}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

function MentalModel({
  entities,
  verbs,
  md,
  heading,
}: {
  entities: string[]
  verbs?: string[]
  md?: string
  heading?: string
}) {
  const bundle = useBundle()
  const nameOf = (id: string) => bundle.entities.find((e) => e.id === id)?.name ?? id
  const verbName = (id: string) => bundle.verbs?.find((v) => v.id === id)?.name ?? id
  return (
    <div className="my-4 rounded-2xl border border-accent-200 bg-accent-50/40 p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-accent-700">
        {heading ?? 'Hold this in your head'}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {entities.map((id, i) => (
          <span key={id} className="inline-flex items-center gap-1.5">
            <span className="rounded-lg border border-accent-200 bg-surface px-2.5 py-1 text-sm font-medium text-ink">
              {nameOf(id)}
            </span>
            {i < entities.length - 1 && <span className="text-accent-400">→</span>}
          </span>
        ))}
      </div>
      {verbs && verbs.length > 0 && (
        <div className="mt-2 text-xs text-muted">Operations: {verbs.map(verbName).join(' · ')}</div>
      )}
      {md && (
        <div className="mt-1 text-sm text-muted">
          <Markdown>{md}</Markdown>
        </div>
      )}
    </div>
  )
}

function CodeSample({
  code,
  language,
  caption,
  sourcePath,
  highlightLines,
  lineRange,
}: {
  code: string
  language: string
  caption?: string
  sourcePath?: string
  highlightLines?: number[]
  lineRange?: { start: number; end: number }
}) {
  const bundle = useBundle()
  const hl = new Set(highlightLines ?? [])
  const lines = code.replace(/\n$/, '').split('\n')
  // Exact-verified snippets carry the source line range — deep-link to the very lines.
  const href = sourcePath
    ? (() => {
        const base = sourceUrl(bundle, sourcePath)
        return base ? `${base}${lineRange ? `#L${lineRange.start}-L${lineRange.end}` : ''}` : undefined
      })()
    : undefined
  const pathLabel = `${sourcePath ?? ''}${lineRange ? `:${lineRange.start}-${lineRange.end}` : ''}`
  return (
    <figure className="my-4 overflow-hidden rounded-xl border border-line">
      {(caption || sourcePath) && (
        <figcaption className="flex items-center justify-between gap-2 border-b border-line bg-canvas px-3 py-1.5 text-xs text-muted">
          <span>{caption}</span>
          {sourcePath &&
            (href ? (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-mono text-[11px] underline decoration-dotted underline-offset-2 hover:text-ink"
                title={lineRange ? `Open the exact source lines ${lineRange.start}–${lineRange.end}` : 'Open the source file'}
              >
                <FileCode2 className="h-3.5 w-3.5" aria-hidden /> {pathLabel}
              </a>
            ) : (
              <span className="inline-flex items-center gap-1 font-mono text-[11px]">
                <FileCode2 className="h-3.5 w-3.5" aria-hidden /> {pathLabel}
              </span>
            ))}
        </figcaption>
      )}
      <pre className="overflow-x-auto bg-[#1b1b22] py-2 text-[12.5px] leading-relaxed text-[#e7e7ef]" data-language={language}>
        <code>
          {lines.map((ln, i) => (
            <div key={i} className={clsx('px-3', hl.has(i + 1) && 'bg-accent-500/25')}>
              <span className="mr-3 inline-block w-6 select-none text-right text-white/30">{i + 1}</span>
              {ln || ' '}
            </div>
          ))}
        </code>
      </pre>
    </figure>
  )
}

function WorkedExample({
  title,
  steps,
}: {
  title: string
  steps: { label: string; compute?: string; note?: string }[]
}) {
  return (
    <div className="my-4 rounded-2xl border border-line bg-surface p-4">
      <div className="mb-2 text-sm font-semibold text-ink">{title}</div>
      <ol className="space-y-2">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-3">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-100 text-[11px] font-bold text-accent-700">
              {i + 1}
            </span>
            <div className="min-w-0">
              <div className="text-sm text-ink/90">{s.label}</div>
              {s.compute && (
                <div className="mt-1 inline-block rounded bg-canvas px-2 py-1 font-mono text-[13px] text-accent-700">
                  {s.compute}
                </div>
              )}
              {s.note && <div className="mt-1 text-xs text-muted">{s.note}</div>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

const CALLOUT = {
  gotcha: { icon: AlertTriangle, cls: 'border-amber-300 bg-amber-50', tint: 'text-amber-700', label: 'Gotcha' },
  warning: { icon: ShieldAlert, cls: 'border-red-300 bg-red-50', tint: 'text-red-700', label: 'Watch out' },
  note: { icon: Info, cls: 'border-sky-200 bg-sky-50', tint: 'text-sky-700', label: 'Note' },
  tip: { icon: Lightbulb, cls: 'border-emerald-200 bg-emerald-50', tint: 'text-emerald-700', label: 'Tip' },
} as const

function Callout({
  variant,
  md,
  smeQuestion,
}: {
  variant: keyof typeof CALLOUT
  md: string
  smeQuestion?: string
}) {
  const c = CALLOUT[variant]
  const Icon = c.icon
  return (
    <div className={clsx('my-3 flex gap-3 rounded-xl border p-3', c.cls)}>
      <Icon className={clsx('mt-0.5 h-5 w-5 shrink-0', c.tint)} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className={clsx('text-[11px] font-semibold uppercase tracking-wide', c.tint)}>{c.label}</div>
        <div className="mt-0.5 text-sm">
          <Markdown>{md}</Markdown>
        </div>
        {smeQuestion && (
          <div className="mt-2 rounded-lg border border-dashed border-current/30 px-2 py-1 text-xs text-muted">
            <span className="font-semibold">SME question:</span> {smeQuestion}
          </div>
        )}
      </div>
    </div>
  )
}
