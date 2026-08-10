import { useState } from 'react'
import { Lightbulb } from 'lucide-react'
import { Markdown } from '../Markdown'

/** Active-recall interaction: commit a prediction before the answer is revealed. */
export function PredictReveal({ prompt, hint, reveal }: { prompt: string; hint?: string; reveal: string }) {
  const [shown, setShown] = useState(false)
  return (
    <div className="my-4 rounded-2xl border border-accent-200 bg-accent-50/50 p-4">
      <div className="flex items-start gap-3">
        <Lightbulb className="mt-0.5 h-5 w-5 shrink-0 text-accent-600" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold uppercase tracking-wide text-accent-700">Predict first</div>
          <p className="mt-1 text-[15px] text-ink">{prompt}</p>
          {hint && !shown && <p className="mt-1.5 text-xs text-muted">Hint: {hint}</p>}
          {!shown ? (
            <button
              onClick={() => setShown(true)}
              className="mt-3 rounded-lg bg-accent-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-600"
            >
              Reveal answer
            </button>
          ) : (
            <div className="mt-3 rounded-lg border border-line bg-surface p-3">
              <Markdown>{reveal}</Markdown>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
