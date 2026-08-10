/**
 * Onboarding Bundle — the producer/consumer contract (zod is the single source of truth;
 * TS types are inferred below, so the runtime validator and the compile-time types can
 * never drift). See ../docs/specs/2026-06-16-onboarding-app-generator-design.md.
 *
 * PRODUCER: the system-explainer "Onboarding App Generation" phase emits one of these.
 * CONSUMER: the engine (../src) renders it and refuses bundles whose schemaVersion or
 * shape don't validate. ALL per-system uniqueness lives in this data — never in the engine.
 */
import { z } from 'zod'

export const BUNDLE_SCHEMA_VERSION = '1.0.0'

// ── Context layer: external actors ───────────────────────────────────────────
export const ActorRelationshipSchema = z.object({
  to: z.string(),
  label: z.string(),
})
export const ActorSchema = z.object({
  id: z.string(),
  name: z.string(),
  aka: z.array(z.string()).optional(),
  role: z.string(),
  relationships: z.array(ActorRelationshipSchema).optional(),
})

// ── ER layer: internal entities ──────────────────────────────────────────────
export const CardinalitySchema = z.enum([
  'one-to-one',
  'one-to-many',
  'many-to-one',
  'many-to-many',
])
export const EntityFieldSchema = z.object({
  name: z.string(),
  example: z.string().optional(),
  note: z.string().optional(),
})
export const EntityRelationshipSchema = z.object({
  to: z.string(),
  cardinality: CardinalitySchema,
  label: z.string().optional(),
  optional: z.boolean().optional(),
})
export const EntitySchema = z.object({
  id: z.string(),
  name: z.string(),
  definition: z.string(),
  fields: z.array(EntityFieldSchema).optional(),
  relationships: z.array(EntityRelationshipSchema).optional(),
  isReferenceData: z.boolean().optional(),
})

// ── Behavior layer: verbs + flows ────────────────────────────────────────────
export const VerbSchema = z.object({
  id: z.string(),
  name: z.string(),
  trigger: z.string().optional(),
  entitiesTouched: z.array(z.string()).optional(),
  stateChange: z.string().optional(),
  failureModes: z.array(z.string()).optional(),
})
export const FlowStepSchema = z.object({
  label: z.string(),
  actor: z.string().optional(),
  entity: z.string().optional(),
  note: z.string().optional(),
})
export const FlowSchema = z.object({
  id: z.string(),
  title: z.string(),
  steps: z.array(FlowStepSchema).min(1),
})

// ── Simulations: a guided walkthrough of a process with a live state ledger ───
// Reasoned at build time from the behavior layer (verbs / flows / quantities).
export const SimVarSchema = z.object({
  key: z.string(),
  label: z.string(),
  kind: z.enum(['text', 'money', 'number']),
  initial: z.union([z.string(), z.number()]),
})
// Declarative state mutation — no code eval. `set` assigns, `add` increments numbers.
export const SimEffectSchema = z.object({
  set: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  add: z.record(z.string(), z.number()).optional(),
  note: z.string().optional(),
})
export const SimOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  correct: z.boolean().optional(),
  outcome: z.string(),
  effects: z.array(SimEffectSchema).optional(),
})
export const SimDecisionSchema = z.object({
  prompt: z.string(),
  options: z.array(SimOptionSchema).min(2),
})
export const SimStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  narrative: z.string(),
  actor: z.string().optional(),
  decision: SimDecisionSchema.optional(),
  effects: z.array(SimEffectSchema).optional(),
})
export const SimulationSchema = z.object({
  id: z.string(),
  title: z.string(),
  subject: z.string(),
  intro: z.string().optional(),
  variables: z.array(SimVarSchema).min(1),
  steps: z.array(SimStepSchema).min(1),
  outro: z.string().optional(),
})

