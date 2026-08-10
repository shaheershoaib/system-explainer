import type { Progress } from './progress-types'

// Where the backend lives. Configurable per deployment; defaults to the local dev server.
export const apiBase =
  (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:5175'

/**
 * Best-effort push of a learner's progress to the backend. Failures are swallowed —
 * the app stays fully usable standalone (localStorage is the client source of truth).
 */
export async function syncProgress(systemId: string, p: Progress): Promise<boolean> {
  if (!p.learnerId) return false
  try {
    const res = await fetch(`${apiBase}/api/${encodeURIComponent(systemId)}/progress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ learnerId: p.learnerId, learner: p.learner, modules: p.modules, concepts: p.concepts }),
    })
    return res.ok
  } catch {
    return false
  }
}

export interface DashboardData {
  totals: { learners: number; avgPercent: number }
  learners: { learnerId: string; name?: string; completed: number; total: number; percent: number; lastActive?: number }[]
  moduleCompletion: { moduleId: string; title: string; completed: number; total: number }[]
  stuckPoints: { misconceptionId: string; trap: string; correction: string; moduleId: string; misses: number; learnersAffected: number }[]
  conceptMastery: { misconceptionId: string; trap: string; correction: string; moduleId: string; learners: number; solid: number; shaky: number; avgBox: number }[]
}

export async function fetchDashboard(systemId: string, token: string): Promise<DashboardData> {
  const res = await fetch(`${apiBase}/api/${encodeURIComponent(systemId)}/dashboard`, {
    headers: { 'x-admin-token': token },
  })
  if (res.status === 401) throw new Error('Unauthorized — check the admin token.')
  if (!res.ok) throw new Error(`Dashboard request failed (HTTP ${res.status})`)
  return res.json()
}
