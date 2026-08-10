import type { Block, OnboardingBundle } from '@schema/bundle'

/** Who a course is written for. Authoring-time decision recorded in system.audience. */
export type Audience = NonNullable<OnboardingBundle['system']['audience']>

export const AUDIENCE_LABEL: Record<Audience, string> = {
  developer: 'For developers',
  'non-technical': 'Plain-English',
}

export function audienceOf(bundle: OnboardingBundle): Audience {
  return bundle.system.audience ?? 'developer'
}

// Contributor / code-navigation layers a non-technical course should not surface,
// even if a bundle happens to carry them. Authoring is the primary control; this is a
// defensive filter so the same engine renders sensibly for either audience.
const DEV_ONLY_EXERCISE = new Set(['find-in-code', 'where-change', 'first-task'])
export function isDeveloperOnlyBlock(block: Block): boolean {
  if (block.type === 'code-map') return true
  if (block.type === 'diagram' && block.diagram.kind === 'architecture') return true
  if (block.type === 'exercise' && DEV_ONLY_EXERCISE.has(block.kind)) return true
  return false
}

/** The blocks to render for an audience — non-technical drops contributor/code layers. */
export function visibleBlocks(blocks: Block[], audience: Audience): Block[] {
  if (audience !== 'non-technical') return blocks
  return blocks.filter((b) => !isDeveloperOnlyBlock(b))
}

/** Source permalink for a repo-relative path, tied to the verified commit when known. */
export function sourceUrl(bundle: OnboardingBundle, filePath: string): string | undefined {
  const repo = bundle.system.repoUrl
  if (!repo) return undefined
  const ref = bundle.provenance?.grounding?.repoRef?.split('@')[1] || 'main'
  return `${repo.replace(/\/$/, '')}/blob/${ref}/${filePath.replace(/^\//, '')}`
}