// ── Annotated prototype screens (the "reality" layer; needs a runnable prototype) ──
// Captured at build time; callouts are anchored to DOM selectors and resolved to
// normalized (0–1) boxes so they scale with the image and survive re-capture.
export const ScreenAnnotationSchema = z.object({
  id: z.string(),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
  label: z.string(),
  md: z.string(),
  /** The selector this box was anchored to (powers precise re-capture). */
  selector: z.string().optional(),
  /** Concept links — tie a screen region back to the model. */
  entity: z.string().optional(),
  verb: z.string().optional(),
  module: z.string().optional(),
})
export const ScreenSchema = z.object({
  id: z.string(),
  title: z.string(),
  route: z.string().optional(),
  imageUrl: z.string(),
  /** Intrinsic image pixels, for aspect-ratio without layout shift. */
  width: z.number().optional(),
  height: z.number().optional(),
  caption: z.string().optional(),
  capturedAt: z.string().optional(),
  /** Provenance of the prototype the shot came from — drives staleness checks. */
  prototypeRef: z.string().optional(),
  annotations: z.array(ScreenAnnotationSchema),
})

// ── Code/architecture layer (L3 — reasoned from the repo; graphify-accelerated) ──
export const ArchitectureComponentSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['frontend', 'backend', 'datastore', 'external', 'service', 'job']),
  tech: z.string().optional(),
  note: z.string().optional(),
})
export const ArchitectureConnectionSchema = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
})
export const ArchitectureSchema = z.object({
  components: z.array(ArchitectureComponentSchema).min(1),
  connections: z.array(ArchitectureConnectionSchema).optional(),
})

// ── Diagrams (mostly derived by the engine) ──────────────────────────────────
export const DiagramRefSchema = z.object({
  kind: z.enum(['context', 'er', 'flow', 'state', 'architecture']),
  flowId: z.string().optional(),
  title: z.string().optional(),
  scope: z.array(z.string()).optional(),
})

