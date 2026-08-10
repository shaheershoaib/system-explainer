import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LearnerRecord } from './aggregate'

/**
 * v1 persistence: a JSON file per system. Onboarding cohorts are small, so this is
 * plenty and zero-setup. The `Store` interface is the seam to swap in Prisma/Postgres
 * for production hosting without touching the routes or the aggregation.
 */
export interface Store {
  upsert(system: string, rec: LearnerRecord): LearnerRecord
  all(system: string): LearnerRecord[]
}

const here = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(here, 'data')
const fileFor = (system: string) => path.join(dataDir, `${system.replace(/[^a-z0-9_-]/gi, '')}.json`)

type Db = Record<string, LearnerRecord>

function read(system: string): Db {
  try {
    if (existsSync(fileFor(system))) return JSON.parse(readFileSync(fileFor(system), 'utf8')) as Db
  } catch {
    /* fall through to empty */
  }
  return {}
}
function write(system: string, db: Db) {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(fileFor(system), JSON.stringify(db, null, 2))
}

export const fileStore: Store = {
  upsert(system, rec) {
    const db = read(system)
    db[rec.learnerId] = { ...rec, updatedAt: Date.now() }
    write(system, db)
    return db[rec.learnerId]
  },
  all(system) {
    return Object.values(read(system))
  },
}
