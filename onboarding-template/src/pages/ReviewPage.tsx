import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { ArrowLeft, RefreshCw, Sparkles } from 'lucide-react'
import type { QuizItem } from '@schema/bundle'
import { useBundle } from '../lib/useBundle'
import { conceptsDue, useProgress } from '../lib/progress'
import { Layout } from '../components/Layout'
import { Quiz } from '../components/quiz/Quiz'

/** The misconception a quiz item targets (only mcq + spot-bug carry one). */
const targetOf = (q: QuizItem): string | undefined =>
  q.type === 'mcq' || q.type === 'spot-bug' ? q.misconception?.id : undefined

/**
 * Spaced-review surface — the "reason to return". Resurfaces the misconception quiz
 * items for concepts whose review is due (missed or still-learning), one item per
 * concept. Re-answering updates Leitner mastery, scheduling each concept further out.
 */
export function ReviewPage() {
  const bundle = useBundle()
  const { progress, recordAttempt } = useProgress(bundle.system.id)
  const [done, setDone] = useState(false)

  // Snapshot the due deck once on mount so answering items doesn't shrink it mid-session.
  const review = useMemo(() => {
    const due = new Set(conceptsDue(progress.concepts, Date.now()))
    const moduleByItem: Record<string, string> = {}
    const items: QuizItem[] = []
    const seen = new Set<string>()
    for (const m of bundle.modules)
      for (const q of m.quiz) {
        const mc = targetOf(q)
        if (mc && due.has(mc) && !seen.has(mc)) {
          seen.add(mc)
          items.push(q)
          moduleByItem[q.id] = m.id
        }
      }
    return { items, moduleByItem }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundle])

  return (
    <Layout>
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft className="h-4 w-4" aria-hidden /> All modules
      </Link>
      <header className="mt-3 mb-6">
        <div className="flex items-center gap-2">
          <RefreshCw className="h-5 w-5 text-accent-600" aria-hidden />
          <h1 className="text-2xl font-bold tracking-tight text-ink">Spaced review</h1>
        </div>
        <p className="mt-2 text-[15px] text-muted">
          A quick refresh of the concepts you’ve missed or are still learning. Get one right and it’s scheduled further
          out; miss it and it comes back sooner.
        </p>
      </header>

      {review.items.length === 0 ? (
        <Done title="All caught up." body="Nothing is due for review right now. Finish a module or check back later." />
      ) : done ? (
        <Done
          title={`Review complete — ${review.items.length} concept${review.items.length === 1 ? '' : 's'} refreshed.`}
          body="The ones you got right are scheduled further out; any you missed will come back sooner."
        />
      ) : (
        <Quiz
          items={review.items}
          finishLabel="Done reviewing"
          onRecord={(r) => recordAttempt(review.moduleByItem[r.quizItemId] ?? bundle.modules[0].id, r)}
          onComplete={() => setDone(true)}
        />
      )}
    </Layout>
  )
}

function Done({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-center">
      <Sparkles className="mx-auto h-7 w-7 text-good" aria-hidden />
      <p className="mt-2 font-semibold text-ink">{title}</p>
      <p className="mt-1 text-sm text-muted">{body}</p>
      <Link
        to="/"
        className="mt-4 inline-block rounded-lg bg-accent-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-600"
      >
        Back to modules
      </Link>
    </div>
  )
}
