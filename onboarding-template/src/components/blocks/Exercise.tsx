import { useState } from 'react'
import clsx from 'clsx'
import { FileCode2, Wrench } from 'lucide-react'
import { Markdown } from '../Markdown'

const KIND_LABEL: Record<string, string> = {
  'find-in-code': 'Find it in the code',
  'where-change': 'Where would you change it?',
  'first-task': 'Your first task',
  predict: 'Predict',
}

export function Exercise({
  kind,
  prompt,
  hint,
  files,
  modelAnswer,
}: {
  kind: string
  prompt: string
  hint?: string
  files?: string[]
  modelAnswer: string
}) {
  const [text, setText] = useState('')
  const [revealed, setRevealed] = useState(false)
  return (
    <div className="my-4 rounded-2xl border border-violet-200 bg-violet-50/40 p-4">
      <div className="flex items-center gap-2 text-violet-700">
        <Wrench className="h-4 w-4" aria-hidden />
        <span className="text-[11px] font-semibold uppercase tracking-wide">{KIND_LABEL[kind] ?? 'Exercise'}</span>
      </div>
      <p className="mt-1 text-[15px] text-ink">{prompt}</p>
      {files && files.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {files.map((f) => (
            <span key={f} className="inline-flex items-center gap-1 rounded bg-surface px-1.5 py-0.5 font-mono text-[11px] text-muted">
              <FileCode2 className="h-3 w-3" aria-hidden /> {f}
            </span>
          ))}
        </div>
      )}
      {hint && !revealed && <p className="mt-1.5 text-xs text-muted">Hint: {hint}</p>}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={revealed}
        rows={2}
        placeholder="Jot your answer, then check it…"
        className="mt-2 w-full rounded-lg border border-line bg-surface p-2 text-sm outline-none focus:border-accent-400"
      />
      {!revealed ? (
        <button onClick={() => setRevealed(true)} className="mt-2 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:opacity-90">
          Reveal model answer
        </button>
      ) : (
        <div className={clsx('mt-2 rounded-lg border border-line bg-surface p-3 text-sm')}>
          <Markdown>{modelAnswer}</Markdown>
        </div>
      )}
    </div>
  )
}