// ── Content blocks (the pedagogy; extensible tagged union) ────────────────────
const ProseBlockSchema = z.object({
  type: z.literal('prose'),
  md: z.string(),
  heading: z.string().optional(),
})
const MentalModelBlockSchema = z.object({
  type: z.literal('mental-model'),
  heading: z.string().optional(),
  entities: z.array(z.string()),
  verbs: z.array(z.string()).optional(),
  md: z.string().optional(),
})
const PredictRevealBlockSchema = z.object({
  type: z.literal('predict-reveal'),
  prompt: z.string(),
  reveal: z.string(),
  hint: z.string().optional(),
})
const DiagramBlockSchema = z.object({
  type: z.literal('diagram'),
  diagram: DiagramRefSchema,
})
const CodeBlockSchema = z.object({
  type: z.literal('code'),
  language: z.string(),
  code: z.string(),
  caption: z.string().optional(),
  highlightLines: z.array(z.number()).optional(),
  sourcePath: z.string().optional(),
  /** 'verbatim' = exact copy of the source file; 'adapted' = faithful but simplified
   *  (e.g. TypeScript types stripped for teaching). Drives how strict grounding-verify is. */
  excerpt: z.enum(['verbatim', 'adapted']).optional(),
  /** 1-based inclusive line range the snippet came from — powers precise re-verification. */
  lineRange: z.object({ start: z.number(), end: z.number() }).optional(),
  /** Stamped by the grounding-verify pass against the real repo; never hand-authored. */
  verified: z.enum(['verified', 'partial', 'drifted', 'missing-file', 'no-source']).optional(),
})
const WorkedStepSchema = z.object({
  label: z.string(),
  compute: z.string().optional(),
  note: z.string().optional(),
})
const WorkedExampleBlockSchema = z.object({
  type: z.literal('worked-example'),
  title: z.string(),
  steps: z.array(WorkedStepSchema).min(1),
})
const CalloutBlockSchema = z.object({
  type: z.literal('callout'),
  variant: z.enum(['gotcha', 'note', 'warning', 'tip']),
  md: z.string(),
  smeQuestion: z.string().optional(),
})
const SimulationBlockSchema = z.object({
  type: z.literal('simulation'),
  simulationId: z.string(),
  title: z.string().optional(),
})
const ScreenBlockSchema = z.object({
  type: z.literal('screen'),
  screenId: z.string(),
  title: z.string().optional(),
})
// Code-map: bridge a concept (entity/verb) to the files that implement it.
const CodeMapBlockSchema = z.object({
  type: z.literal('code-map'),
  title: z.string().optional(),
  entries: z
    .array(
      z.object({
        label: z.string(),
        entity: z.string().optional(),
        verb: z.string().optional(),
        files: z.array(z.object({ path: z.string(), role: z.string().optional() })).min(1),
      }),
    )
    .min(1),
})
// Decision records — the "why" + what's still open (from learning-log + gotchas).
const DecisionsBlockSchema = z.object({
  type: z.literal('decisions'),
  title: z.string().optional(),
  items: z
    .array(
      z.object({
        title: z.string(),
        rationale: z.string(),
        status: z.enum(['locked', 'recommendation', 'open-question']),
        sme: z.string().optional(),
      }),
    )
    .min(1),
})
// Sources — the user stories / docs / SME items a domain rests on.
const SourcesBlockSchema = z.object({
  type: z.literal('sources'),
  title: z.string().optional(),
  items: z
    .array(
      z.object({
        label: z.string(),
        kind: z.enum(['story', 'doc', 'sme', 'code']),
        detail: z.string().optional(),
        ref: z.string().optional(),
      }),
    )
    .min(1),
})
// Hands-on exercise — self-graded against a model answer (no Claude at run time).
const ExerciseBlockSchema = z.object({
  type: z.literal('exercise'),
  kind: z.enum(['find-in-code', 'where-change', 'first-task', 'predict']),
  prompt: z.string(),
  hint: z.string().optional(),
  files: z.array(z.string()).optional(),
  modelAnswer: z.string(),
})
export const BlockSchema = z.discriminatedUnion('type', [
  ProseBlockSchema,
  MentalModelBlockSchema,
  PredictRevealBlockSchema,
  DiagramBlockSchema,
  CodeBlockSchema,
  WorkedExampleBlockSchema,
  CalloutBlockSchema,
  SimulationBlockSchema,
  ScreenBlockSchema,
  CodeMapBlockSchema,
  DecisionsBlockSchema,
  SourcesBlockSchema,
  ExerciseBlockSchema,
])

export const LessonSchema = z.object({
  id: z.string(),
  title: z.string(),
  blocks: z.array(BlockSchema).min(1),
})

// ── Quizzes (the misconception bank is the star) ─────────────────────────────
export const MisconceptionMetaSchema = z.object({
  id: z.string(),
  trap: z.string(),
  correction: z.string(),
  relatedEntities: z.array(z.string()).optional(),
})
const DifficultySchema = z.enum(['intro', 'core', 'stretch'])
const McqOptionSchema = z.object({
  id: z.string(),
  text: z.string(),
  correct: z.boolean(),
  ifChosen: z.string().optional(),
})
const McqItemSchema = z.object({
  id: z.string(),
  type: z.literal('mcq'),
  prompt: z.string(),
  options: z.array(McqOptionSchema).min(2),
  explanation: z.string(),
  misconception: MisconceptionMetaSchema.optional(),
  difficulty: DifficultySchema.optional(),
})
const OrderingItemSchema = z.object({
  id: z.string(),
  type: z.literal('ordering'),
  prompt: z.string(),
  items: z.array(z.object({ id: z.string(), text: z.string() })).min(2),
  explanation: z.string(),
  difficulty: DifficultySchema.optional(),
})
const ShortAnswerItemSchema = z.object({
  id: z.string(),
  type: z.literal('short-answer'),
  prompt: z.string(),
  modelAnswer: z.string(),
  rubricKeywords: z.array(z.string()).optional(),
  difficulty: DifficultySchema.optional(),
})
// Spot-the-bug: show a buggy snippet, learner clicks the offending line. Code-comprehension assessment.
const SpotBugItemSchema = z.object({
  id: z.string(),
  type: z.literal('spot-bug'),
  prompt: z.string(),
  language: z.string().optional(),
  /** The buggy snippet, one entry per line; the learner clicks the line they think is wrong. */
  lines: z.array(z.string()).min(1),
  /** 1-based index into `lines` of the line that contains the bug. */
  buggyLine: z.number(),
  explanation: z.string(),
  fix: z.string().optional(),
  misconception: MisconceptionMetaSchema.optional(),
  difficulty: DifficultySchema.optional(),
})
export const QuizItemSchema = z.discriminatedUnion('type', [
  McqItemSchema,
  OrderingItemSchema,
  ShortAnswerItemSchema,
  SpotBugItemSchema,
])

