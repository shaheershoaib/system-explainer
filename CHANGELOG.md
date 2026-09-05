# Changelog

The living instructions are in [`SKILL.md`](SKILL.md) and [`references/course-generation.md`](references/course-generation.md); this file is the record of how they got here. Versions before 3.0.0 were developed privately; their entries are condensed.

## 3.2.0 (2026-09-04): the CLI, bring your own key

Decisions D20 to D27 in the design record. The course loop and the proof loop no longer need Claude Code's Workflow runtime: `npx system-explainer course <repo>` and `prove <repo>` run them from any terminal or CI job against the Anthropic API with the user's own key.

- **`system-explainer` on npm** (the engine package, renamed from `onboarding-template`): `course`, `prove`, `reverify`, `serve`, `smoke`. Output lives under `<repo>/.system-explainer/` (bundle, proof runs, a static copy of the viewer for `serve`). `--model` (default `claude-opus-5`), `--model-learner`, `--effort`, `--concurrency`, `--rounds`, `--modules`, `--affected`, `--json`; token totals and an estimated cost print after every run.
- **A manual tool-use loop** (`generator/llm/`): streaming calls with `maxRetries` 3 and a 10-minute timeout, a strict `submit_result` tool per role so every artifact is schema-valid by construction, turn and wall-clock caps, typed error classification, one JSON log line per agent run.
- **Sandboxed tools instead of a shell**: `list_dir`, `read_file`, `search` (ripgrep or a JS fallback), `git_log`, `git_show`, all read-only and path-checked against the target repo; `write_file` only under the run's work directory. Agents never get bash.
- **An offline scripted model** plays every role with repo-derived, schema-valid answers, so `smoke` and the test suite exercise orchestration, sandboxing, the disk bus, assembly, prep, and the report without an API key. This is also how the CLI was verified before release: no live run happened in the build environment, the first live run is the maintainer's.
- **The proof harness is callable**: `prep`, `genprep`, `report`, `reverify` are exported functions with return values; the argv wrappers are unchanged.
- **CI example, not enforcement**: [`docs/ci/course-proof.yml`](docs/ci/course-proof.yml) shows the two-speed gate (`reverify` on push, `prove --affected` on merge). This repo's own CI runs the free half plus `smoke`.

## 3.1.0 (2026-09-04): the polish a first visitor notices

Decisions D13 to D19 in the design record. Nothing here changes what the tool proves; all of it changes whether someone who lands on the demo stays.

