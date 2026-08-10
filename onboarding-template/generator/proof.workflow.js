/**
 * proof — the verification-report workflow (Phase 4 gate for every generated course).
 *
 * Run with the Workflow tool AFTER a bundle exists (hand-authored via `npm run generate`,
 * or assembled from the auto-course loop via `npm run assemble`):
 *
 *   Workflow({ scriptPath: "<template>/generator/proof.workflow.js",
 *              args: { templateDir: "<abs path to onboarding-template>",
 *                      system: "zustand",
 *                      bundlePath: "bundles/zustand/bundle.json",
 *                      repoPath: "<abs ground-truth repo>",  // omit -> the cwd repo
 *                      modules: ["m1","m2"] } })             // omit -> ALL modules
 *
 * Emits proof-runs/<system>/PROOF_REPORT.md across three layers:
 *   FAITHFUL   snippet = source           (already in the bundle's grounding record)
 *   TRUE       one skeptic per module tries to REFUTE each claim against the repo
 *   EFFECTIVE  a generated 4-option comprehension quiz with GROUNDED distractors,
 *              answered by a capable learner taught (read the module) vs cold (control)
 *
 * The deterministic halves (prep / genprep / score+render) run through generator/proof.ts;
 * this workflow only orchestrates the three agent fan-outs. Truth gates effectiveness: a
 * course that fails Layer 2 cannot be trusted on Layer 3 (its own quiz keys may be wrong).
 */
export const meta = {
  name: 'proof',
  description: 'Verify a generated course — faithful (grounding) + true (adversarial refute) + effective (hardened simulated learner) — and emit a PROOF_REPORT.md',
  phases: [
    { title: 'Prep', detail: 'strip quizzes + extract claims (proof.ts prep)' },
    { title: 'Verify-true', detail: 'one skeptic per module refutes each claim against the repo' },
    { title: 'Quizgen', detail: 'generate hardened 4-option questions with grounded distractors' },
    { title: 'Effective', detail: 'a capable learner answers taught vs cold (control)' },
    { title: 'Report', detail: 'score + tally + render PROOF_REPORT.md' },
  ],
}

const { system, bundlePath } = args
const T = args.templateDir
const repoPath = args.repoPath
const modules = Array.isArray(args.modules) ? args.modules : null
const modArg = modules ? ` --modules ${modules.join(',')}` : ''
const PROOF = `cd "${T}" && npx tsx generator/proof.ts`
const RUN = `${T}/proof-runs/${system}`
const repoLine = repoPath ? `the repository at ${repoPath}` : `the repository in your current working directory`

if (!T || !system || !bundlePath) {
  throw new Error('proof workflow requires args: { templateDir, system, bundlePath, [repoPath], [modules] }')
}

const IDS = { type: 'object', additionalProperties: false, required: ['modules'], properties: { modules: { type: 'array', items: { type: 'string' } } } }

// ── Prep: deterministic strip/shuffle + return the prepped module ids for fan-out ──
phase('Prep')
const prep = await agent(
  `Run this command EXACTLY, then report what happened:\n\n${PROOF} prep --system ${system} --bundle ${bundlePath}${modArg}\n\nAfter it succeeds, Read ${RUN}/manifest.json — it lists this run's module ids — and return {"modules": <that list>}. If the command FAILS for any reason, return {"modules": []} and put the exact error text in your reply.`,
  { schema: IDS, label: 'prep', phase: 'Prep', model: 'sonnet' },
)
const ids = (prep && prep.modules) || []
if (!ids.length) { log('proof: no modules prepped — aborting'); return { error: 'no modules prepped', system } }
log(`proof: prepped ${ids.length} module(s): ${ids.join(', ')}`)

// ── Layer 2 (TRUE): one adversarial skeptic per module ──
phase('Verify-true')
await parallel(ids.map((id) => () => agent(
  `You are an ADVERSARIAL code fact-checker. Your job is to BREAK an onboarding course, not confirm it. Source of truth = ${repoLine}; cite every path repo-relative.\n\n` +
  `Read ${RUN}/inputs/${id}.claims.json — it lists factual claims the course makes, plus citedPaths where it says the behavior lives. For EACH claim:\n` +
  `1. Split bundled assertions into atomic, separately-checkable claims.\n` +
  `2. Investigate against the ACTUAL code — start at citedPaths, then grep/read widely.\n` +
  `3. Assign a verdict, DEFAULTING TO SKEPTICISM: "supported" only with direct evidence (cite file:line or symbol), "refuted" if the code contradicts it (cite it), "unverifiable" if you find no evidence either way.\n\n` +
  `Write ONLY a JSON file to ${RUN}/adversarial/${id}.json:\n{"moduleId":"${id}","claims":[{"claim":"<atomic claim>","verdict":"supported|refuted|unverifiable","evidence":"<file:line — what you found>","note":"<optional>"}]}\n` +
  `Then reply ONE line with the counts supported/refuted/unverifiable. Do not paste the JSON.`,
  { label: `verify:${id}`, phase: 'Verify-true' },
)))