// ── Modules (one per taught domain) ──────────────────────────────────────────
export const ModuleSchema = z.object({
  id: z.string(),
  title: z.string(),
  order: z.number(),
  prerequisites: z.array(z.string()).optional(),
  objective: z.string(),
  oneJob: z.string().optional(),
  estMinutes: z.number().optional(),
  capstone: z.boolean().optional(),
  sourceStatus: z
    .enum(['locked', 'partial', 'open-questions', 'recommendation', 'not-started'])
    .optional(),
  entitiesIntroduced: z.array(z.string()).optional(),
  actorsIntroduced: z.array(z.string()).optional(),
  diagrams: z.array(DiagramRefSchema).optional(),
  lessons: z.array(LessonSchema),
  quiz: z.array(QuizItemSchema),
})

// ── Ancillary ─────────────────────────────────────────────────────────────────
export const SystemMetaSchema = z.object({
  id: z.string(),
  name: z.string(),
  oneLiner: z.string(),
  elevatorPitch: z.string().optional(),
  domainPrimer: z.string().optional(),
  outOfScope: z.array(z.string()).optional(),
  /** Generated depth tier: L1 Orientation · L2 Working knowledge · L3 Contributor. */
  depth: z.enum(['L1', 'L2', 'L3']).optional(),
  /** Who the course is written for — sets the register and which layers get authored.
   *  'developer' (default): full rigor, real code, architecture, contributor exercises.
   *  'non-technical': plain-English, analogy-first; no code/architecture/contributor layers. */
  audience: z.enum(['developer', 'non-technical']).optional(),
  /** Public repo URL (e.g. https://github.com/org/repo) — makes code-map paths and
   *  architecture nodes click through to the real source at the verified commit. */
  repoUrl: z.string().optional(),
})
export const GlossaryTermSchema = z.object({
  term: z.string(),
  definition: z.string(),
  see: z.array(z.string()).optional(),
})
export const ThemeSchema = z.object({
  accent: z.string().optional(),
  logoDataUri: z.string().optional(),
  fontFamily: z.string().optional(),
})
// Grounding summary — stamped by `verify-grounding`: the snippet-vs-source trust report.
export const GroundingSchema = z.object({
  repoRef: z.string().optional(),
  verifiedAt: z.string().optional(),
  total: z.number(),
  verified: z.number(),
  partial: z.number(),
  drifted: z.number(),
  missingFile: z.number(),
  /** Snippets that are exact (contiguous, whitespace-normalized) copies of source. */
  exact: z.number().optional(),
})
// Human refine-pass record — drives the "reviewed by a human" trust badge (LACY: AI-only
// tours scored far below expert-refined ones, so the review step is a first-class artifact).
export const ReviewSchema = z.object({
  reviewedBy: z.string().optional(),
  reviewedAt: z.string().optional(),
  /** SME questions surfaced from the content that a human still needs to answer. */
  openQuestions: z.array(z.string()).optional(),
})
export const ProvenanceSchema = z.object({
  sources: z.array(
    z.object({
      path: z.string(),
      sha256: z.string().optional(),
      lastModified: z.string().optional(),
    }),
  ),
  generatorVersion: z.string().optional(),
  grounding: GroundingSchema.optional(),
  review: ReviewSchema.optional(),
  /** First line of the source repo's LICENSE file — embedded verbatim snippets must carry
   *  the upstream notice (e.g. BSD/MIT attribution for a public flagship course). */
  sourceLicense: z.string().optional(),
})

