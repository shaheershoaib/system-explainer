# system-explainer

Turn anything (a repository, meeting notes, transcripts, PDFs, Word and PowerPoint files, wiki and web pages) into a grounded, adversarially verified onboarding course, from any terminal, with your own Anthropic API key.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npx system-explainer course /path/to/repo                        # a codebase
npx system-explainer course ~/notes/kickoff/ https://...         # documents: lessons quote them verbatim, with speaker and date
npx system-explainer course /path/to/repo ~/notes/               # code plus the documents around it
npx system-explainer prove /path/to/repo                         # skeptics, hardened quiz, taught vs cold learners; exit 2 if a claim is refuted
npx system-explainer serve /path/to/repo                         # view the course at http://localhost:4173
npx system-explainer reverify /path/to/repo                      # free re-check of every snippet and quote (no model call)
npx system-explainer sources                                     # what this machine can read, and the credential names it sees
npx system-explainer smoke                                       # every path offline on bundled fixtures (no API key needed)
```

There is no list of supported services: the code reads file formats and plain URLs, and an access agent works out how to reach anything else from what you give it (credential values never reach the model; `--grant VAR=host` decides where a token may go). A source that cannot be read stops the run before the course loop spends anything (exit 3), with fixes for that source; `--allow-partial` builds without it and says so in the course. Output lives under `<repo or folder>/.system-explainer/`. Defaults: `claude-opus-5` at high effort; `--model`, `--model-learner`, `--effort`, `--audience`, `--concurrency`, `--rounds`, `--modules`, `--affected`, `--transcribe`, `--json`. Every run prints token totals and an estimated cost. Full documentation, the proof report format, and the Claude Code skill this package belongs to: [github.com/shaheershoaib/system-explainer](https://github.com/shaheershoaib/system-explainer).

The rest of this file documents the engine the CLI is built on.

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

## Verify and ship a course

```bash
npm run generate -- --system zustand --repo /path/to/zustand   # stamps the grounding record + line ranges
npm run reverify -- --system zustand --bundle bundles/zustand/bundle.json --repo /path/to/zustand
npx tsx generator/proof.ts prep --system zustand --bundle bundles/zustand/bundle.json   # then the proof workflow
npm run export                                                  # static site in dist/ (progress in localStorage)
VITE_BASE=/system-explainer/ npm run build:pages                # same, for a GitHub Pages project site
```

See [`../docs/architecture.md`](../docs/architecture.md) for how the pieces fit, and
[`../references/course-generation.md`](../references/course-generation.md) for the generation and proof procedure.
