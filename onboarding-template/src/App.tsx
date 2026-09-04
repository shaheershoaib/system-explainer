import { lazy, Suspense, useEffect, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { BundleProvider, useBundle, useBundleState } from './lib/useBundle'
import { HomePage } from './pages/HomePage'
import { ModulePage } from './pages/ModulePage'
import { LearnerGate, ProgressSync } from './components/LearnerGate'

const ReviewPage = lazy(() => import('./pages/ReviewPage').then((m) => ({ default: m.ReviewPage })))
const DashboardPage = lazy(() => import('./pages/DashboardPage').then((m) => ({ default: m.DashboardPage })))

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center p-8 text-center">{children}</div>
}

/** Renders the router only once a valid bundle is loaded; applies per-system theme. */
function Course() {
  const bundle = useBundle()
  useEffect(() => {
    document.title = `${bundle.system.name} — Onboarding`
    if (bundle.theme?.accent) {
      document.documentElement.style.setProperty('--color-accent-500', bundle.theme.accent)
    }
  }, [bundle])
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <ProgressSync />
      <Suspense fallback={<Centered>Loading...</Centered>}>
        <Routes>
          <Route path="/" element={<LearnerGate><HomePage /></LearnerGate>} />
          <Route path="/module/:moduleId" element={<LearnerGate><ModulePage /></LearnerGate>} />
          <Route path="/review" element={<LearnerGate><ReviewPage /></LearnerGate>} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}

function Gate() {
  const state = useBundleState()
  if (state.status === 'loading') return <Centered><span className="text-muted">Loading course…</span></Centered>
  if (state.status === 'error')
    return (
      <Centered>
        <div className="max-w-md">
          <p className="font-semibold text-bad">Couldn’t load the course bundle.</p>
          <p className="mt-2 text-sm text-muted">
            Run <code className="rounded bg-canvas px-1 py-0.5 font-mono">npm run generate -- --system &lt;name&gt;</code> to
            produce <code className="rounded bg-canvas px-1 py-0.5 font-mono">public/bundle.json</code>.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-canvas p-2 text-left text-xs text-muted">{state.error}</pre>
        </div>
      </Centered>
    )
  return <Course />
}

export function App() {
  return (
    <BundleProvider>
      <Gate />
    </BundleProvider>
  )
}
