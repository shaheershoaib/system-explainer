# Proof report — zustand

Source of truth: `zustand@b57db4f86ef179285da216eeb291266da82c361c` · modules covered: 4/4

This report tests three claims the course makes about itself: that it is **faithful** (every snippet is real), **true** (every assertion survives an adversary trying to refute it against the source), and **effective** (a learner who only read the course can pass its own assessment).

## Layer 1 — Faithful · snippet = source
`17/17` code snippets verified against source, **17 exact-verbatim** (byte-for-byte contiguous copies).

_Stamped by the grounding gate at author time; re-checked on every release so it cannot silently rot._

## Layer 2 — True · adversarial claim verification
A skeptic agent re-read each prose/callout assertion and tried to **refute** it against `zustand@b57db4f86ef179285da216eeb291266da82c361c`, defaulting to "refuted/unverifiable" unless the code directly backs it.

- **184** supported
- **0** refuted 
- **0** unverifiable (no code evidence either way)

Survival rate: **100%** of 184 atomic claims.

## Layer 3 — Effective · simulated learner on a hardened comprehension quiz

**Method (hardened).** Fresh 4-option comprehension questions were generated per module, with the three distractors drawn from real-but-wrong facts in the same domain (a neighboring status, a sibling formula, an off-by-one FK direction) so they cannot be guessed from general knowledge. A capable learner answers them — "taught" reads only the module text; the "cold" control sees only the title + objective. The cold control fails not because the model is weak but because the distractors are *grounded*; the gap, **taught − cold = lift**, isolates what the course taught.

| Module | Items | Taught | Cold (control) | Lift | Discriminating items |
|---|---|---|---|---|---|
| Middleware, the codebase & architecture | 5 | 100% | 100% | +0 pts | 0 of 5 (5 guessable) |
| The store as a React hook | 5 | 100% | 100% | +0 pts | 0 of 5 (5 guessable) |
| Selectors & re-renders | 5 | 100% | 100% | +0 pts | 0 of 5 (5 guessable) |
| The store, from scratch | 5 | 100% | 100% | +0 pts | 0 of 5 (5 guessable) |
| **Overall** | 20 | **100%** | **100%** | **+0 pts** | |

_A **discriminating** item is one the taught learner got right and the cold control got wrong — the direct evidence of teaching. Items both got right are guessable and carry no signal._

> **High cold-control caveat.** The cold control scored 100% on the hardened quiz — a sizable share of questions are answerable without reading the course (model priors on a well-known codebase, residual guessability, or both). Lift UNDERSTATES teaching here; weigh the per-item discrimination column and the faithful + true layers more heavily. Lift is most meaningful on private/internal repos, where a control cannot have priors.

**Effectiveness depends on truth.** A quiz can only measure teaching if its answer key is correct. When a key encodes a claim that Layer 2 refuted, a "taught" learner scores by *absorbing the error* and the control may score higher by reasoning correctly. So Layer 2 must pass before Layer 3 means anything — that is why the two run together.

## Honest limitations
- The learner is an LLM with prior knowledge it cannot fully suppress; the **cold control** is what makes the "taught" number meaningful (lift, not absolute), and on well-known public codebases even the control has priors — see the caveat above when it fires.
- **The author, skeptic, quiz-writer, and learner share a model family.** Shared blind spots can survive every layer — a claim wrong in a way the family reliably misjudges will pass its own adversary. For high-stakes courses, run the adversarial pass with a second model family (cross-model verification).
- Diagrams, simulations, and screens are rendered to the learner as short text stand-ins, so visual teaching is under-credited here.
- Adversarial verdicts are one skeptic per module; a production run votes N skeptics per claim and keeps only majority-supported.
- Coverage is 4/4 modules (a representative slice unless this says all).
