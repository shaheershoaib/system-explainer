import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useBundle } from '../lib/useBundle'
import { useProgress } from '../lib/progress'
import { hasApi, syncProgress } from '../lib/sync'

/** Asks for a name once (so a lead can see progress), then renders the course. */
export function LearnerGate({ children }: { children: ReactNode }) {
  const bundle = useBundle()
  const { progress, setLearner } = useProgress(bundle.system.id)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')

  // Static deployments have no progress backend to report a name to, so skip the form
  // and identify the learner as a guest automatically.
  useEffect(() => {
    if (!hasApi && !progress.learner?.name) setLearner({ name: 'Guest' })
  }, [progress.learner?.name, setLearner])

  if (progress.learner?.name) return <>{children}</>
  if (!hasApi) return null

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) setLearner({ name: name.trim(), email: email.trim() || undefined })
        }}
        className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6 shadow-sm"
      >
        <h1 className="text-lg font-semibold text-ink">Welcome to {bundle.system.name} onboarding</h1>
        <p className="mt-1 text-sm text-muted">
          Tell us who you are so your onboarding lead can follow along.{' '}
          {hasApi ? 'This stays on your device and syncs to the team dashboard.' : 'Your progress stays in this browser.'}
        </p>
        <label className="mt-4 block text-sm font-medium text-ink">Your name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          className="mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-accent-400"
          placeholder="Jordan Rivera"
        />
        <label className="mt-3 block text-sm font-medium text-ink">Email (optional)</label>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-accent-400"
          placeholder="jordan@company.com"
        />
        <button
          type="submit"
          disabled={!name.trim()}
          className="mt-5 w-full rounded-lg bg-accent-500 px-4 py-2 text-sm font-medium text-white enabled:hover:bg-accent-600 disabled:opacity-40"
        >
          Start learning
        </button>
        <button
          type="button"
          onClick={() => setLearner({ name: 'Guest' })}
          className="mt-2 w-full rounded-lg border border-line px-4 py-2 text-sm font-medium text-ink hover:border-accent-300"
        >
          Continue as guest
        </button>
      </form>
    </div>
  )
}

/** Debounced, best-effort push of progress to the backend whenever it changes. */
export function ProgressSync() {
  const bundle = useBundle()
  const { progress } = useProgress(bundle.system.id)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    if (!progress.learnerId) return
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void syncProgress(bundle.system.id, progress), 600)
    return () => clearTimeout(timer.current)
  }, [progress, bundle.system.id])
  return null
}
