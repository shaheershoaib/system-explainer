# Onboarding Template Engine

A **system-agnostic** engine that turns a `system-explainer` knowledge base into an
interactive onboarding course. One codebase; seeded per system with a **content
bundle** (`schema/bundle.types.ts`). This is **Approach A**: the engine is reusable
and hardened once; only the data differs per system.

## Layout

```
schema/      The content-bundle contract (TS types + JSON Schema + examples). THE source of truth.
generator/   Reads a knowledge base (references/<system>/*.md) → emits bundle.json. Validates against the schema.
src/         The learner SPA (Vite + React + TS + Tailwind v4). 100% data-driven from a bundle.
server/      Express + Prisma backend: progress sync + lead dashboard aggregates.
bundles/     Generated per-system bundles (gitignored output).
```

## Run (local smoke test)

```bash
npm install
npm run generate -- --system zustand   # KB → bundles/zustand/bundle.json
npm run dev                              # SPA on http://localhost:5174 (loads the active bundle)
npm run server                           # API on http://localhost:5175 (progress + dashboard)
```

## Test

```bash
npm test          # vitest (generator projection + quiz scoring + dashboard aggregation)
npm run typecheck # tsc --noEmit
```

See `../docs/specs/2026-06-16-onboarding-app-generator-design.md` for the full design.