// ── Layer 3 setup (QUIZGEN): hardened 4-option questions with grounded distractors ──
phase('Quizgen')
await parallel(ids.map((id) => () => agent(
  `Write a HARD comprehension quiz that tests whether someone actually LEARNED a specific module — not whether they can guess from general knowledge.\n\n` +
  `Study material (what the learner read): ${RUN}/inputs/${id}.lesson.md. You MAY consult ${repoLine} to craft accurate distractors.\n\n` +
  `Write 5 multiple-choice questions, each EXACTLY 4 options and EXACTLY ONE correct. Requirements:\n` +
  `- The correct answer must require having READ THIS MODULE: a specific fact, number, status, formula, ordering, or FK direction from it. NOT general knowledge.\n` +
  `- The 3 distractors must be PLAUSIBLE and grounded in the same domain — real-but-wrong neighbors (a sibling status, an off-by-one formula, a wrong FK direction). A smart engineer who did NOT read the module should find all 4 plausible and be unable to guess.\n` +
  `- No "all of the above"; no two options with identical text; keep all 4 similar in length so length never telegraphs the answer.\n\n` +
  `Write ONLY a JSON file to ${RUN}/genraw/${id}.json:\n{"moduleId":"${id}","items":[{"id":"g1","prompt":"...","options":[{"text":"...","correct":true},{"text":"...","correct":false},{"text":"...","correct":false},{"text":"...","correct":false}],"whyHard":"..."}]}\n` +
  `Reply ONE line with how many questions you wrote. Do not paste the JSON.`,
  { label: `quizgen:${id}`, phase: 'Quizgen' },
)))

// deterministic: strip + shuffle the generated quizzes into learner-facing + held-back keys
await agent(`Run this command EXACTLY and report success:\n\n${PROOF} genprep --system ${system} --bundle ${bundlePath}`, { label: 'genprep', phase: 'Quizgen', model: 'sonnet' })

// ── Layer 3 (EFFECTIVE): capable learner, taught vs cold control ──
phase('Effective')
const jobs = []
for (const id of ids) { jobs.push({ id, mode: 'taught' }); jobs.push({ id, mode: 'cold' }) }
await parallel(jobs.map((j) => () => agent(
  j.mode === 'taught'
    ? `You just finished reading ONE onboarding module. Answer its quiz using ONLY what the module taught you.\n\nStudy material (your ONLY source): ${RUN}/inputs/${j.id}.lesson.md\nQuiz (EXACT path): ${RUN}/genquiz/${j.id}.quiz.json — items have ids g1, g2, …\n\nAnswer EVERY item using those EXACT ids; one option key (a/b/c/d) per item; base answers on the module, no outside facts.\nWrite ONLY a JSON file to ${RUN}/learner-gen/${j.id}.json:\n{"moduleId":"${j.id}","mode":"taught","answers":[{"id":"g1","choice":"a","reasoning":"<one line>"}]}\nReply ONE line: how many of how many you answered.`
    : `Pop quiz on a system you have NOT studied — a control for prior knowledge.\n\nRead ONLY this quiz file (EXACT path): ${RUN}/genquiz/${j.id}.quiz.json (it has the title, objective, and questions). Do NOT read or search any other file under ${RUN} — there is NO lesson material for you.\n\nAnswer EVERY item using its EXACT id (g1, g2, …); one option key (a/b/c/d) per item, from general knowledge / best guess.\nWrite ONLY a JSON file to ${RUN}/learner-gen-cold/${j.id}.json:\n{"moduleId":"${j.id}","mode":"cold","answers":[{"id":"g1","choice":"a","reasoning":"<one line>"}]}\nReply ONE line: how many of how many you answered.`,
  { label: `learn:${j.mode}:${j.id}`, phase: 'Effective', model: 'sonnet' },
)))

// ── Report: deterministic score + tally + render, returned verbatim ──
phase('Report')
const report = await agent(
  `Run this command EXACTLY:\n\n${PROOF} report --system ${system} --bundle ${bundlePath}\n\nThen read ${RUN}/PROOF_REPORT.md and return its FULL contents verbatim as your final message.`,
  { label: 'report', phase: 'Report', model: 'sonnet' },
)
return { system, modules: ids, report }
