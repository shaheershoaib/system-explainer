import { useState } from 'react'
import { Link } from 'react-router'
import { AlertTriangle, ArrowLeft, ClipboardCopy, Users } from 'lucide-react'
import { useBundle } from '../lib/useBundle'
import { fetchDashboard, type DashboardData } from '../lib/sync'

function relTime(ms?: number): string {
  if (!ms) return '—'
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function DashboardPage() {
  const bundle = useBundle()
  const [token, setToken] = useState('')
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  async function load(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      setData(await fetchDashboard(bundle.system.id, token))
    } catch (err) {
      setError(String((err as Error).message))
    } finally {
      setLoading(false)
    }
  }

  function copyGotchas() {
    if (!data) return
    const text = data.stuckPoints
      .map(
        (s) =>
          `- [${s.misses} miss(es), ${s.learnersAffected} learner(s)] Trap: ${s.trap}\n  Correction: ${s.correction}\n  Module: ${s.moduleId}`,
      )
      .join('\n')
    void navigator.clipboard?.writeText(`Candidate gotchas from onboarding (${bundle.system.name}):\n${text}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Course
      </Link>
      <h1 className="mt-3 text-2xl font-bold tracking-tight text-ink">Onboarding dashboard</h1>
      <p className="text-sm text-muted">{bundle.system.name}</p>

      {!data && (
        <form onSubmit={load} className="mt-6 flex max-w-sm gap-2">
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Admin token"
            className="flex-1 rounded-lg border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-accent-400"
          />
          <button disabled={loading || !token} className="rounded-lg bg-accent-500 px-4 py-2 text-sm font-medium text-white enabled:hover:bg-accent-600 disabled:opacity-40">
            {loading ? '…' : 'View'}
          </button>
        </form>
      )}
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}

      {data && (
        <div className="mt-6 space-y-6">
          <div className="grid grid-cols-2 gap-3">
            <Stat icon={<Users className="h-4 w-4" />} label="Learners" value={String(data.totals.learners)} />
            <Stat label="Avg completion" value={`${data.totals.avgPercent}%`} />
          </div>

          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Module completion</h2>
            <div className="space-y-2">
              {data.moduleCompletion.map((m) => (
                <div key={m.moduleId} className="rounded-xl border border-line bg-surface p-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium text-ink">{m.title}</span>
                    <span className="text-muted">
                      {m.completed}/{m.total}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line">
                    <div className="h-full rounded-full bg-accent-500" style={{ width: `${m.total ? (m.completed / m.total) * 100 : 0}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
                Where people get stuck
              </h2>
              {data.stuckPoints.length > 0 && (
                <button onClick={copyGotchas} className="inline-flex items-center gap-1 text-xs text-accent-600 hover:text-accent-700">
                  <ClipboardCopy className="h-3.5 w-3.5" aria-hidden /> {copied ? 'Copied' : 'Copy as candidate gotchas'}
                </button>
              )}
            </div>
            {data.stuckPoints.length === 0 ? (
              <p className="rounded-xl border border-line bg-surface p-3 text-sm text-muted">No misconception misses recorded yet.</p>
            ) : (
              <ul className="space-y-2">
                {data.stuckPoints.map((s) => (
                  <li key={s.misconceptionId} className="rounded-xl border border-amber-300 bg-amber-50 p-3">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium text-ink">{s.trap}</span>
                          <span className="shrink-0 rounded-full bg-amber-200 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                            {s.misses} miss{s.misses === 1 ? '' : 'es'} · {s.learnersAffected} learner{s.learnersAffected === 1 ? '' : 's'}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-muted">Fix: {s.correction}</p>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {data.conceptMastery.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Concept mastery (team)</h2>
              <ul className="space-y-2">
                {data.conceptMastery.map((c) => (
                  <li key={c.misconceptionId} className="rounded-xl border border-line bg-surface p-3">
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span className="font-medium text-ink">{c.trap}</span>
                      <span className="shrink-0 text-xs text-muted">
                        avg box {c.avgBox} · {c.learners} learner{c.learners === 1 ? '' : 's'}
                      </span>
                    </div>
                    <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-line">
                      <div className="h-full bg-emerald-500" style={{ width: `${c.learners ? (c.solid / c.learners) * 100 : 0}%` }} />
                      <div className="h-full bg-amber-400" style={{ width: `${c.learners ? (c.shaky / c.learners) * 100 : 0}%` }} />
                    </div>
                    <p className="mt-1 text-xs text-muted">{c.solid} solid · {c.shaky} shaky</p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Learners</h2>
            <div className="overflow-hidden rounded-xl border border-line">
              <table className="w-full text-sm">
                <thead className="bg-canvas text-left text-xs text-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Progress</th>
                    <th className="px-3 py-2 font-medium">Last active</th>
                  </tr>
                </thead>
                <tbody>
                  {data.learners.map((l) => (
                    <tr key={l.learnerId} className="border-t border-line">
                      <td className="px-3 py-2 text-ink">{l.name ?? l.learnerId.slice(0, 8)}</td>
                      <td className="px-3 py-2 text-muted">
                        {l.completed}/{l.total} ({l.percent}%)
                      </td>
                      <td className="px-3 py-2 text-muted">{relTime(l.lastActive)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

function Stat({ icon, label, value }: { icon?: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted">
        {icon} {label}
      </div>
      <div className="mt-1 text-2xl font-bold text-ink">{value}</div>
    </div>
  )
}
