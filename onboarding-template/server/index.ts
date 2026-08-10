import express from 'express'
import cors from 'cors'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { fileStore } from './store'
import { aggregateDashboard, type LearnerRecord } from './aggregate'
import { OnboardingBundleSchema, type OnboardingBundle } from '../schema/bundle'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const PORT = Number(process.env.PORT) || 5175
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'demo-admin'

function loadBundle(system: string): OnboardingBundle | null {
  const p = path.join(root, 'bundles', system, 'bundle.json')
  if (!existsSync(p)) return null
  try {
    return OnboardingBundleSchema.parse(JSON.parse(readFileSync(p, 'utf8')))
  } catch {
    return null
  }
}

const ProgressPayload = z.object({
  learnerId: z.string().min(1),
  learner: z.object({ name: z.string().optional(), email: z.string().optional() }).optional(),
  modules: z.record(z.string(), z.any()),
  concepts: z.record(z.string(), z.any()).optional(),
})

const app = express()
app.use(cors())
app.use(express.json({ limit: '1mb' }))

app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

// Learner posts their progress (best-effort; the browser's localStorage stays source of truth).
app.post('/api/:system/progress', (req, res) => {
  const parsed = ProgressPayload.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid payload', issues: parsed.error.issues })
    return
  }
  const rec = fileStore.upsert(req.params.system, parsed.data as LearnerRecord)
  res.json({ ok: true, updatedAt: rec.updatedAt })
})

// Lead dashboard: completion + aggregate stuck-points. Behind a shared admin token (v1).
app.get('/api/:system/dashboard', (req, res) => {
  if (req.get('x-admin-token') !== ADMIN_TOKEN) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }
  const bundle = loadBundle(req.params.system)
  if (!bundle) {
    res.status(404).json({ error: `no bundle for "${req.params.system}" — run the generator first` })
    return
  }
  res.json(aggregateDashboard(fileStore.all(req.params.system), bundle))
})

app.listen(PORT, () => {
  console.log(`onboarding API → http://localhost:${PORT}  (admin token: ${ADMIN_TOKEN})`)
})
