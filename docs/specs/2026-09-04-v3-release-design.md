# v3.0.0: from "a skill in a repo" to a tool people can see, install, and trust

**Date:** 2026-09-04
**Status:** decided autonomously (the session had no live reviewer); every decision below is reversible and listed so it can be reversed. Review this doc together with the PR.
**Ask:** "make improvements, if any exist, that would make this a seriously competitive and strong tool."

## 1. What the repo is today (observed, not recalled)

- Two commits, one star, no topics, no CI, no hosted output, no screenshots, no proof report committed (`proof-runs/` is gitignored; the only proof run on disk is private).
- Fresh clone: `npm install` / `tsc --noEmit` / `vitest` (106 tests) / `vite build` all green. The engine is sound.
- The flagship course (zustand) is grounded 17/17 against `zustand@a1f685c`; that commit is still reachable upstream and every cited file exists. The bundle predates the `exact` / `lineRange` / `sourceLicense` stamps, so the hosted course would show no deep links.
- `SKILL.md` (80 KB) hardcodes `~/.claude/skills/system-explainer/...` in ~20 places, and depends on a `teaching-knowledge-base` MCP server and a PreCompact hook that are **not in the repo**. Both live only on the author's machine.
- Broken pointers: `onboarding-template/docs/specs/...` (SKILL.md) and `../docs/specs/...` (template README) point at files the repo does not contain.
- `package.json` declares `@prisma/client` + `prisma` but nothing imports them (the server uses a JSON file store).
- No install instructions for the skill itself.

## 2. What "competitive" means here (from the 2026-06-27 star research + a fresh check)

Understand-Anything is now ~25k stars (multi-platform plugin, graph + dashboard + tours, **no verification, no assessment**). codebase-to-course ~5k (single-page HTML course, no verification). The lane "verify the explanation against the live repo, measure whether it teaches" is still empty. The levers that mint adoption, in order: (1) see the output with zero install, (2) one shareable hero artifact, (3) one acute-pain headline, (4) installable in one command on the platforms people already use.

This release does not change what the product IS (the verifier that emits a course). It removes the reasons a visitor bounces before they find that out.

## 3. Decisions

