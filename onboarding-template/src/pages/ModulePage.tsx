import { useEffect, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router'
import { ArrowLeft, PartyPopper } from 'lucide-react'
import { useBundle } from '../lib/useBundle'
import { audienceOf, visibleBlocks } from '../lib/persona'
import { completedModuleIds, moduleUnlocked, useProgress } from '../lib/progress'
import { Layout } from '../components/Layout'
import { BlockRenderer } from '../components/blocks/BlockRenderer'
import { Quiz } from '../components/quiz/Quiz'

export function ModulePage() {
  const { moduleId } = useParams()
  const bundle = useBundle()
  const audience = audienceOf(bundle)
  const { progress, recordAttempt, completeModule, markLessonViewed } = useProgress(bundle.system.id)

  const modules = [...bundle.modules].sort((a, b) => a.order - b.order)
  const module = modules.find((m) => m.id === moduleId)
  const [justFinished, setJustFinished] = useState(false)

  // Record lesson views on entry (guarded; hook order stays stable across renders).
  useEffect(() => {
    if (module) module.lessons.forEach((l) => markLessonViewed(module.id, l.id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleId])

  if (!module) return <Navigate to="/" replace />

  const completed = completedModuleIds(progress)
  const unlocked = moduleUnlocked(module.id, modules, completed)
  const finished = completed.has(module.id) || justFinished
  const nextModule = modules.find((m) => m.order > module.order && moduleUnlocked(m.id, modules, new Set([...completed, module.id])))

  if (!unlocked) {
    const missing = (module.prerequisites ?? []).filter((p) => !completed.has(p))
    return (
      <Layout>
        <BackLink />
        <div className="mt-6 rounded-2xl border border-line bg-surface p-6 text-center">
          <p className="text-ink">This module is locked.</p>
          <p className="mt-1 text-sm text-muted">
            Finish {missing.map((p) => bundle.modules.find((m) => m.id === p)?.title ?? p).join(', ')} first.
          </p>
        </div>
      </Layout>
    )
  }

  return (
    <Layout>
      <BackLink />
      <header className="mt-3 mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-ink">{module.title}</h1>
        {module.oneJob && <p className="mt-2 text-[15px] text-muted">{module.oneJob}</p>}
        <p className="mt-2 rounded-lg border border-accent-200 bg-accent-50/50 px-3 py-2 text-sm text-accent-700">
          <span className="font-semibold">By the end:</span> {module.objective}
        </p>
      </header>

      {module.lessons.map((lesson) => (
        <section key={lesson.id} className="mb-8">
          <h2 className="mb-2 border-b border-line pb-1 text-lg font-semibold text-ink">{lesson.title}</h2>
          {visibleBlocks(lesson.blocks, audience).map((block, i) => (
            <BlockRenderer key={i} block={block} />
          ))}
        </section>
      ))}

      {module.quiz.length > 0 && (
        <section className="mb-6">
          <Quiz
            items={module.quiz}
            onRecord={(r) => recordAttempt(module.id, r)}
            onComplete={() => {
              completeModule(module.id)
              setJustFinished(true)
            }}
          />
        </section>
      )}

      {finished && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-center">
          <PartyPopper className="mx-auto h-7 w-7 text-good" aria-hidden />
          <p className="mt-2 font-semibold text-ink">Module complete — “{module.title}” locked in.</p>
          <div className="mt-4 flex justify-center gap-3">
            <Link to="/" className="rounded-lg border border-line bg-surface px-4 py-1.5 text-sm font-medium text-ink hover:border-accent-300">
              Back to modules
            </Link>
            {nextModule && (
              <Link to={`/module/${nextModule.id}`} className="rounded-lg bg-accent-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-600">
                Next: {nextModule.title}
              </Link>
            )}
          </div>
        </div>
      )}
    </Layout>
  )
}

function BackLink() {
  return (
    <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
      <ArrowLeft className="h-4 w-4" aria-hidden /> All modules
    </Link>
  )
}