- **Syntax highlighting** in every code block and in the spot-the-bug quiz (prism-react-renderer through one shared `CodeLines` component; line gutter and highlight rows unchanged).
- **The trace is first-class.** New `traces[]` in the bundle, a `trace` block, a stepper renderer, and the landing hero shows "the life of one X" above the data model when a course declares one. The proof harness renders traces as text so every step is adversarially checked like any other claim. The flagship course gained "The life of one update" (one `set()` call from the caller through `Object.is`, merge-or-replace, listener notification and React's re-render), verified against source.
- **Diagrams.** Architecture connections are numbered badges with a legend instead of colliding inline labels; ER ranks are ordered by a barycenter sweep so edges stop crossing unrelated nodes (crossing count under test).
- **Smaller first load.** Route-level code splitting (dashboard, review) and vendor chunks; no chunk trips the 500 kB warning.
- **A static build skips the name gate** and enters as Guest; the gate stays when a progress API is configured.
- Mobile width and keyboard focus checked in the browser at 375px: diagrams keep a minimum width and scroll sideways instead of shrinking to a thumbnail, and every interactive element gets one visible focus ring.
- The proof harness's `genprep` now invalidates learner answers only for quizzes that actually changed, so re-proving one module does not discard the other modules' learner runs.
- The re-proof after adding the trace: react-binding 67 of 67 atomic claims supported (184 of 184 across the course); the one React-internal clause the skeptic could not verify was cut.

## 3.0.0 (2026-09-04): see it, install it, trust it

The product did not change: system-explainer is still the verifier that emits a course. This release removes the reasons a visitor bounced before finding that out. Design record: [`docs/specs/2026-09-04-v3-release-design.md`](docs/specs/2026-09-04-v3-release-design.md).

**See it**
- The flagship zustand course is deployed as a static site from `.github/workflows/pages.yml` (GitHub Pages, project-site base path). The engine gained a `VITE_BASE` build variable, a router `basename`, a `404.html` fallback for deep links (`npm run build:pages`), and a "Continue as guest" button on the name gate.
- Progress sync now runs only when `VITE_API_URL` is set (development keeps the localhost default); the dashboard page says so instead of failing.
- The README is a product page: what it does, the live demo, screenshots, the real proof numbers, per-persona quickstarts.

**Install it**
- Claude Code plugin: `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` (source `./`; the root `SKILL.md` is the plugin's skill). Also installable with `npx skills add shaheershoaib/system-explainer`.
- The `teaching-knowledge-base` MCP server now lives in the repo (`mcp/teaching-knowledge-base/`), rewritten with zero npm dependencies so it starts from a plugin cache, registered by `.mcp.json`. Same six tools, same markdown templates, tests under `node:test`.
- The PreCompact compaction-marker hook now lives in the repo (`hooks/`), registered by `hooks/hooks.json`.

**Trust it**
- The proof pipeline was run on the flagship course and the whole run is committed under `onboarding-template/proof-runs/zustand/` (inputs, answer keys, adversarial verdicts, generated quiz, learner answers, `PROOF_REPORT.md`). Refuted claims found by the run were fixed in `generator/authored/zustand.ts`.
- Every code snippet in the flagship course is now a contiguous verbatim copy of its source, so each one deep-links to exact lines at the pinned commit.
- `proof.ts prep --modules <id>` now merges into the run's existing manifest instead of replacing it, so fixing one module and re-proving it keeps the other modules in the report (the fix-and-re-prove loop is the normal operation; it was not possible before without re-prepping everything).
- Grounding records pin the full 40-character commit id (was a 7-character prefix, which `git fetch` cannot resolve); the UI shortens it for display.
- The classes of claim the adversary refuted (oversimplified control flow, wrong mechanism for a true property, version drift, a doc sentence generalised into advice, false counts, unverifiable comparisons) are now listed in `references/course-generation.md` as an authoring checklist.
- CI (`.github/workflows/ci.yml`): typecheck, tests, and build on Node 20, 22 and 24, the MCP tests, the hook syntax check, and a job that fetches the pinned upstream commit and re-runs the grounding gate. A course that drifts from its source turns the badge red instead of rotting silently.

**Portability (breaking)**
- Knowledge bases moved out of the skill directory. `<kb-root>` resolves as `$SYSTEM_EXPLAINER_HOME/references`, else `<git root>/.system-explainer/references` when that directory exists, else `~/.system-explainer/references`. Systems under the legacy `~/.claude/skills/system-explainer/references/<system>/` keep working in place; nothing is moved silently. The skill, the MCP server, and the hook share this resolution.
- `SKILL.md` and the three subagent prompts use `${CLAUDE_SKILL_DIR}` for sibling files and `<kb-root>` for knowledge bases; no path assumes an install location.
- Phase 4 (course generation and proof) moved verbatim into `references/course-generation.md`, loaded on demand. `SKILL.md` went from 595 lines / 80 KB to 501 lines / 59 KB of per-invocation context; a session that only explains a system no longer carries the course procedure.

**Hygiene**
- Dropped the unused Prisma packages (the server uses a JSON file store); `engines.node >= 20`.
- New `docs/architecture.md` (the pointers that used to name a missing design doc now resolve), `CONTRIBUTING.md`, this changelog.
- Demo learner records no longer carry a real name or email.

**Not in this release**
- A standalone `npx system-explainer course <repo>` CLI (bring your own key). The prompts it needs are already data in `generator/*.workflow.js`; it is the next roadmap item and is not shipped until it has been run end to end.

**Upgrading from a private 2.x install**
- Existing knowledge bases need no action (legacy location is honoured).
- If you registered the MCP server manually, re-point it at `mcp/teaching-knowledge-base/index.js` in the new checkout, or install the plugin and delete the manual registration.
- Bundles generated before 3.0 carry 7-character pins; re-run `npm run generate -- --repo <path>` to restamp.

## Before open-sourcing (condensed)

- **2.9.0 (2026-07-08)** Disk-bus intermediates for the autonomous loop; a deterministic structural backbone when a graphify AST graph exists; `reverify` (commit-scoped incremental re-grounding); the system map as the landing hero; `npm run export` static viewer and a documented no-Workflow fallback.
- **2.8.0 (2026-07-08)** Four project-agnostic invariants from a live-tool teaching retrospective: grounding is verbatim observation through the spine's channel (blocked, not deferred, when no channel exists) with a names ledger; reality outranks intent, with provenance tags and a spec-vs-built diff; every component earns its boundary (`whySeparate`, the merge test); the trace is the model for unit-of-work systems (`trace.md`, taught first).
- **2.7.0 (2026-07-08)** Proof-harness measurement integrity (run manifest, invalid-run guard, duplicate-option rejection, per-item discrimination, the high-cold-control caveat); `lineRange` deep links; `provenance.sourceLicense`; `--out` workspace output; the autonomous loop's `audience` knob.
- **2.6.0 (2026-06-19)** Path B: the autonomous course loop for a cold repo with no knowledge base, plus line-exact verbatim matching in the grounding gate.
- **2.5.0 (2026-06-18)** The comprehensiveness bar (cover every domain the knowledge base names) and annotated screens as an expected layer wherever an app exists.
- **2.4.0 (2026-06-18)** Audience persona (developer / non-technical); the grounding gate and its "verified against repo@sha" badge; spaced review with per-concept Leitner mastery; the human review pass; `spot-bug` quizzes; inline glossary tooltips.
- **2.3.0 (2026-06-18)** Depth tiers L1 / L2 / L3 and the contributor-depth layers: architecture diagram, code map, decisions, sources, exercises, capstone.
- **2.2.0 (2026-06-17)** Annotated real screens with selector-anchored, concept-linked callouts.
- **2.1.0 (2026-06-17)** Simulations (a branching walkthrough with a live state ledger) and diagram layout fixes measured on rendered geometry.
- **2.0.0 (2026-06-16)** Phase 4: one system-agnostic course engine seeded by a validated content bundle, with a misconception-bank quiz engine, progress, and a lead dashboard.
- **1.9.0 (2026-05-22)** Fresh-eyes audit fixes: MCP path-traversal guard, separate compaction-marker file, graceful shutdown, ambiguity rejection on context-index sections, status-conditional learning-log templates.
- **1.8.0 (2026-05-22)** The `teaching-knowledge-base` MCP server for schema-enforced knowledge-base writes.
- **1.7.0 (2026-05-22)** The PreCompact hook and the compaction-marker protocol.
- **1.6.0 (2026-05-21)** Phase 0 configuration, `context-index.md`, the `context/` folder, and the appendable-context protocol.
- **1.5.0 (2026-05-21)** The three teaching subagents as prompt files instead of ad-hoc prompts.
- **1.4.0 (2026-05-21)** `learning-log.md` and the re-engagement protocol.
- **1.3.0 (2026-05-21)** Subagent-driven grounding (Step 0), fact-check (Step 6.5), and gotcha extraction (Step 7) at every domain transition.
- **1.2.0 (2026-05-06)** Read the artifact before any system-specific claim; the industry-prior-leakage anti-pattern.
- **1.1.0 (2026-05-06)** The learner-from-zero exception, the per-domain 5 to 15 entity rule, reciprocal stress tests, and `gotchas.md` as the most valuable file in the knowledge base.
