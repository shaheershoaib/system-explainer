import {
  OnboardingBundleSchema,
  BUNDLE_SCHEMA_VERSION,
  type OnboardingBundle,
} from '../schema/bundle'

export type ValidateResult =
  | { ok: true; bundle: OnboardingBundle }
  | { ok: false; errors: string[] }

/**
 * Validate an untrusted bundle: zod shape first, then referential integrity that
 * zod can't express (cross-references, uniqueness, prerequisite cycles, version).
 * Never throws — returns a typed result with a flat list of human-readable errors.
 */
export function validateBundle(input: unknown): ValidateResult {
  const parsed = OnboardingBundleSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
      ),
    }
  }
  const b = parsed.data
  const errors: string[] = []

  // — schema version: engine accepts only matching major —
  const major = (v: string) => v.split('.')[0]
  if (major(b.schemaVersion) !== major(BUNDLE_SCHEMA_VERSION)) {
    errors.push(
      `schemaVersion ${b.schemaVersion} is incompatible with engine schema version ${BUNDLE_SCHEMA_VERSION} (major mismatch)`,
    )
  }

  // — id uniqueness —
  const flagDupes = (label: string, ids: string[]) => {
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) errors.push(`duplicate ${label} id: "${id}"`)
      seen.add(id)
    }
  }
  const entityIds = b.entities.map((e) => e.id)
  const actorIds = b.actors.map((a) => a.id)
  const moduleIds = b.modules.map((m) => m.id)
  flagDupes('entity', entityIds)
  flagDupes('actor', actorIds)
  flagDupes('module', moduleIds)

  const entitySet = new Set(entityIds)
  const actorSet = new Set(actorIds)
  const moduleSet = new Set(moduleIds)
  const flowIds = new Set((b.flows ?? []).map((f) => f.id))

  // — referential integrity —
  for (const e of b.entities)
    for (const r of e.relationships ?? [])
      if (!entitySet.has(r.to))
        errors.push(`entity "${e.id}" relationship references missing entity "${r.to}"`)

  for (const a of b.actors)
    for (const r of a.relationships ?? [])
      if (!actorSet.has(r.to))
        errors.push(`actor "${a.id}" relationship references missing actor "${r.to}"`)

  for (const v of b.verbs ?? [])
    for (const id of v.entitiesTouched ?? [])
      if (!entitySet.has(id)) errors.push(`verb "${v.id}" touches missing entity "${id}"`)

  for (const f of b.flows ?? [])
    for (const s of f.steps) {
      if (s.actor && !actorSet.has(s.actor))
        errors.push(`flow "${f.id}" step references missing actor "${s.actor}"`)
      if (s.entity && !entitySet.has(s.entity))
        errors.push(`flow "${f.id}" step references missing entity "${s.entity}"`)
    }

  const miscIds: string[] = []
  const quizItemIds: string[] = []
  for (const m of b.modules) {
    for (const p of m.prerequisites ?? []) {
      if (!moduleSet.has(p))
        errors.push(`module "${m.id}" prerequisite references missing module "${p}"`)
      if (p === m.id) errors.push(`module "${m.id}" lists itself as a prerequisite`)
    }
    for (const id of m.entitiesIntroduced ?? [])
      if (!entitySet.has(id)) errors.push(`module "${m.id}" introduces missing entity "${id}"`)
    for (const id of m.actorsIntroduced ?? [])
      if (!actorSet.has(id)) errors.push(`module "${m.id}" introduces missing actor "${id}"`)
    for (const d of m.diagrams ?? []) {
      if ((d.kind === 'flow' || d.kind === 'state') && d.flowId && !flowIds.has(d.flowId))
        errors.push(`module "${m.id}" diagram references missing flow "${d.flowId}"`)
      for (const id of d.scope ?? [])
        if (!entitySet.has(id) && !actorSet.has(id))
          errors.push(`module "${m.id}" diagram scope references unknown id "${id}"`)
    }
    for (const q of m.quiz) {
      quizItemIds.push(q.id)
      if (q.type === 'mcq') {
        if (!q.options.some((o) => o.correct))
          errors.push(`mcq "${q.id}" in module "${m.id}" has no correct option`)
        if (q.misconception) miscIds.push(q.misconception.id)
      }
      if (q.type === 'spot-bug') {
        if (q.buggyLine < 1 || q.buggyLine > q.lines.length)
          errors.push(
            `spot-bug "${q.id}" in module "${m.id}" has buggyLine ${q.buggyLine} out of range 1..${q.lines.length}`,
          )
        if (q.misconception) miscIds.push(q.misconception.id)
      }
    }
  }
  flagDupes('quiz item', quizItemIds)
  flagDupes('misconception', miscIds)

  // — simulations —
  const simIds = (b.simulations ?? []).map((s) => s.id)
  flagDupes('simulation', simIds)
  const simSet = new Set(simIds)
  for (const m of b.modules)
    for (const lesson of m.lessons)
      for (const blk of lesson.blocks)
        if (blk.type === 'simulation' && !simSet.has(blk.simulationId))
          errors.push(`module "${m.id}" references missing simulation "${blk.simulationId}"`)

  for (const sim of b.simulations ?? []) {
    const varKeys = new Set(sim.variables.map((v) => v.key))
    flagDupes(`simulation "${sim.id}" variable`, sim.variables.map((v) => v.key))
    flagDupes(`simulation "${sim.id}" step`, sim.steps.map((s) => s.id))
    const checkEffects = (effs: typeof sim.steps[number]['effects'], where: string) => {
      for (const e of effs ?? []) {
        for (const k of Object.keys(e.set ?? {}))
          if (!varKeys.has(k)) errors.push(`simulation "${sim.id}" ${where} sets undeclared variable "${k}"`)
        for (const k of Object.keys(e.add ?? {}))
          if (!varKeys.has(k)) errors.push(`simulation "${sim.id}" ${where} adds to undeclared variable "${k}"`)
      }
    }
    for (const st of sim.steps) {
      if (st.actor && !actorSet.has(st.actor))
        errors.push(`simulation "${sim.id}" step "${st.id}" references missing actor "${st.actor}"`)
      checkEffects(st.effects, `step "${st.id}"`)
      for (const o of st.decision?.options ?? []) checkEffects(o.effects, `step "${st.id}" option "${o.id}"`)
    }
  }

  // — annotated prototype screens —
  const screenIds = (b.screens ?? []).map((s) => s.id)
  flagDupes('screen', screenIds)
  const screenSet = new Set(screenIds)
  const verbSet = new Set((b.verbs ?? []).map((v) => v.id))
  for (const m of b.modules)
    for (const lesson of m.lessons)
      for (const blk of lesson.blocks)
        if (blk.type === 'screen' && !screenSet.has(blk.screenId))
          errors.push(`module "${m.id}" references missing screen "${blk.screenId}"`)
  for (const sc of b.screens ?? []) {
    flagDupes(`screen "${sc.id}" annotation`, sc.annotations.map((a) => a.id))
    for (const a of sc.annotations) {
      if (a.entity && !entitySet.has(a.entity))
        errors.push(`screen "${sc.id}" annotation "${a.id}" links missing entity "${a.entity}"`)
      if (a.verb && !verbSet.has(a.verb))
        errors.push(`screen "${sc.id}" annotation "${a.id}" links missing verb "${a.verb}"`)
      if (a.module && !moduleSet.has(a.module))
        errors.push(`screen "${sc.id}" annotation "${a.id}" links missing module "${a.module}"`)
    }
  }

  // — architecture + depth-layer block refs —
  const archComponents = b.architecture?.components ?? []
  flagDupes('architecture component', archComponents.map((c) => c.id))
  const archIds = new Set(archComponents.map((c) => c.id))
  for (const cn of b.architecture?.connections ?? []) {
    if (!archIds.has(cn.from)) errors.push(`architecture connection references missing component "${cn.from}"`)
    if (!archIds.has(cn.to)) errors.push(`architecture connection references missing component "${cn.to}"`)
  }
  for (const m of b.modules)
    for (const lesson of m.lessons)
      for (const blk of lesson.blocks) {
        if (blk.type === 'code-map')
          for (const e of blk.entries) {
            if (e.entity && !entitySet.has(e.entity))
              errors.push(`module "${m.id}" code-map links missing entity "${e.entity}"`)
            if (e.verb && !verbSet.has(e.verb)) errors.push(`module "${m.id}" code-map links missing verb "${e.verb}"`)
          }
        if (blk.type === 'diagram' && blk.diagram.kind === 'architecture' && !b.architecture)
          errors.push(`module "${m.id}" uses an architecture diagram but the bundle has no architecture`)
      }

  // — prerequisite cycle detection (DFS three-coloring) —
  const adj = new Map<string, string[]>()
  for (const m of b.modules)
    adj.set(m.id, (m.prerequisites ?? []).filter((p) => moduleSet.has(p)))
  const color = new Map<string, 0 | 1 | 2>() // 0 white, 1 gray, 2 black
  for (const id of moduleIds) color.set(id, 0)
  let hasCycle = false
  const visit = (u: string) => {
    color.set(u, 1)
    for (const v of adj.get(u) ?? []) {
      if (color.get(v) === 1) { hasCycle = true; return }
      if (color.get(v) === 0) visit(v)
    }
    color.set(u, 2)
  }
  for (const id of moduleIds) if (color.get(id) === 0) visit(id)
  if (hasCycle) errors.push('module prerequisites contain a cycle')

  return errors.length ? { ok: false, errors } : { ok: true, bundle: b }
}
