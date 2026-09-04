# Contributing

Thanks for looking. This repo has three parts with different rules, so read the part you are
touching.

## Setup

```bash
git clone https://github.com/shaheershoaib/system-explainer.git
cd system-explainer/onboarding-template
npm install
npm run typecheck && npm test && npm run build
```

The MCP server and the hook have no dependencies: `node --test ../mcp/teaching-knowledge-base/test/*.test.js`
and `bash -n ../hooks/pre-compact-teaching-snapshot.sh`.

## Two invariants

1. **The engine is system-agnostic.** Nothing under `onboarding-template/src/` may know which system
   it renders. Per-system content lives in a bundle. A new interaction is a new block type in
   `schema/bundle.ts` plus a renderer in `src/components/blocks/`, never a special case.
2. **The skill is project-agnostic.** A rule in `SKILL.md` or `subagents/` may key on a *property* of
   the source or system (file spine vs live spine, intent source vs reality source, a moving unit of
   work) and never on a *product*. Products may appear only as examples.

## Changing the skill

`SKILL.md` is loaded into an agent's context on every invocation, so it is kept lean: Phase 4 lives
in `references/course-generation.md` and the version history in `CHANGELOG.md`. Before editing a
rule, write the scenario that shows an agent getting it wrong without the change, then make the
change, then re-run the scenario. Paths inside the skill use `${CLAUDE_SKILL_DIR}` for sibling files
and `<kb-root>` for knowledge bases; do not hardcode an install location.

## Adding or changing a course

- Author (or fix) `onboarding-template/generator/authored/<system>.ts`.
- `npm run generate -- --system <system> --repo <path-to-the-real-repo>` so every snippet is
  grounded. A `drifted` or `missing-file` snippet is a bug in the course, not a warning.
- Run the proof workflow (see `references/course-generation.md`) and commit the run under
  `onboarding-template/proof-runs/<system>/` if the course is public.

## Pull requests

- CI must be green: typecheck, tests, build on Node 20 and 22, and the flagship course must still
  re-verify against its pinned commit.
- Conventional commit subjects (`feat:`, `fix:`, `docs:`, `chore:`).
- Say what you observed, not what you intended: the PR description should quote the gate output.