| # | Decision | Alternatives weighed | Why this one |
|---|---|---|---|
| D1 | **Host the zustand course on GitHub Pages** via an Actions workflow (`npm run export` with `base=/system-explainer/`). Router gets a `basename`; `404.html` mirrors `index.html` for deep links; progress sync only fires when `VITE_API_URL` is set; the name gate gets a "Continue as guest" button. | Vercel/Netlify (needs an account + secret); no hosting (status quo). | Pages is free, in-repo, and the #1 lever. **Enabling Pages is a repo setting the maintainer flips once** (Settings > Pages > Source: GitHub Actions); the workflow also requests `enablement: true` so it may self-enable. Not done by the agent: it publishes content. |
| D2 | **Run the proof pipeline on the flagship course and commit the whole run** (`onboarding-template/proof-runs/zustand/**`, un-ignored) plus regenerate the bundle so `exact`/`lineRange`/license are stamped. | Keep proof-runs ignored; describe the proof in prose. | "The only repo course that checks itself" is the moat; a moat with no visible evidence is a slogan. The run is reproducible (inputs, keys, verdicts, answers all committed). |
| D3 | **Package as a Claude Code plugin AND a skills.sh skill without moving SKILL.md** (`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` with `source: "./"`). Root-level `SKILL.md` is discovered by both loaders. | Move to `skills/system-explainer/SKILL.md` (breaks skills.sh's root discovery and every existing local install). | Zero-move packaging; both install paths documented in the README. |
| D4 | **Vendor the knowledge-base MCP server into the repo, dependency-free** (`mcp/teaching-knowledge-base/index.js`, hand-written stdio JSON-RPC, same six tools, same markdown templates), registered by `.mcp.json` via `${CLAUDE_PLUGIN_ROOT}`. | Keep it out (skill keeps its documented fallback); keep the SDK dependency (a plugin install runs no `npm install`, so the server would not start). | The skill's routing rule says "use the MCP for all KB writes" in a warning box; shipping a server that starts from the plugin cache makes the skill work as written on install. |
| D5 | **Vendor the PreCompact hook** as a plugin hook (`hooks/hooks.json` + script). | Leave it as a private machine hook. | Same reasoning as D4; the compaction-marker protocol in Phase 0.1 is otherwise unfulfillable. |
| D6 | **Move knowledge bases OUT of the skill directory.** New resolution order (`<kb-root>`), shared by SKILL.md, the MCP, and the hook: `$SYSTEM_EXPLAINER_HOME/references` > `<git-root>/.system-explainer/references` when that directory exists > `~/.system-explainer/references`. Existing systems under the legacy `~/.claude/skills/system-explainer/references/<system>` keep working (read and write there; never migrated silently). | Keep KBs inside the skill dir. | A plugin cache is replaced on update; a KB inside it is deleted on the next `plugin update`. Project-local KBs can be committed, which makes the KB a team artifact. |
| D7 | **Portable paths in SKILL.md and the three subagent prompts**: `${CLAUDE_SKILL_DIR}` for sibling files (defined once at the top with the meaning "the directory containing this SKILL.md", so non-Claude runtimes read it as a placeholder), `<kb-root>` for knowledge bases. | Leave the hardcoded paths. | Required by D3/D6. |
| D8 | **Extract Phase 4 (course generation) out of SKILL.md into `references/course-generation.md` as a pure move**, leaving a ~20-line summary + pointer. | Leave the 80 KB skill as one file. | Every "explain this codebase" invocation currently loads ~25 KB of course-generation procedure it never uses. The author already did this once for the changelog (v2.7.0). Sentences are moved, not rewritten, so the diff reviews as a move. |
| D9 | **CI**: typecheck + tests + build on Node 20 and 22, plus `reverify` of the flagship bundle against its pinned commit (fetched by sha). | No CI. | A verifier whose own repo has no CI is not credible; the reverify job means the badge cannot rot silently. |
| D10 | **README rewritten as a product page**: acute-pain headline, live demo link, screenshots, the real proof numbers, per-persona quickstarts (learn / generate / verify), install (plugin, skills.sh, clone), an honest comparison, roadmap, license. | Incremental edits. | The README is the landing page; it currently explains the philosophy before showing anything. |
| D11 | **New public `CHANGELOG.md`** (v3.0.0 in full; pre-open-source history condensed to one line per version, no client names) and a `docs/architecture.md` that the broken pointers now target. | Import the 40 KB private changelog and the two private design docs after genericizing. | The private docs carry client and product names the author deliberately kept out of the public repo; a sed pass could leak one. New concise docs carry the same architecture without the risk. |
| D12 | **Hygiene**: drop the unused Prisma packages; scrub the author's name/email from the committed demo learner file; add `engines.node`. | Leave as is. | Trivial and visible to anyone who opens `package.json`. |

## 4. Explicitly NOT in this release (and why)

- **A standalone `npx system-explainer course <repo>` CLI (bring-your-own-key).** The keystone the changelog keeps naming. Not built here because it cannot be verified end to end without spending the maintainer's API budget on a full autonomous run, and an unverified CLI is worse than none. It stays the top roadmap item; the prompts it needs are already data in `generator/*.workflow.js`.
- **Hosted gallery / URL-swap service.** Depends on the CLI above.
- **Repo settings** (topics, description, homepage URL, Pages enablement). These publish; the exact commands are in the PR description for the maintainer to run.
- **Cross-model adversarial pass.** The proof report already discloses the shared-model-family limitation; running a second family is a per-course choice, not a repo change.

## 5. Verification plan

- Every code change: `npm run typecheck`, `npm test`, `npm run build` green on the clone.
- New MCP server: a spawned-process test drives `initialize`, `tools/list`, `tools/call list_systems`, and one `append_gotcha` into a temp KB root, asserting the markdown written.
- KB-root resolution: unit tests for the precedence order and the legacy fallback.
- Hosting: `vite build` with the Pages base, `vite preview`, then a browser check that `/system-explainer/module/<id>` deep-links load and that the code blocks deep-link to `#L` ranges.
- Proof: `PROOF_REPORT.md` regenerated from committed inputs; any refuted claim is fixed in `authored/zustand.ts` and the affected module re-proved.
- Skill edits: the Phase 4 move is checked by diffing the moved text against the original (byte-identical apart from the new heading/pointer).

## 6. Addendum, 3.1.0 polish (same day, after the 3.0.0 merge)

Decided after a look at the deployed course as a first-time visitor would see it. Same rule as above: reversible, listed so it can be reversed.

| # | Decision | Alternatives weighed | Why this one |
|---|---|---|---|
| D13 | **Architecture edges are numbered badges plus a legend**, not inline text labels. | Better inline label placement; a layout library. | The context diagram already uses a legend for the same reason; inline labels collide as soon as a component has three connections, and a legend generalises to any system. |
| D14 | **ER ranks are ordered by a barycenter sweep** to reduce edge crossings, with a `countCrossings` helper under test. | dagre / elk. | A few dozen lines, deterministic, testable, no dependency; a full layout engine is the fallback if real courses outgrow it. |
| D15 | **Syntax highlighting via prism-react-renderer** through one shared `CodeLines` component used by code blocks and the spot-the-bug quiz. | shiki (WASM, heavy); highlight.js; none. | Smallest well-maintained React-native option; keeps the line gutter and highlight rows the engine already has. |
| D16 | **The trace becomes a first-class block and the landing hero** (`traces[]`, a `trace` block, a stepper renderer, rendered as text for the proof harness). The flagship course gains "the life of one set() call". | Leave the trace as a markdown artifact of the teaching phase only. | The skill's own 2.8 invariant says the trace is the model for unit-of-work systems; the engine had no way to show it. Content added to a module is re-proved before it ships. |
| D17 | **Route-level code splitting and vendor chunks** so no chunk trips the 500 kB warning. | Replace react-markdown with a lighter renderer. | Splitting is behaviour-preserving; swapping the markdown renderer risks rendering differences in every lesson. |
| D18 | **A static build skips the name gate** and enters as Guest; the gate stays when a progress API is configured. | Keep the gate with the guest button. | Identity only matters when there is a dashboard to report to; on the hosted demo the gate is pure friction. |
| D19 | **Mobile and keyboard focus checked in the browser** at 375px; only glaring issues fixed. | A full accessibility audit. | Out of proportion for this pass; the check is recorded so the gap is known, not assumed closed. |

## 7. Addendum, 3.2.0: the standalone CLI

The gap named in section 4 ("not in this release"). Built after 3.1.0 shipped, on request. The constraint that shaped every decision: no API credential exists in the build environment, so the pipeline is proven offline against a scripted fake model and the first live run is the maintainer's.

| # | Decision | Alternatives weighed | Why this one |
|---|---|---|---|
| D20 | **A manual tool-use loop over `client.messages.stream(...).finalMessage()`**, not the SDK's beta tool runner. | The beta tool runner. | The loop needs an injectable client (a scripted fake for tests and `smoke`), a hard turn cap, sandboxed tool execution with `is_error` results, `pause_turn` and `max_tokens` handling, and a structured result collected through a `submit_result` tool. The runner covers some of that through hooks but not the fake client, and it is beta. |
| D21 | **Structured results via a `strict: true` `submit_result` tool** whose `input_schema` is the same JSON schema the Workflow scripts already use per agent role; `tool_choice: auto` plus an instruction to call it (forced tool choice is rejected on the newest models); one re-prompt if the model ends without submitting. | Parse JSON out of free text; `output_config.format`. | Same contract as the existing loops, schema-valid by construction, and it composes with the file tools in one loop. |
| D22 | **Sandboxed tools**: `list_dir`, `read_file` (line range, size cap), `search` (ripgrep when present, JS fallback), `git_log` / `git_show` (read-only, `execFile` with argument arrays, never a shell), and `write_file` allowed under the work directory only. Every path is resolved with `realpath` and prefix-checked against its allowed root; absolute paths and `..` escapes are refused. | Give the model a bash tool. | The repo is untrusted input to a model that writes files; a bash tool is exactly the command-injection surface the secure-coding reference forbids. |
| D23 | **Default model `claude-opus-5`**, `--model` to override, `--model-learner` for the learner arms (defaults to the main model), adaptive thinking (omitted, so the model's default), `--effort` (default `high`). | Hard-code a cheaper model for the cheap roles. | Cost tuning is the maintainer's decision; the flags make it a decision rather than a default they never see. |
| D24 | **Reliability contract per call**: SDK `maxRetries` 3 and a 10-minute timeout; streaming so long outputs never hit the HTTP timeout; per-agent turn cap and wall-clock cap; typed error chain (`RateLimitError`, `APIConnectionError`, `APIError`); one structured JSON log line per agent run (label, turns, tokens, cache reads, seconds, stop reason); usage totals and an estimated cost printed at the end. | Ad hoc try/catch. | The reliable-coding reference's five questions, answered in code. |
| D25 | **An offline fake model** (`--fake` / `smoke` command): a scripted client that plays every agent role with schema-valid, repo-derived answers (snippets copied from real files so grounding passes). `npm run cli:smoke` runs the whole pipeline on a tiny fixture repo in CI. | Skip offline testing and rely on the live run. | The live run costs money the build environment does not have; the fake proves orchestration, sandboxing, the disk bus, assembly, prep, and report end to end for free. |
| D26 | **Package as `system-explainer` on npm** (package renamed from `onboarding-template`, `bin` entry, `build:cli` to `dist-cli/`, `files` whitelist, `prepublishOnly`). Until the maintainer publishes, `npm run course` / `npm run prove` work from a clone. | Keep the engine private and ship a second package. | One package, one version; the engine and the CLI share the generator code. |
| D27 | **CI example, not CI enforcement**: `docs/ci/course-proof.yml` shows the two-speed gate (`reverify` on every push, scoped `prove --affected` on merge with an API key secret). This repo's own CI keeps only the free half. | Wire the paid half into this repo's CI. | Every merge would spend the maintainer's API budget without asking. |
