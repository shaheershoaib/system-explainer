import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOCUMENT_RULES, MIXED_RULES } from './course'

const here = path.dirname(fileURLToPath(import.meta.url))
const workflow = readFileSync(path.join(here, 'auto-course.workflow.js'), 'utf8')

// The Workflow script cannot import course.ts, so it carries its own copy of the rules; this keeps the copies identical.
describe('auto-course.workflow.js parity with runCourse', () => {
  it('carries DOCUMENT_RULES verbatim', () => {
    expect(workflow).toContain(DOCUMENT_RULES)
  })
  it('carries MIXED_RULES verbatim', () => {
    expect(workflow).toContain(MIXED_RULES)
  })
  it('keeps both rule texts ASCII', () => {
    expect(DOCUMENT_RULES + MIXED_RULES).toMatch(/^[\x20-\x7e\n]*$/)
  })
})
