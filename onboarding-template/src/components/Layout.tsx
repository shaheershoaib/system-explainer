import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { RefreshCw, RotateCcw } from 'lucide-react'
import { useBundle } from '../lib/useBundle'
import { conceptsDue, overallPercent, useProgress } from '../lib/progress'

export function Layout({ children }: { children: ReactNode }) {
  const bundle = useBundle()
  const { progress, reset } = useProgress(bundle.system.id)
  const pct = overallPercent(bundle.modules, progress)
  const due = conceptsDue(progress.concepts, Date.now()).length
  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-10 border-b border-line bg-surface/80 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          <Link to="/" className="font-semibold text-ink">
            {bundle.system.name}
          </Link>
          <span className="rounded-full bg-accent-50 px-2 py-0.5 text-xs font-medium text-accent-700">Onboarding</span>
          <div className="ml-auto flex items-center gap-3">
            {due > 0 && (
              <Link
                to="/review"
                className="inline-flex items-center gap-1 rounded-full bg-accent-50 px-2 py-0.5 text-xs font-medium text-accent-700 transition-colors hover:bg-accent-100"
                title={`${due} concept${due === 1 ? '' : 's'} due for review`}
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Review {due}
              </Link>
            )}
            <div className="hidden items-center gap-2 sm:flex">
              <div className="h-1.5 w-28 overflow-hidden rounded-full bg-line">
                <div className="h-full rounded-full bg-accent-500 transition-all" style={{ width: `${pct}%` }} />
              </div>
              <span className="w-8 text-right text-xs text-muted">{pct}%</span>
            </div>
            <button
              onClick={() => {
                if (confirm('Reset your progress for this course?')) reset()
              }}
              className="text-muted transition-colors hover:text-ink"
              title="Reset progress"
              aria-label="Reset progress"
            >
              <RotateCcw className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6">{children}</main>
    </div>
  )
}
