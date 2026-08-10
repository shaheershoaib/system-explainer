import type { SimEffect, SimVar } from '@schema/bundle'

export type SimState = Record<string, string | number>

/** Build the starting ledger from a simulation's declared variables. */
export function initState(variables: SimVar[]): SimState {
  const s: SimState = {}
  for (const v of variables) s[v.key] = v.initial
  return s
}

/**
 * Apply declarative effects to the ledger, returning a NEW state (immutable).
 * `set` assigns; `add` increments a numeric variable (non-numbers treated as 0).
 * No code eval — effects are pure data, which is what keeps simulations safe and
 * generic across systems.
 */
export function applyEffects(state: SimState, effects?: SimEffect[]): SimState {
  if (!effects?.length) return state
  const next: SimState = { ...state }
  for (const e of effects) {
    if (e.set) for (const [k, v] of Object.entries(e.set)) next[k] = v
    if (e.add) for (const [k, v] of Object.entries(e.add)) next[k] = (typeof next[k] === 'number' ? next[k] : 0) + v
  }
  return next
}

/** Keys whose value changed between two states — drives the "flash on change" UI. */
export function changedKeys(before: SimState, after: SimState): string[] {
  return Object.keys(after).filter((k) => before[k] !== after[k])
}

export function formatValue(value: string | number, kind: SimVar['kind']): string {
  if (kind === 'money') {
    const n = typeof value === 'number' ? value : Number(value) || 0
    return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
  }
  return String(value)
}