// ── Top level ─────────────────────────────────────────────────────────────────
export const OnboardingBundleSchema = z.object({
  schemaVersion: z.string(),
  system: SystemMetaSchema,
  actors: z.array(ActorSchema),
  entities: z.array(EntitySchema),
  verbs: z.array(VerbSchema).optional(),
  flows: z.array(FlowSchema).optional(),
  simulations: z.array(SimulationSchema).optional(),
  screens: z.array(ScreenSchema).optional(),
  architecture: ArchitectureSchema.optional(),
  modules: z.array(ModuleSchema).min(1),
  glossary: z.array(GlossaryTermSchema).optional(),
  theme: ThemeSchema.optional(),
  provenance: ProvenanceSchema.optional(),
  generatedAt: z.string().optional(),
})

// ── Inferred types (the contract, for the rest of the codebase) ──────────────
export type ActorRelationship = z.infer<typeof ActorRelationshipSchema>
export type Actor = z.infer<typeof ActorSchema>
export type Cardinality = z.infer<typeof CardinalitySchema>
export type EntityField = z.infer<typeof EntityFieldSchema>
export type EntityRelationship = z.infer<typeof EntityRelationshipSchema>
export type Entity = z.infer<typeof EntitySchema>
export type Verb = z.infer<typeof VerbSchema>
export type FlowStep = z.infer<typeof FlowStepSchema>
export type Flow = z.infer<typeof FlowSchema>
export type SimVar = z.infer<typeof SimVarSchema>
export type SimEffect = z.infer<typeof SimEffectSchema>
export type SimOption = z.infer<typeof SimOptionSchema>
export type SimDecision = z.infer<typeof SimDecisionSchema>
export type SimStep = z.infer<typeof SimStepSchema>
export type Simulation = z.infer<typeof SimulationSchema>
export type ScreenAnnotation = z.infer<typeof ScreenAnnotationSchema>
export type Screen = z.infer<typeof ScreenSchema>
export type ArchitectureComponent = z.infer<typeof ArchitectureComponentSchema>
export type Architecture = z.infer<typeof ArchitectureSchema>
export type DiagramRef = z.infer<typeof DiagramRefSchema>
export type Block = z.infer<typeof BlockSchema>
export type Lesson = z.infer<typeof LessonSchema>
export type MisconceptionMeta = z.infer<typeof MisconceptionMetaSchema>
export type McqOption = z.infer<typeof McqOptionSchema>
export type McqItem = z.infer<typeof McqItemSchema>
export type OrderingItem = z.infer<typeof OrderingItemSchema>
export type ShortAnswerItem = z.infer<typeof ShortAnswerItemSchema>
export type SpotBugItem = z.infer<typeof SpotBugItemSchema>
export type QuizItem = z.infer<typeof QuizItemSchema>
export type Module = z.infer<typeof ModuleSchema>
export type SystemMeta = z.infer<typeof SystemMetaSchema>
export type GlossaryTerm = z.infer<typeof GlossaryTermSchema>
export type Theme = z.infer<typeof ThemeSchema>
export type Grounding = z.infer<typeof GroundingSchema>
export type Review = z.infer<typeof ReviewSchema>
export type Provenance = z.infer<typeof ProvenanceSchema>
export type OnboardingBundle = z.infer<typeof OnboardingBundleSchema>
