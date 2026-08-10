import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { OnboardingBundle } from '@schema/bundle'
import { validateBundle } from '../../generator/validate'

type State =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; bundle: OnboardingBundle }

const BundleCtx = createContext<State>({ status: 'loading' })

/** Loads /bundle.json (the active per-deployment bundle) and re-validates it client-side. */
export function BundleProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading' })
  useEffect(() => {
    let alive = true
    fetch(import.meta.env.BASE_URL + 'bundle.json')
      .then((r) => {
        if (!r.ok) throw new Error(`Could not load bundle.json (HTTP ${r.status})`)
        return r.json()
      })
      .then((json) => {
        if (!alive) return
        const res = validateBundle(json)
        if (res.ok) setState({ status: 'ready', bundle: res.bundle })
        else setState({ status: 'error', error: res.errors.slice(0, 6).join(' · ') })
      })
      .catch((e) => alive && setState({ status: 'error', error: String(e?.message ?? e) }))
    return () => {
      alive = false
    }
  }, [])
  return <BundleCtx.Provider value={state}>{children}</BundleCtx.Provider>
}

export const useBundleState = () => useContext(BundleCtx)

/** Convenience accessor for components rendered only inside the ready state. */
export function useBundle(): OnboardingBundle {
  const s = useContext(BundleCtx)
  if (s.status !== 'ready') throw new Error('useBundle() called outside a ready BundleProvider')
  return s.bundle
}
