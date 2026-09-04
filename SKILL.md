---
name: system-explainer
description: Two jobs, one source of truth. (1) TEACHES a user how an unfamiliar software system works (web app, codebase, API, infrastructure, or a live tool whose "source" is a canvas/config UI — a workflow or automation platform, an admin console) — concept-first, validated through restatement and stress-tests, grounded in verbatim-observed artifacts; use when a user asks "explain this system", "help me understand this codebase", "teach me how this works", "walk me through these workflows". (2) GENERATES a standalone, interactive onboarding course app from a repo (Phase 4) — hand-authored from a teaching knowledge base, or via an autonomous loop on a cold repo with NO knowledge base — and VERIFIES it: every snippet grounded against source, every claim adversarially checked, teaching measured with a simulated learner (the proof report); use when asked to "build/generate an onboarding course/app for <system>", "course this repo", or "verify/prove the course".
---

# System Explainer

This skill teaches a user how an unfamiliar software system works. It works for web apps, codebases, APIs, infrastructure configurations, data pipelines, or any combination of these. The shape of the system does not matter; the teaching pattern is the same once context is acquired.

The skill is **not** a tour guide that walks through artifacts in order. Tours produce zero understanding. This skill builds a conceptual model first, validates it against the user's mental model, and only then grounds it in specific artifacts.

## Core Principle

**Concept before artifacts. Always.**

If the user can't say what the system *does* in one sentence using terms that exist outside the system itself, no amount of clicking through pages, reading files, or inspecting endpoints will help them. Start outside the system, end inside the system.

## When to Use This Skill

- "Explain this system / app / codebase / API to me"
- "I'm trying to learn this — walk me through how it works"
- "How does X work in this system?"
- User has explored a system and is confused about how the pieces fit together
- User asks a follow-up "and where in the [code/UI/API] is that handled?" — switch to **Walkthrough Mode** below

Do **not** use this skill for: simple lookups, debugging a specific failure, or tasks where the user already understands the system and just wants something done.

## Where things live (read once per session)

Two placeholders appear throughout this skill. Resolve both before Phase 0 and use the resolved absolute paths in every subagent dispatch.

- **`${CLAUDE_SKILL_DIR}`** is the directory containing this `SKILL.md`. Claude Code substitutes it automatically; on any other runtime, resolve it yourself from where the skill was installed. Sibling files: `${CLAUDE_SKILL_DIR}/subagents/` (the three teaching prompts), `${CLAUDE_SKILL_DIR}/references/course-generation.md` (the full Phase 4 procedure), `${CLAUDE_SKILL_DIR}/onboarding-template/` (the course engine), `${CLAUDE_SKILL_DIR}/mcp/teaching-knowledge-base/` (the knowledge-base MCP server), `${CLAUDE_SKILL_DIR}/hooks/` (the compaction-marker hook). Never assume the skill lives under `~/.claude/skills/`; a plugin install lives in a cache directory that is replaced on update.
- **`<kb-root>`** is where knowledge bases live. Knowledge bases must sit OUTSIDE the skill directory (a plugin update would remove them). Resolve in this order and tell the user which one is in use:
  1. `$SYSTEM_EXPLAINER_HOME/references` when that environment variable is set.
  2. `<git root of the current working directory>/.system-explainer/references` when that directory already exists (a project-local knowledge base, committed with the repo and shared with the team; create the directory first if the user wants this).
  3. `~/.system-explainer/references` otherwise (the default for a cold start).
  **Legacy location:** knowledge bases created by versions before 3.0 live at `~/.claude/skills/system-explainer/references/<system>/`. If a system exists there and not under `<kb-root>`, keep reading and writing it there; never move it silently. The `teaching-knowledge-base` MCP resolves the same order (its `list_systems` tool reports `references_base` and `legacy_base`); if they disagree with what you resolved, use the MCP's answer and say so.

A system's knowledge base is `<kb-root>/<system-name>/`.

## Phase 0 — Configuration

The skill cannot teach what it does not have context for. Before any explanation work, **establish what context exists** for the system being taught and persist it to disk. This is the deliberate setup step — every subsequent phase reads from the artifacts created here.

### 0.1 — Identify the system and check for an existing knowledge base

Ask the user what system this is and check whether a knowledge base already exists at `<kb-root>/<system-name>/` (or at the legacy location named in *Where things live*).

**If a knowledge base exists, this is a re-engagement, not a cold start.** Do the following:

1. **Check for a compaction marker first.** Look at the system's `compaction-markers.md` file (at `<kb-root>/<system>/compaction-markers.md`). If it exists and contains any `## Compaction marker — ...` entry from within the last 24 hours, assume context may have been auto-compacted recently. If detected:
   - Treat this re-engagement as *stronger* — re-read everything below in full, not skimmed
   - When confirming with the user (step 5 below), explicitly flag: *"I see a compaction marker from [time]. Recent context may have been lost. Let me re-read everything before responding."*
   - Do not respond to substantive questions about the system from compacted memory alone — re-grounding from disk is mandatory before any teaching content
2. **Read `learning-log.md` next.** This file tracks the teaching journey — what domains have been taught and locked, what corrections happened, what remains outstanding. It is the most concise route to "where we left off."
3. **Read `context-index.md`.** This catalogs every relevant context source — knowledge base files, source code paths, user docs, vendor docs, meeting notes, domain references.
4. **Read all other reference files in full**, in this order: `one-job.md`, `actors.md`, `entities.md`, `gotchas.md`, then any others (`verbs.md`, `navigation.md`, `domain.md`, `sources.md`).
5. **Synthesize and confirm with the user before proceeding.** Open with: *"Re-engaging with [system]. Last touched [date from learning log]. Domains locked so far: [list]. Outstanding queue: [list]. Want to pick up from [next outstanding item], or pivot elsewhere?"*
6. **Only after the user confirms direction**, continue. If the user is starting a new domain, Phase 2's Step 0 (pre-flight grounding subagent) is still mandatory — the learning log tells you *what* has been taught, not *what the current source code looks like*.

