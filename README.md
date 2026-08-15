# system-explainer

Two jobs, one source of truth:

1. **Teach** a person how an unfamiliar software system actually works — concept
   first, validated by making them restate it, then grounded in the real files,
   screens and endpoints.
2. **Generate** a standalone interactive onboarding course from a repository —
   and then *prove* the course is true.

## Why it exists

The usual failure when explaining a system is **industry-prior leakage**: the
explainer describes how systems of that type normally work rather than how *this
one* does, and the learner cannot tell the difference. The second failure is
unearned confidence — a course that reads beautifully and is quietly wrong.

So the method is built around observation rather than recall. A grounding pass
reads the real artifacts with fresh eyes and returns verbatim quotes with a names
ledger; every claim in a generated course is checked against source; and a
learner is simulated to test whether the teaching actually teaches.

## Teaching (the skill)

`SKILL.md` is the method. It works on a codebase, an API, infrastructure, or a
live tool whose "source" is a canvas or admin UI — the channel decides *how* you
observe, never *whether*. Supporting agents live in `subagents/`:

- `teaching-grounding-extractor` — observes a domain's spine and returns
  entities, user-facing strings, data flow and a names ledger, all verbatim.
- `teaching-gotcha-finder` — surfaces the non-obvious: things that look like bugs
  but may be deliberate, and questions only a subject-matter expert can answer.
- `teaching-fact-checker` — adversarially checks claims against the source.

## Generating a course (`onboarding-template/`)

A React + Vite app seeded with a validated **bundle** — data, not code — so one
engine serves any system's course.

```bash
cd onboarding-template
npm install
npm run generate -- --system zustand   # KB -> bundles/zustand/bundle.json
npm run dev                            # the course
npm run server                         # progress + lead dashboard API
npm test                               # generator + engine unit tests
```

Content types: concept lessons, diagrams derived from the model (context, ER,
architecture), quizzes built from a misconception bank, branching **simulations**
with a live state ledger, and annotated real screens linking a region of a real
page to the concept it demonstrates.

The bundled demo course is for **Zustand**, the open-source state library — a
real course over a real public codebase, so the pipeline is demonstrable end to
end without any private material.

## Proving a course is true

A generated course is verified on three layers, because "it reads well" is not
evidence:

| layer | question | how |
|---|---|---|
| faithful | is every snippet really in the source? | line-exact verbatim matching |
| true | does each claim survive attack? | one skeptic per module tries to refute it |
| effective | does it actually teach? | a simulated learner takes the quiz taught vs cold |

Truth gates effectiveness: a course that fails layer 2 cannot be trusted on layer
3, because its own answer key may be wrong.

## Requirements

Node 18+ for the template. The skill itself is markdown — it needs an agent
runtime that can read skills, plus whatever tools that runtime uses to observe
the system (file reads, a browser, or a platform API).

## License

[Apache 2.0](LICENSE) — free to use, modify, and share, including commercially.
Keep the [`NOTICE`](NOTICE) file with any redistribution (§4(d)), and don't market
a fork under the `system-explainer` name (§6). The patent grant in §3 means adopting
this doesn't expose you to a patent claim over it.

Required Notice: Copyright Shaheer Shoaib (https://github.com/shaheershoaib)
