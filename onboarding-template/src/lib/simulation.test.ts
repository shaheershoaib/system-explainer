import { describe, it, expect } from 'vitest'
import { initState, applyEffects, changedKeys, formatValue } from './simulation'
import type { SimVar } from '@schema/bundle'

const vars: SimVar[] = [
  { key: 'status', label: 'Status', kind: 'text', initial: 'Generated' },
  { key: 'collected', label: 'Collected', kind: 'money', initial: 0 },
  { key: 'remitted', label: 'Remitted', kind: 'money', initial: 0 },
]

describe('initState', () => {
  it('seeds the ledger from variable initials', () => {
    expect(initState(vars)).toEqual({ status: 'Generated', collected: 0, remitted: 0 })
  })
})

describe('applyEffects', () => {
  it('set assigns and add increments', () => {
    const s0 = initState(vars)
    const s1 = applyEffects(s0, [{ set: { status: 'Collected' }, add: { collected: 18000 } }])
    expect(s1.status).toBe('Collected')
    expect(s1.collected).toBe(18000)
  })

  it('is immutable — the original state is untouched', () => {
    const s0 = initState(vars)
    applyEffects(s0, [{ add: { collected: 500 } }])
    expect(s0.collected).toBe(0)
  })

  it('applies multiple effects in order', () => {
    const s = applyEffects(initState(vars), [{ add: { collected: 100 } }, { add: { collected: 50 } }])
    expect(s.collected).toBe(150)
  })

  it('treats add on a non-number as starting from 0', () => {
    const s = applyEffects({ status: 'x' }, [{ add: { status: 5 } as never }])
    expect(s.status).toBe(5)
  })

  it('returns the same state when there are no effects', () => {
    const s0 = initState(vars)
    expect(applyEffects(s0, undefined)).toBe(s0)
  })
})

describe('changedKeys', () => {
  it('lists only keys whose value changed', () => {
    const a = { status: 'A', collected: 0 }
    const b = { status: 'A', collected: 100 }
    expect(changedKeys(a, b)).toEqual(['collected'])
  })
})

describe('formatValue', () => {
  it('formats money as USD with no cents', () => {
    expect(formatValue(17500, 'money')).toBe('$17,500')
  })
  it('passes text/number through as a string', () => {
    expect(formatValue('Delivered', 'text')).toBe('Delivered')
    expect(formatValue(3, 'number')).toBe('3')
  })
})