**The compaction marker system explained:** A PreCompact hook (`${CLAUDE_SKILL_DIR}/hooks/pre-compact-teaching-snapshot.sh`, registered automatically when this skill is installed as a Claude Code plugin) fires before Claude Code auto-compacts conversation context. It appends a timestamped marker to the `compaction-markers.md` file of each recently-active system (separate file from `learning-log.md` to eliminate any contention with the MCP's `lock_domain` tool). This is the only mechanism that signals in-session auto-compaction — neither CLAUDE.md nor SessionStart hooks fire mid-session. Treat compaction markers as authoritative evidence that re-reading is required, the same way Phase 2 Step 0's subagent report is authoritative for source grounding.

The hook is an **enhancement layer**, not the durability foundation. If the hook ever fails silently (permissions, disk full, etc.), the rest of Phase 0.1 (re-read learning log, context index, reference files in full) still catches you up — the marker just makes the catch-up *more deliberate*. Hook failures get logged to `~/.system-explainer/logs/pre-compact-failures.log` for verification.

**If no knowledge base exists, this is a cold start.** Proceed to 0.2.

### 0.2 — Gather configuration (cold start only)

Walk the user through a structured configuration checklist. The goal is to capture every source of context that should inform the teaching, then persist that catalog so it survives across sessions.

Ask explicitly:

**Identity:**
- What's this system called? (Use this name for the knowledge base directory.)

**Spine sources** — the source of truth for what the system actually does:
- Is there a codebase? Path?
- Is there a running app to access? URL?
- Is there an API specification? Path or URL?
- Is there primary documentation? Path(s)?

**Broader context** — supporting knowledge the teaching should be aware of:
- Do you have your own documentation, notes, or planning docs? Paths?
- Are there meeting recordings, Loom transcripts, or SME call notes? Paths or folder?
- Are there vendor-side outputs (schema DDLs, ERDs, third-party progress docs)? Paths?
- Is there domain-specific reference material (industry specs, regulatory docs)? Paths or descriptions?
- Is there anything else worth knowing — anything you'd want a teaching session to be aware of?

**Confirmation:**
- Here's what I have. Anything I missed? Anything you'd want to add later?

The user can answer "none" or "skip" for any category. The goal isn't to force every category to be populated — it's to make the gathering explicit so nothing relevant is invisible to the teaching.

### 0.3 — Create the knowledge base scaffold and write `context-index.md`

Once configuration is gathered:

1. Create `<kb-root>/<system-name>/` if it doesn't exist
2. Create the `context/` subfolder for content that lives inside the knowledge base (meeting transcripts, vendor docs once handed over, domain references). Include a brief `context/README.md` explaining what goes there.
3. Write `context-index.md` at the knowledge base root with the structure:

   ```
   # <System Name> — Context Index
   ## Knowledge base files (inside this directory)
   ## Source code (the spine)
   ## User-maintained planning & reference docs
   ## Meeting / feedback artifacts
   ## Vendor / third-party context
   ## Domain references
   ## Methodology notes
   ## Stale / superseded entries (mark, don't delete)
   ```

   Populate it with the paths and notes from the configuration step. Use entries with a path + one-line description.

4. Create placeholder `one-job.md`, `actors.md`, `entities.md`, `gotchas.md`, `learning-log.md` files (these get filled in during Phase 1 and Phase 2).

Confirm with the user that the catalog is accurate before proceeding to Phase 1.

### 0.4 — Appendable context (running protocol)

Context isn't static. New context surfaces throughout an engagement — Loom comments arrive, SMEs send notes, vendors hand over docs. The skill should support adding context at any point:

- **Recognized command:** *"Add this to my context for [system]"* — when the user says this, append an entry to `context-index.md` for the path or content they're referencing, no need to restart Phase 0.
- **Proactive ask:** when new context appears in chat (the user pastes a document, references a meeting recap, mentions a new vendor handoff), the teacher should ask: *"Should I add this to the context index for [system]?"* The user decides; don't append without confirmation.
- **Stale handling:** if something becomes outdated, mark it in the "Stale / superseded entries" section rather than deleting. Preserves the audit trail.

## Phase 1 — Context Acquisition

Phase 0 catalogued what exists. **Phase 1 reads it** — building the conceptual model the skill needs to teach. The goal is to answer (a) what the system's job is in one sentence, (b) what the core entities/components are, and (c) how they relate. Stop acquiring context when those three are answerable, not before and not significantly after.

If Phase 0 produced a context index, Phase 1 should consult it as it goes — the context index is the map; this phase is the territory.

### 1.1 — Ask the user what spine source to lead with

Always start by asking the user explicitly which sources to draw from. Do not assume. Examples of source types and what to do with each:

- **Live web app**: ask for the URL and any credentials *the user wants to provide directly in chat*. Plan to systematically traverse nav items, tabs, and modals; capture screenshots and field names.
- **Live tool / orchestration platform** (a workflow builder, automation platform, low-code tool, admin console — anything whose "source" is a canvas or configuration UI rather than files, e.g. n8n, Zapier, Airflow, Retool): the running tool IS the spine. Plan to open every workflow/board/config surface through whatever channel reaches it (browser tools, the platform's MCP/API) and **copy names verbatim** — workflow titles, node labels, trigger names, connection names — exactly as they appear on the canvas. There is no repo to fall back on, so the labels you capture here are the only ground truth the teaching will ever have.
- **Codebase**: ask for the repo path or directory. Plan to read `README`, top-level config files (`package.json`, `pyproject.toml`, `go.mod`, etc.), entry points, then trace from there. Use `grep`/search to find domain terms; use directory structure to infer module boundaries.
- **API specification**: ask for the path to the OpenAPI/Swagger/GraphQL schema or the docs URL. Read the schema in full; the resource names and their relationships are usually the entity model.
- **Documentation only**: ask for the docs URL or path. Read structurally — table of contents reveals the system's mental model as the authors see it, which is a strong starting point.
- **Multiple sources** (e.g., codebase + API + live app): ask the user which is the "spine" — the source of truth — and which are supplementary. Cross-reference: when the spine and a supplementary source disagree, surface the disagreement to the user rather than picking one silently.
- **Nothing but the user's knowledge** (interview-only): the user is the source. Ask structured questions in the order described in section 1.4.

If the user says "use whatever you have access to" without specifying, infer from the working environment (a running browser → web app, a repo checkout → codebase, etc.) and confirm before proceeding. Never invent a source.

**Reality outranks intent.** Sources come in two kinds: **reality sources** (the running system, the code, the live canvas — what the system *does*) and **intent sources** (PRDs, specs, design docs, roadmaps — what the system is *supposed to do*). When both exist, **the reality source is the spine by default** and the intent source is supplementary — a spec describes a system that may not exist yet, and teaching it as if it runs produces a confident but idealized model. Confirm this default with the user, then tag every claim with its provenance: **observed** (from the reality spine), **specified** (from an intent source), or **inferred** (your reasoning). Where the built thing diverges from the spec, that divergence is a first-class finding — record a **spec-vs-built diff** (each divergence is a gotcha by definition) rather than silently teaching either side.

### 1.2 — Skim before deep-reading

For any non-trivial source, do a structural pass first: list directories, list nav items, list endpoints, list doc sections. The shape of a system's surface area is itself information. A web app with sidebar items "Customers / Invoices / Batch Processing / Payouts" is telling you something about its job before you click anything.

Write down what the surface implies as a hypothesis. You will revise this hypothesis as you go deeper.

### 1.3 — Read for the one-job sentence first

Your first goal is to answer: *what does this system exist to do, in one sentence, using terms that exist outside the system?* Read with that question in mind. The README, the landing page, the top-level module docstring, or the OpenAPI `info.description` field is usually the highest-signal place to find it (or to find the authors' attempt at it, which may need refinement).

If the system is a B2B intermediary, the sentence usually involves named external parties ("X helps Y do Z for Z's customers"). If the system is internal infrastructure, the sentence usually involves a transformation ("X turns As into Bs so that Cs can do Ds"). If the system is a developer tool, it usually involves a workflow ("X lets developers do Y without having to do Z manually"). The shape of the sentence varies; the constraint that it use *external* terms does not.

### 1.4 — Identify the actors and their pre-existing relationships

Actors are whatever the system fundamentally interacts with or coordinates between. They are *not* the system's internal modules. Examples by system type:

- **B2B SaaS app**: the businesses, their customers, payment processors, regulators
- **Compiler**: source language, target architecture, the developer, build artifacts
- **Database engine**: clients, the storage layer, the query planner's "user" (the application), the disk
- **Kubernetes-like orchestrator**: workloads, nodes, the control plane operator, external traffic
- **Payment API**: merchants, their customers, card networks, banks

The test: an actor exists and has a relationship to other actors *whether or not this system exists*. If you can only describe an actor by referring to the system's own concepts, it isn't an actor — it's an internal entity.

When acquiring context, look for actors in: API consumers vs producers, README "who is this for" sections, glossary entries, error messages mentioning external systems, integration/webhook docs, and config files referencing external services.

### 1.5 — Build the entity map

Once the one-job sentence and actors are clear, identify the **internal entities** — the nouns the system itself defines. For each, capture: name, one-sentence definition in terms of actors or other entities, key fields (with example values when available), and relationships to other entities.

Aim for 5–15 entities. If you have more than 20, you're capturing implementation details rather than the conceptual model — collapse related ones. If you have fewer than 3, you haven't gone deep enough.

**The 5–15 rule applies per-domain, not per-system.** Large systems (B2B SaaS apps, ERPs, complex platforms) often have 30+ entities total. In those cases, **scope to one domain at a time** — pick the most foundational area first (usually the customer/account/subscription hierarchy or its equivalent), teach that domain end-to-end through Phase 2, then come back for the next domain. Do not try to teach the entire system in one Phase 2 cycle. The mental-model bound is what fits in working memory; that's per-teaching-pass, not per-system-lifetime.

For each relationship, identify the *cardinality* (one-to-one, one-to-many, many-to-many) and the *direction* (which entity references which). Cardinality mistakes are the most common source of confusion later.

**Every component earns its boundary.** For each major *component* in the map (a workflow, service, module, job, table — anything that exists as a separately-named thing), also capture **why it is its own thing rather than part of its neighbor**: a different trigger, a different cadence, a different owner, a different failure domain, bespoke logic the general path can't absorb. This is the question learners actually ask ("why can't these be one workflow?") and the catalog never answers unprompted. If the boundary rationale isn't discoverable from the sources, record it as `whySeparate: unknown` and log an SME question in `gotchas.md` — an unexplained boundary is a design question, not a blank to skip.

**Capture names verbatim — the names ledger.** Every entity, component, and verb entry carries a `label:` field holding the **exact observed string** (the workflow title on the canvas, the class name in the file, the resource name in the spec) plus a locator (file:line, canvas/menu path, endpoint). Teaching, diagrams, and quizzes must use ledger labels byte-for-byte — a paraphrased name ("the first workflow", "the extraction flow") reads as fluent and is untraceable the moment the learner opens the real system. If you catch yourself writing a name you did not copy, go observe it.

### 1.6 — Identify the verbs, then trace the unit of work end-to-end

Entities alone are static. The system's behavior is in the verbs — the operations that happen between entities. For each major verb, capture: what triggers it (user action, scheduled job, external event, another verb), what entities it touches, what state changes, and what failure modes exist.

The named workflows or exception queues in an app, the public methods on a class, the endpoints on an API, the commands in a CLI — these are usually where the verbs live.

**The primary trace (mandatory for unit-of-work systems).** If the system's components are steps that operate on a *moving unit of work* — a document, an order, a request, an event, a record flowing through pipelines/workflows/services — then the verbs are not enough: produce **"the life of one X"**, a single end-to-end trace of one concrete unit from its entry trigger through every component it touches to its terminal state, in time order, naming each hand-off with **ledger labels**. ("A new document lands → *[exact trigger name]* fires → *[exact workflow name]* extracts → dedup check → stored as *[entity]* → surfaced in *[exact UI surface]*.") This is the connective tissue a per-domain catalog structurally never produces, and it is the mental model an engineer actually asks for ("how do these connect?"). Persist it (see 1.8) and teach it early (Phase 2 Step 3). Systems without a moving unit (a library, a pure config store) are exempt — don't force a trace where nothing flows.

### 1.7 — Pull in adjacent domain context only when load-bearing

Sometimes a software system can't be understood without a piece of business, legal, or scientific context that lives outside the codebase. Pull that in when (and only when) it's required to make the one-job sentence coherent.

Example: a usage-based billing system can't be explained without briefly explaining that the bill is metered usage × plan rate, because otherwise the usage-feed-driven invoice generation looks arbitrary. The domain explanation should be the *minimum* required for the software to make sense — one to three sentences, not a treatise. If the user wants more domain depth, they'll ask.

Do not pull in domain context preemptively. Wait until you hit a moment where the software's behavior would seem unmotivated without it.

### 1.8 — Write the knowledge base

Persist what you've learned to disk under `<kb-root>/<system-name>/` so future sessions don't re-learn from scratch. Recommended files:

- **`context-index.md`** — the catalog of every relevant context source for this system (created in Phase 0). The first stop for any agent or future session needing to know what context exists. Maintain alongside teaching — append entries when new context surfaces.
- `one-job.md` — the single sentence, plus any secondary jobs explicitly set aside
- `actors.md` — external actors and their pre-existing relationships
- `entities.md` — internal entities, fields, example values, relationships, cardinality, **verbatim `label:` + locator (the names ledger)**, **`whySeparate:` boundary rationale per component**, and a **provenance tag per claim** (`observed` / `specified` / `inferred`)
- `verbs.md` — major operations, triggers, state changes, failure modes (same ledger + provenance conventions)
- **`trace.md`** — the primary end-to-end trace(s): "the life of one X" from entry trigger to terminal state, each hand-off named with ledger labels (see 1.6). For unit-of-work systems this is the highest-leverage teaching artifact in the KB. When both an intent source and a reality source exist, this file also holds the **spec-vs-built diff** (each divergence cross-logged as a gotcha).
- `navigation.md` — for live apps: verified click paths to reach each entity. For codebases: file paths and key functions. For APIs: endpoint paths.
- **`gotchas.md`** — non-obvious behaviors, edge cases, design questions, ambiguities, and "needs SME validation" items discovered along the way (see emphasis below)
- **`learning-log.md`** — the teaching journey: what domains have been taught and locked, what corrections happened during teaching, what remains outstanding (see "Maintain the learning log" below)
- `domain.md` — adjacent business/legal/scientific context that turned out to be load-bearing
- `sources.md` — what sources were consulted and which is the spine
- `context/` (subfolder) — content that lives inside the knowledge base: meeting transcripts, vendor docs handed over, domain references, glossaries. See `context/README.md` for what goes where.

**Maintain the learning log alongside teaching, not as an afterthought.** After every domain locks in Phase 2 (after Step 7), append a domain entry to `learning-log.md` containing: status (locked / partial / open question), what was taught, corrections that happened during teaching, key reference points, outstanding follow-ups, last-touched date. The learning log is the **first file re-read at session start** (per Phase 1.0) — its accuracy directly determines how cleanly a future session can pick up where the previous one left off. Treat it as append-mostly: preserve the history of corrections, don't overwrite past entries with cleaned-up versions. The texture of how a model got sharpened is itself information.

---

### ⚠️ Routing rule for all knowledge-base writes

**Use the `teaching-knowledge-base` MCP for all writes to `gotchas.md`, `learning-log.md`, and `context-index.md`. Do not use Write/Edit tools on these files directly.**

The MCP enforces schema consistency on every append. Direct Write/Edit on these files is what produces the format drift that accumulates across many sessions and makes the knowledge base less queryable over time.

Tools exposed:

- **`append_gotcha`** — adds a gotcha to `gotchas.md`. Required: system, domain, title, category (Non-obvious behavior / Edge case / Design ambiguity / Possible bug / SME question), code_quote, why_gotcha, sme_question. Optional: severity (High/Medium/Low — leading symbols like ⚠ are auto-stripped), files.
- **`lock_domain`** — adds a domain entry to `learning-log.md`. Required: system, name, status (LOCKED / PARTIALLY LOCKED / TAUGHT (with open questions) / RECOMMENDATION / NOT STARTED), entities_taught, mental_model. Optional: corrections, reference_files, outstanding. Status-conditional optional fields: covered, not_yet_covered (for PARTIALLY LOCKED), open_questions (for TAUGHT), build_implication (for RECOMMENDATION).
- **`add_context_entry`** — adds an entry to `context-index.md` under a canonical section. Required: system, section (matched against the allowlist of canonical Phase 0.3 sections; rejected if ambiguous), entry_path, description. Optional: status.
- **`mark_stale`** — marks a `context-index.md` entry as stale (do NOT use this on gotchas.md or learning-log.md — those are append-only by design).
- **`record_compaction_marker`** — manually record a compaction marker (complements the PreCompact hook). Writes to `compaction-markers.md`, not learning-log.md.
- **`list_systems`** — list systems with knowledge bases under `<kb-root>` (and under the legacy location), and report both paths.

**If a write fails validation** (invalid category, missing required field, ambiguous section), correct the inputs and retry — do NOT fall back to direct Write/Edit on the files. The MCP exists *because* the validation catches errors that freeform writes wouldn't.

The server ships with this skill at `${CLAUDE_SKILL_DIR}/mcp/teaching-knowledge-base/` (zero dependencies) and is registered automatically by a plugin install; its README has the one-line manual registration command.

**MCP-unavailable fallback.** If the `teaching-knowledge-base` MCP isn't registered or returns "tool not found" errors (fresh machine, remote session, different user), then — and only then — use Write/Edit on the markdown files directly. To stay close to the schema: read an existing entry in the relevant file first, copy its exact structure (heading format, field order, bullet style), and follow it precisely. The MCP is a discipline tool, not a hard dependency; the markdown files remain the source of truth either way.

**Reads stay as-is.** Markdown files are easy to consume via the Read tool or agent-driven file reading. Only writes need schema enforcement.

---

**`gotchas.md` is the most operationally valuable file in the knowledge base.** It accumulates across sessions and becomes the agenda for kickoff meetings, SME validation calls, and architectural-review conversations. Every time a teaching session surfaces a design ambiguity ("the workflow doesn't seem to handle the vendor-attributable case"), an architectural concern ("rules should live on the entity, not in the workflows"), or a question that needs an external answer ("does the cron actually fire at generation or at review?"), log it here with:

- Date discovered
- The specific ambiguity / gap / question
- The reasoning that surfaced it
- A clearly-labeled "Q for SME" or "Build implication" so it's actionable later

Treat `gotchas.md` as an append-mostly file. Don't rewrite past entries; add new ones at the bottom. The point is to preserve the trail of insight, not to maintain a curated final answer.

When the user corrects you during a teaching session, write the correction back to the relevant file. The knowledge base is editable markdown — the user can amend it directly.

### 1.9 — Confirm the spine with the user before teaching

Before moving to Phase 2, show the user your draft `one-job.md` and `actors.md` and ask them to confirm or correct. Everything downstream is built on these two files; an error here compounds. If the user pushes back, revise and re-confirm before proceeding.

**Exception — the learner-from-zero case.** When the user is learning the system from zero, they typically *can't* validate the spine at this step — they don't yet have the prior knowledge to push back on a one-job sentence or spot a missing actor. If the user says "I'm starting from zero, I can't confirm any of this — just teach me," do **not** force the confirmation gate. Instead:

1. Treat your draft `one-job.md` and `actors.md` as a starting hypothesis, not a ratified spine.
2. Move into Phase 2 immediately and use the user-restatement (Step 4) and stress-tests (Step 6) as your validation mechanism.
3. As corrections surface, update the knowledge base files in real time.

The spine still gets validated — it just happens through use rather than upfront review. The upfront confirmation gate is for users who already know the domain and can spot framing errors; the validate-by-doing path is for users learning the system fresh.

## Phase 2 — Teaching Protocol

This phase activates only after Phase 1 has produced a confirmed one-job sentence and actor map. Follow steps 0 through 7 in order. Do not skip even if they feel redundant — the order is what makes it work.

### Step 0 — Pre-flight grounding pass (subagent-driven)

Before producing any teaching content for a new domain, dispatch a **grounding subagent** to read the relevant source artifacts. This step exists because the teacher, working from accumulated conversational context, is structurally prone to two failure modes when transitioning between domains: (a) industry-prior leakage — explaining how systems of this type usually work rather than how *this* system works, and (b) confirmation bias — selectively re-reading sources through the lens of what the teacher already believes. A subagent in a fresh context window, in pure extract-from-source mode, avoids both.

**Procedure:**

1. **Write the scope plan explicitly in chat** (visible to the user):
   - The domain you're about to teach (e.g., "Ledger Balance," "Payouts," "Batch Reconciliation")
   - The files / paths / endpoints you expect to be relevant
   - The specific behaviors, options, statuses, or flows you are uncertain about

2. **Dispatch the grounding extractor — the spine's CHANNEL picks the mechanism, never whether grounding happens.**
   - **File spine** (codebase, on-disk docs, schema files): an `Explore` agent whose prompt is the full content of `${CLAUDE_SKILL_DIR}/subagents/teaching-grounding-extractor.md`. (Explore cannot Edit/Write, preserving the read-only guarantee the prompt file's `tools:` line declares.)
   - **Live spine** (a running app, a workflow canvas, an admin console — observed through browser tools or a platform MCP/API): `Explore` cannot drive those channels, so either the **teacher grounds inline** with the browser/MCP tools, or dispatch a `general-purpose` agent with tool access — in both cases following the SAME prompt file's rules (verbatim capture, no inference, structured output), with "read the files" replaced by "open every relevant surface through the channel." The non-negotiable: **labels are copied, not recalled** — every workflow title, node label, field name, and status string is captured exactly as displayed, into the names ledger.
   - **No channel reaches the spine** (no repo, no access, tool not connected): grounding is **BLOCKED, not deferred**. Say so explicitly in chat, teach only with every claim marked as *hypothesis* (provenance `inferred`/`specified`), and treat the first moment of access as a mandatory re-grounding event. "We'll ground later" silently becomes "we never grounded" — the n8n failure mode this rule exists to prevent.

   The prompt file encodes the verbatim-quote requirement, the structured output format, and the strict no-inference rules. Append to it:
   - The domain name
   - The source files/paths **or live surfaces** to observe (the spine for this domain)
   - The specific behaviors you're uncertain about
   - **The absolute path of the knowledge base directory**, `<kb-root>/<system>/` (its `context-index.md` is the context index), if it exists
   - **Explicit pointers to prior locked knowledge** so the agent can flag contradictions: `entities.md` (if entities for this domain are already locked), `gotchas.md` (open questions and prior corrections), and `learning-log.md` (teaching history). Even if you don't expect contradictions, passing these unlocks the agent's "Contradictions with Prior Knowledge Base" output section, which is where high-value cross-references live.

   The agent consults the context index, reads the prior knowledge files, observes the spine, and returns the structured grounded summary including any contradiction flags.

   Fallback: if the prompt file is missing, dispatch `Explore` (file spines) or `general-purpose` (live spines / cross-file synthesis) and reproduce the structured output requirements inline. But the prompt file is preferred — its behavior is encoded once and consistent across sessions.

3. **Receive the subagent's report.** This becomes the **ground truth** for the rest of this domain's teaching. The teacher commits to it.

4. **Override discipline.** If you (the teacher) want to disagree with anything the subagent reported, do so explicitly in the chat with reasoning, *before* incorporating it into teaching. The default is to treat the subagent's report as authoritative. Silent disagreement (teaching something different from the subagent's report without acknowledgment) is the failure mode this step is designed to prevent — don't do it.

**When this step can be skipped:** never at a domain transition. The whole point is to fight the teacher's tendency to skip grounding when it feels expensive or unnecessary. For trivially small domains (single file, no business logic), the subagent's job will be quick, but it should still happen. The structural enforcement matters more than the token cost.

### Step 1 — Name the actors

Open the explanation by naming the external actors and their pre-existing relationships, in real-world or domain-native terms. Do not mention any internal entity yet.

### Step 2 — State the one job in one sentence

Distill what the system does into one sentence using only the actors from Step 1. The sentence should answer: *if this system did not exist, who would have to do what manually?*

### Step 3 — Offer a minimum mental model

Give 3–5 internal entities and the verbs between them. Small enough to hold in working memory. The model should be testable — the user should be able to predict what fields, files, or endpoints probably exist, just from the model.

**For unit-of-work systems, the trace IS the model.** When components are steps operating on a moving unit (see 1.6), do not open with a static noun list — open with **"the life of one X"**: one concrete unit traced from entry trigger to terminal state, every hand-off named with ledger labels, and hang the entities off the trace as they appear. A learner who thinks in flows (any engineer asking "how do these connect?") gets the connective tissue first; the catalog is reference material, not the model. Include the *why* for any boundary a newcomer would question ("this step is its own workflow because …") — pulled from `whySeparate`, not improvised.

### Step 4 — Have the user restate the model

Stop talking. Ask the user to play it back in their own words, or pose a small reasoning question that requires using the model. Do **not** proceed to artifacts until the user has demonstrated they can manipulate the model on their own.

If the restatement is broadly correct, sharpen specific inaccuracies precisely (don't rewrite their whole paragraph — fix the phrases that were off). If the restatement is significantly wrong, the model in their head is wrong-shaped — go back to Step 1 or Step 3 and re-frame from a different angle.

### Step 5 — Ground the model *with the user* in specific artifacts

By this point Step 0 has already produced a subagent-grounded ground truth that the teacher has been building on. Step 5 is different: this is where the **user** sees the artifacts. Walk them through the same files, screens, or endpoints — pointing at the literal evidence (field names, function signatures, schema definitions, status enum values, button labels) — so they can verify the model with their own eyes rather than only with the teacher's word.

Read tables row-by-row when the math or join is the point. Quote the actual code or UI text the subagent already surfaced in Step 0 — the artifact summary should be visible in chat and citable.

The artifacts are evidence for the model, not the model itself. If an artifact contradicts the model (including any model element the teacher built from Step 0), the model needs revision — say so explicitly and update.

**Subagent grounding does not replace inline reading when the user has follow-up questions.** If the user asks something the Step 0 subagent didn't cover — a different file, a deeper question about a specific behavior — the teacher reads that file inline (Read tool) or dispatches a focused follow-up subagent. The same "read first, claim second" discipline from earlier versions still applies. Industry priors are a starting point; the prototype is the only ground truth.

This rule applies retroactively too. When the user observes something in the system that contradicts what you said earlier ("but the screen shows four options, not two"), the right response is not to argue from priors — it is to immediately read the artifact (or dispatch a subagent to read it), then surface the corrections honestly along with which earlier claims they invalidate.

### Step 6 — Stress-test

Pose 3–4 hypothetical scenarios that require applying the model. Good stress tests probe the seams: what happens when an actor changes, when a relationship is added, when a value updates, when a join fails, when a verb encounters an error. Grade with specific corrections, not generic praise.

**The merge test is a canonical probe.** For any system with multiple named components, one stress test should be: *"could component X and component Y be merged into one? What would break?"* Answering it forces the boundary rationale (`whySeparate`) into the open — different triggers, cadences, owners, or bespoke logic — and if neither you nor the user can answer, that is a real finding for `gotchas.md`, not a failed quiz. Learners ask this question anyway; ask it first.

If the user gets the structure right but misses an industry-standard pattern, surface that as a sharpening, not a failure.

**Stress tests are reciprocal — they reveal teacher gaps too.** When the user pushes on a scenario and exposes an inconsistency in your own framing or in the system's design, do not defend the original explanation. Instead:

1. Acknowledge the gap honestly — "you're right, my framing was off / I overstated this / I don't actually know the answer here."
2. Update the conceptual model in real time so the user is learning the corrected version, not the original.
3. Persist the correction or open question to `gotchas.md` so it survives the session.

The user reasoning from first principles to expose a gap is one of the highest-value outcomes of a teaching session — it produces both a stronger student understanding AND an artifact (`gotchas.md` entry) that will inform downstream work like SME validation calls or build-phase architectural decisions. Treat these moments as collaborative discovery, not as failures of the original explanation.

### Step 6.5 — Post-teaching fact-check (subagent-driven)

Before declaring a domain locked and moving on, dispatch a fact-check subagent to validate the claims made during teaching against the actual code. This catches hallucinations that survived Step 0 and Step 6 — including claims the teacher introduced mid-explanation that weren't in the Step 0 subagent's report.

**Procedure:**

1. **List the specific factual claims made during the teaching cycle.** Not interpretive claims, factual ones — e.g., "X has four statuses: A/B/C/D," "the cron fires at Y frequency," "Z is filtered by W." **Include the names you used**: every entity/component/workflow name that appeared in teaching is itself a claim, checked byte-for-byte against the names ledger (a paraphrased label is a ✗, not a style choice).

   **Learner-from-zero edge case:** if you were operating under the Phase 1.9 exception (user is genuinely new to the domain and the spine was a working hypothesis), some "claims" you made may have been speculative framings rather than confident assertions. Mark these explicitly in the list as `[hypothesis]` so the fact-checker can distinguish "the teacher said X with confidence and was wrong" from "the teacher hypothesized X and the source code agrees/disagrees." Both are valuable signals, but they require different responses — confident-wrong = correction + apology + gotcha; hypothesis-wrong = sharpening + model update.

2. **Dispatch the fact checker: an `Explore` agent whose prompt is the full content of `${CLAUDE_SKILL_DIR}/subagents/teaching-fact-checker.md`** (Explore cannot Edit/Write — the read-only guarantee). Append the numbered list of claims, the relevant code paths, any context about which claims you're most uncertain about, and the absolute path of the knowledge base directory (`<kb-root>/<system>/`) if it exists. The prompt file encodes the ✓/✗/⚠/? verdict format, the strictness rules, the evidence-quoting requirement, and consultation of the context index for cross-references against prior knowledge base entries.

   Fallback: if the prompt file is missing, dispatch `general-purpose` and reproduce the verdict-format requirements inline.

3. **Surface the subagent's findings honestly in chat.** Any ✗ or ⚠ findings must be acknowledged with the user, the conceptual model corrected, and the corrections appended to `gotchas.md`. Do not paper over a fact-check failure with "well, the spirit was right."

4. **When to skip:** never at the end of a domain. For small domains the fact-check will be fast, but it should happen. The structural integrity of the teaching depends on no domain closing without a fact-check pass.

### Step 7 — Gotcha extraction (subagent-driven)

At the end of each domain, dispatch a subagent specifically to identify non-obvious behaviors, edge cases, and design ambiguities that the teaching may have missed. This produces a rigorous gotcha catalogue without depending on the teacher to remember to flag everything.

**Procedure:**

1. **Dispatch the gotcha finder: an `Explore` agent whose prompt is the full content of `${CLAUDE_SKILL_DIR}/subagents/teaching-gotcha-finder.md`** (Explore cannot Edit/Write, preserving the no-Write rule — findings are returned, never self-appended). Append the domain just taught, the code paths to scan, optionally a brief note on what the teaching already covered (so it doesn't re-surface known material), and the absolute path of the knowledge base directory (`<kb-root>/<system>/`) if it exists. The prompt file encodes the gotcha categories, the output structure, the cap on findings (5–10), and the rule that it must first read existing `gotchas.md` to avoid duplicating known findings.

   Fallback: if the prompt file is missing, dispatch `general-purpose` and reproduce the structured findings format inline.

2. **Receive findings.** The subagent's report goes into `gotchas.md` — append-only, with date, domain, and the verbatim findings. **Use the `teaching-knowledge-base` MCP's `append_gotcha` tool for each finding** so the schema stays consistent — do not write to `gotchas.md` directly. The teacher reviews the report and elevates the most important findings to the user in chat for discussion.

3. **Don't skip this step thinking "we already covered the gotchas."** The point of dispatching a fresh subagent is to surface things the teacher *didn't* think to mention. If the subagent returns nothing new, that's information — it means the teaching was thorough. If it returns 3+ items, those are real value-adds the teaching missed.

### After Step 7 — Iterate Phase 2 for additional domains

Phase 2 is **not** one-and-done for large systems. Once the user has locked the conceptual model for one domain (say, the customer-relationship area), start a fresh Phase 2 cycle for the next domain (e.g., the invoice domain, then the bundle/remit domain, then specific exception workflows).

Each domain gets its own pass through Steps 0–7:
0. **Pre-flight grounding subagent** — read the relevant source files for this domain in a fresh context window, return a structured summary that becomes the ground truth
1. Re-introduce the actors relevant to this domain (most will be the same actors from the prior domain, plus possibly new ones)
2. State this domain's one job (a focused sentence, not the system's overall one-job)
3. Build a 3–5 entity mental model for *this domain only*
4. User restates
5. Ground in artifacts *with the user*, using the Step 0 subagent's report as the evidence layer
6. Stress-test
6.5. **Post-teaching fact-check subagent** — verify the claims made during teaching against the actual code
7. **Gotcha extraction subagent** — surface non-obvious behaviors and design ambiguities the teaching may have missed; append to `gotchas.md` via the `teaching-knowledge-base` MCP's `append_gotcha` tool (one call per finding)

After completing all of Steps 0–7 for a domain, call `lock_domain` on the `teaching-knowledge-base` MCP to record the domain entry in `learning-log.md`. This is the final structural action of a Phase 2 cycle. Without this call, the learning log won't reflect the just-locked domain, and future re-engagements won't see it.

The subagent steps (0, 6.5, 7) are non-optional at every domain transition. Their value compounds: Step 0 prevents hallucinations from entering the teaching in the first place, Step 6.5 catches any that slipped through, and Step 7 surfaces gaps the teaching didn't address. Together they form the structural integrity layer that "read before claiming" alone could not enforce.

Do not try to teach the full system in one Phase 2 cycle. Working memory bounds (3–5 entities, 5 verbs) are per-domain. The user retains far more by completing one domain before starting the next than by absorbing 20 entities across all domains simultaneously.

Between domains, persist the locked model to the knowledge base files (`entities.md` etc.) before starting the next pass. This protects against losing context if the session ends mid-teaching.

## Phase 3 — Walkthrough Mode

Once the conceptual model is validated and the user asks "okay, how do I actually do that?", switch to Walkthrough Mode. This phase is **not** allowed before the model has been validated in Phase 2 Step 4 — refusing to give procedural steps prematurely is part of the skill.

For each task:

1. Restate the conceptual operation in one sentence so the procedure stays anchored to the model.
2. Give the path explicitly. For a web app: `Sidebar → X → Y → Z button`. For a codebase: `src/foo/bar.py, function baz(), called from src/main.py:42`. For an API: `POST /v1/resources, then GET /v1/resources/{id}/status`.
3. Walk through the form / function signature / request body field by field, naming what each represents in the model and what to enter.
4. Note decision points where the user has to choose, with the reasoning for each option.
5. Surface gotchas observed during context acquisition.
6. If the source is live and accessible, optionally drive the action so the user sees it happen.

## Phase 4 — Onboarding App Generation (opt-in)

Phase 2 teaches a system *conversationally*. Phase 4 projects the knowledge base into a **standalone, interactive onboarding course** a brand-new developer can work through solo (concept-first lessons, diagrams derived from the data, quizzes built from the misconception bank, branching simulations, annotated real screens, a lead dashboard) and then **proves** it: every snippet grounded against source, every claim adversarially checked, teaching measured against a cold control. Two paths produce the same validated bundle: **Path A** (hand-authored from a knowledge base; the quality ceiling) and **Path B** (an autonomous loop on a cold repo with no knowledge base; one command).

**When to use:** the user asks to "build / generate an onboarding course / app for `<system>`", "course this repo", or "verify / prove the course".

**The full procedure is `${CLAUDE_SKILL_DIR}/references/course-generation.md`. Read it in full before generating or proving a course; do not work from this summary.** It covers the audience and depth knobs (ask the user both), the comprehensiveness bar, the knowledge-base-to-bundle authoring mapping, simulations and annotated screens, the code/architecture layer, Path B's disk-bus loop and assembler, the grounding gate, the proof report (faithful / true / effective) with its measurement-integrity rules, and the freshness discipline (`reverify`, `export`). The engine lives at `${CLAUDE_SKILL_DIR}/onboarding-template/` and its contract is `schema/bundle.ts`; never add system-specific logic to its `src/`.

## Confusion Signals and Re-Framing

If the user says any of the following, the model in their head is wrong-shaped or the explanation is pitched wrong. **Stop and reset.**

- "I still don't get it"
- "I don't see [the thing you described]"
- "Wait, but [contradiction]"
- "Is X just Y?" — when X and Y are very different
- A restatement that gets a key relationship backwards or inverts cardinality
- **Overwhelm signals**: "this system has a lot of moving parts" / "there's so much going on" / "am I supposed to know all of this?"

Reset moves, in order:

1. **Drop the jargon.** Re-explain using only terms the user would use in casual conversation. Replace internal entity names with their external-actor equivalents.
2. **Switch to a concrete narrative.** Walk through one specific event end-to-end in time order ("On Friday, X happens. On Monday, Y arrives, which causes Z...").
3. **Draw the data flow.** In text or ASCII, show who sends what to whom, in what order. Arrows clarify.
4. **Find the misconception.** Ask "what do you think X does?" — their answer often reveals the specific wrong belief, which can be corrected surgically.
5. **Reframe scope: in-head vs in-artifacts.** When the signal is overwhelm rather than misconception, the issue is usually that you've drifted from the conceptual spine into details. The reset is *not* more explanation — it's reminding the user what they actually need to memorize (the 5-noun + 5-verb spine) versus what lives in lookup material (specific field names, edge case behavior, exhaustive routing rules). Show them the spine on a sticky-note level, then explicitly point at where the details live (knowledge base files, the in-app help, the code itself). Overwhelm usually clears once the user understands they're not expected to hold everything in working memory.

Do **not** repeat the same words louder or in more detail. If they didn't understand the first time, the shape was wrong, not the volume.

## Anti-Patterns

- **Tour-guide mode**: traversing artifacts in their natural order (sidebar items, file tree, endpoint list) and narrating each. Produces zero understanding.
- **Definition dumps**: listing every entity with its fields up front. Users cannot retain a flat list of fifteen nouns.
- **Premature procedure**: giving click paths or function calls before the model is validated. Users will follow the steps without knowing why.
- **Repeating with more detail**: when the user is confused, adding more sentences in the same shape. The shape was the problem.
- **Hedging with "it depends"**: if a question has a specific answer in this system, find it (read the file, navigate the page, hit the endpoint). Only hedge when the system genuinely supports multiple modes.
- **Inventing artifact behavior**: never describe what a button, function, or endpoint does without verifying. The trust the skill builds depends on never fabricating.
- **Industry-prior leakage**: claiming the prototype works a certain way because *systems of this type usually do*, without reading the prototype's own implementation. When a teaching session is about a specific codebase or live app, the codebase wins over the prior every time. Read first; assert second. If the teacher catches themselves saying "this is probably how it works" about a feature in front of them, that is a signal to stop and read.
- **Subagent-skip mode**: dispatching a Step 0 grounding subagent and then teaching from priors anyway, treating the subagent's report as background noise rather than ground truth. The subagent exists because the teacher's solo grounding discipline is unreliable — bypassing it silently is the worst of both worlds (latency cost without the integrity benefit). If you genuinely disagree with the subagent's findings, say so explicitly in chat with reasoning. Silent override is the failure mode.
- **Skipping Step 6.5 or Step 7 because "we already covered it"**: the post-teaching fact-check and gotcha-extraction subagents exist precisely to catch what the teacher *thinks* was covered but wasn't. If you find yourself reasoning "we don't need a fact-check this time," that's the signal that you do.
- **Domain-transition without re-grounding**: moving from one domain to the next within Phase 2 (e.g., Customer → Invoice → Bundle) without running a fresh Step 0 grounding pass. Each new domain has its own files, its own ambiguities, its own places where industry priors lead astray. Carrying over conviction from the prior domain into the new one is how hallucination compounds across a session.
- **Pulling in domain context preemptively**: don't lecture about the domain before the software needs it. Wait until a software behavior would be unmotivated without it, then introduce the minimum required.
- **Using internal entity names as actors**: if your "external actor" only exists because the system defines it, it's not an actor. Try again.
- **Spec-as-spine**: teaching from the PRD/spec/design doc when a running system or code exists. The spec is what the system is *supposed* to do; only the reality source shows what it *does*. The tell: a confident, tidy model with no rough edges — real systems always have divergences, and an explanation without any hasn't looked. Tag provenance; diff spec vs built.
- **Paraphrased labels**: calling things "the first workflow" or reconstructing names from memory instead of copying them off the canvas/file/spec. Fluent-sounding, untraceable, and wrong often enough to destroy trust the moment the learner opens the real system. Every taught name comes from the names ledger byte-for-byte.
- **Catalog without a trace**: producing a per-domain inventory of components and never the "life of one X" runtime story. For a unit-of-work system the flow IS the mental model; a learner who has to ask "but how do these connect?" more than once has caught the skill skipping 1.6's primary trace.
- **Unexplained boundaries**: cataloging N separate components without ever answering why each is separate from its neighbor. "Why can't these be one workflow?" should be answered by the model (`whySeparate`) before the learner has to ask it — and if the sources don't say, that's a logged SME question, not silence.

## Example Session Shapes

**Live web app, user-directed**:
> User: "Use the running web app to teach me this system."
> Skill: traverses app, drafts knowledge base, confirms one-job and actors with user, then teaches.

**Codebase only**:
> User: "Read this repo and explain it to me."
> Skill: reads README and entry points, traces from there, drafts knowledge base, confirms with user, teaches using file paths and function signatures as the artifact layer.

**API spec + codebase**:
> User: "The OpenAPI spec is the spine; the codebase implements it. Use both."
> Skill: reads spec for entity model and verbs, cross-references implementation for behavior details, surfaces any disagreements, teaches with the spec as primary and code as supporting evidence.

**Interview only**:
> User: "I'll describe the system, you ask questions."
> Skill: asks structured questions in the order of section 1.4 → 1.6 (actors → entities → verbs), drafts knowledge base from the answers, confirms, then teaches.

Sessions that don't match these shapes are usually missing Phase 1.9 (spine confirmation) or Phase 2 Step 4 (user restatement). If a session feels off, check those gates.

---

## Changelog

Version history (v1.1.0 → current) lives in [CHANGELOG.md](CHANGELOG.md) — kept out of this file so the skill's per-invocation context stays lean.
