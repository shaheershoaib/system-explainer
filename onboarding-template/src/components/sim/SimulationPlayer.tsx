import { useState } from 'react'
import clsx from 'clsx'
import { CircleCheck, RotateCcw, Trophy } from 'lucide-react'
import type { Simulation } from '@schema/bundle'
import { useBundle } from '../../lib/useBundle'
import { Markdown } from '../Markdown'
import { applyEffects, changedKeys, formatValue, initState, type SimState } from '../../lib/simulation'

interface PlayerState {
  stepIndex: number
  state: SimState
  chosen: string | null
  changed: string[]
  done: boolean
}

function makeInit(sim: Simulation): PlayerState {
  const base = initState(sim.variables)
  const s0 = sim.steps[0]
  if (s0 && !s0.decision) {
    const next = applyEffects(base, s0.effects)
    return { stepIndex: 0, state: next, chosen: null, changed: changedKeys(base, next), done: false }
  }
  return { stepIndex: 0, state: base, chosen: null, changed: [], done: false }
}

/** Runs a guided walkthrough simulation: a step backbone with decisions, plus a
 *  live ledger whose values flash when a step or choice mutates them. */
export function SimulationPlayer({ simulationId }: { simulationId: string }) {
  const bundle = useBundle()
  const sim = bundle.simulations?.find((s) => s.id === simulationId)
  const [ps, setPs] = useState<PlayerState>(() =>
    sim ? makeInit(sim) : { stepIndex: 0, state: {}, chosen: null, changed: [], done: false },
  )
  if (!sim) return null

  const actorName = (id?: string) => (id ? bundle.actors.find((a) => a.id === id)?.name ?? id : '')
  const step = sim.steps[ps.stepIndex]
  const isDecision = !!step?.decision
  const chosenOpt = step?.decision?.options.find((o) => o.id === ps.chosen)
  const isLast = ps.stepIndex === sim.steps.length - 1
  const canAdvance = !isDecision || !!ps.chosen

  const choose = (optId: string) =>
    setPs((prev) => {
      if (prev.chosen || !step?.decision) return prev
      const opt = step.decision.options.find((o) => o.id === optId)
      if (!opt) return prev
      const next = applyEffects(prev.state, opt.effects)
      return { ...prev, chosen: optId, state: next, changed: changedKeys(prev.state, next) }
    })

  const advance = () =>
    setPs((prev) => {
      const ni = prev.stepIndex + 1
      if (ni >= sim.steps.length) return { ...prev, done: true, changed: [] }
      const st = sim.steps[ni]
      if (st.decision) return { stepIndex: ni, state: prev.state, chosen: null, changed: [], done: false }
      const next = applyEffects(prev.state, st.effects)
      return { stepIndex: ni, state: next, chosen: null, changed: changedKeys(prev.state, next), done: false }
    })

  const reset = () => setPs(makeInit(sim))

  return (
    <div className="my-4 overflow-hidden rounded-2xl border border-accent-200">
      <div className="border-b border-accent-200 bg-accent-50/60 px-4 py-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-accent-700">Simulation</div>
        <h4 className="text-base font-semibold text-ink">{sim.title}</h4>
        <p className="text-sm text-muted">{sim.subject}</p>
      </div>

      <div className="grid md:grid-cols-[1fr_240px]">
        {/* step pane */}
        <div className="border-b border-line p-4 md:border-b-0 md:border-r">
          {!ps.done && step && (
            <>
              <div className="mb-2 flex items-center gap-2 text-xs text-muted">
                <span className="shrink-0">
                  Step {ps.stepIndex + 1} of {sim.steps.length}
                </span>
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-line">
                  <div className="h-full bg-accent-500 transition-all" style={{ width: `${((ps.stepIndex + 1) / sim.steps.length) * 100}%` }} />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <h5 className="font-semibold text-ink">{step.title}</h5>
                {step.actor && <span className="rounded-full bg-canvas px-2 py-0.5 text-[11px] text-muted">{actorName(step.actor)}</span>}
              </div>
              <div className="mt-1 text-sm">
                <Markdown>{step.narrative}</Markdown>
              </div>
              {!isDecision && step.effects?.some((e) => e.note) && (
                <div className="mt-2 space-y-1">
                  {step.effects.filter((e) => e.note).map((e, i) => (
                    <div key={i} className="text-xs text-accent-700">→ {e.note}</div>
                  ))}
                </div>
              )}
              {isDecision && step.decision && (
                <div className="mt-3">
                  <p className="text-sm font-medium text-ink">{step.decision.prompt}</p>
                  <div className="mt-2 space-y-2">
                    {step.decision.options.map((o) => {
                      const picked = ps.chosen === o.id
                      return (
                        <button
                          key={o.id}
                          onClick={() => choose(o.id)}
                          disabled={!!ps.chosen}
                          className={clsx(
                            'flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                            !ps.chosen && 'border-line hover:border-accent-400 hover:bg-accent-50/50',
                            ps.chosen && picked && 'border-accent-500 bg-accent-50',
                            ps.chosen && !picked && 'border-line opacity-50',
                          )}
                        >
                          {picked && <CircleCheck className="h-4 w-4 shrink-0 text-accent-600" aria-hidden />}
                          <span>{o.label}</span>
                        </button>
                      )
                    })}
                  </div>
                  {chosenOpt && (
                    <div className="mt-2 rounded-lg border border-line bg-canvas p-3 text-sm">
                      <Markdown>{chosenOpt.outcome}</Markdown>
                      {chosenOpt.effects?.filter((e) => e.note).map((e, i) => (
                        <div key={i} className="mt-1 text-xs text-accent-700">→ {e.note}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <button
                onClick={advance}
                disabled={!canAdvance}
                className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-accent-500 px-4 py-1.5 text-sm font-medium text-white enabled:hover:bg-accent-600 disabled:opacity-40"
              >
                {isLast ? (
                  <>
                    <Trophy className="h-4 w-4" aria-hidden /> Finish
                  </>
                ) : (
                  'Next'
                )}
              </button>
            </>
          )}
          {ps.done && (
            <div>
              <div className="flex items-center gap-2">
                <Trophy className="h-5 w-5 text-good" aria-hidden />
                <span className="font-semibold text-ink">Simulation complete</span>
              </div>
              {sim.outro && (
                <div className="mt-2 text-sm">
                  <Markdown>{sim.outro}</Markdown>
                </div>
              )}
              <button onClick={reset} className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink hover:border-accent-300">
                <RotateCcw className="h-4 w-4" aria-hidden /> Run it again
              </button>
            </div>
          )}
        </div>

        {/* live ledger */}
        <div className="bg-canvas/50 p-4">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Ledger</div>
          <dl className="space-y-1.5">
            {sim.variables.map((v) => {
              const flash = ps.changed.includes(v.key)
              return (
                <div
                  key={v.key}
                  className={clsx('flex items-baseline justify-between gap-2 rounded px-2 py-1 transition-colors', flash ? 'bg-accent-100' : 'bg-transparent')}
                >
                  <dt className="text-xs text-muted">{v.label}</dt>
                  <dd className={clsx('font-mono text-sm text-ink', v.kind === 'money' && 'font-semibold')}>{formatValue(ps.state[v.key], v.kind)}</dd>
                </div>
              )
            })}
          </dl>
        </div>
      </div>
    </div>
  )
}
