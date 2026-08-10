import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { CircleCheck, CircleX, ArrowUp, ArrowDown, Trophy } from 'lucide-react'
import type { McqItem, OrderingItem, QuizItem, ShortAnswerItem, SpotBugItem } from '@schema/bundle'
import { gradeShortAnswer } from '../../lib/progress'

// ── deterministic shuffle so layout is stable across renders but not author-order ──
function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function seedFrom(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}
function shuffleSeeded<T>(arr: T[], seed: string): T[] {
  const rng = mulberry32(seedFrom(seed))
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export interface QuizRecord {
  quizItemId: string
  correct: boolean
  /** The distractor's misconception, set only when the learner chose it (feeds stuck-points). */
  misconceptionId?: string
  /** The misconception this item targets, set on every attempt (feeds spaced-review mastery). */
  targetMisconceptionId?: string
}

export function Quiz({
  items,
  onRecord,
  onComplete,
  finishLabel = 'Finish module',
}: {
  items: QuizItem[]
  onRecord: (r: QuizRecord) => void
  onComplete: () => void
  finishLabel?: string
}) {
  const [i, setI] = useState(0)
  const [answered, setAnswered] = useState<Record<string, boolean>>({})
  const item = items[i]
  const isAnswered = item.id in answered
  const total = items.length
  const correctCount = Object.values(answered).filter(Boolean).length
  const allAnswered = Object.keys(answered).length === total

  function record(r: QuizRecord) {
    if (item.id in answered) return
    setAnswered((s) => ({ ...s, [item.id]: r.correct }))
    onRecord(r)
  }

  return (
    <div className="rounded-2xl border border-line bg-surface p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">
          Check yourself · Question {i + 1} of {total}
        </h3>
        <span className="text-xs text-muted">
          {correctCount}/{Object.keys(answered).length || 0} correct so far
        </span>
      </div>

      {item.type === 'mcq' && <McqView key={item.id} item={item} onAnswer={record} />}
      {item.type === 'ordering' && <OrderingView key={item.id} item={item} onAnswer={record} />}
      {item.type === 'short-answer' && <ShortAnswerView key={item.id} item={item} onAnswer={record} />}
      {item.type === 'spot-bug' && <SpotBugView key={item.id} item={item} onAnswer={record} />}

      <div className="mt-5 flex items-center justify-between">
        <button
          onClick={() => setI((n) => Math.max(0, n - 1))}
          disabled={i === 0}
          className="rounded-lg px-3 py-1.5 text-sm text-muted enabled:hover:bg-canvas disabled:opacity-40"
        >
          Back
        </button>
        {i < total - 1 ? (
          <button
            onClick={() => setI((n) => Math.min(total - 1, n + 1))}
            disabled={!isAnswered}
            className="rounded-lg bg-accent-500 px-4 py-1.5 text-sm font-medium text-white enabled:hover:bg-accent-600 disabled:opacity-40"
          >
            Next
          </button>
        ) : (
          <button
            onClick={onComplete}
            disabled={!allAnswered}
            className="inline-flex items-center gap-1.5 rounded-lg bg-good px-4 py-1.5 text-sm font-medium text-white enabled:hover:opacity-90 disabled:opacity-40"
          >
            <Trophy className="h-4 w-4" aria-hidden /> {finishLabel}
          </button>
        )}
      </div>
    </div>
  )
}

function Feedback({ correct, children }: { correct: boolean; children: React.ReactNode }) {
  return (
    <div
      className={clsx(
        'mt-3 flex gap-2 rounded-lg border p-3 text-sm',
        correct ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-amber-300 bg-amber-50 text-amber-900',
      )}
    >
      {correct ? <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-good" aria-hidden /> : <CircleX className="mt-0.5 h-4 w-4 shrink-0 text-bad" aria-hidden />}
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function McqView({ item, onAnswer }: { item: McqItem; onAnswer: (r: QuizRecord) => void }) {
  const options = useMemo(() => shuffleSeeded(item.options, item.id), [item])
  const [chosen, setChosen] = useState<string | null>(null)
  const choose = (id: string) => {
    if (chosen) return
    setChosen(id)
    const opt = item.options.find((o) => o.id === id)!
    onAnswer({
      quizItemId: item.id,
      correct: opt.correct,
      misconceptionId: !opt.correct && item.misconception ? item.misconception.id : undefined,
      targetMisconceptionId: item.misconception?.id,
    })
  }
  const chosenOpt = chosen ? item.options.find((o) => o.id === chosen) : undefined
  return (
    <div>
      <p className="text-[15px] font-medium text-ink">{item.prompt}</p>
      <div className="mt-3 space-y-2">
        {options.map((o) => {
          const state = !chosen ? 'idle' : o.correct ? 'correct' : o.id === chosen ? 'wrong' : 'muted'
          return (
            <button
              key={o.id}
              onClick={() => choose(o.id)}
              disabled={!!chosen}
              className={clsx(
                'flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                state === 'idle' && 'border-line hover:border-accent-400 hover:bg-accent-50/50',
                state === 'correct' && 'border-emerald-300 bg-emerald-50 text-emerald-900',
                state === 'wrong' && 'border-amber-400 bg-amber-50 text-amber-900',
                state === 'muted' && 'border-line opacity-60',
              )}
            >
              {chosen && o.correct && <CircleCheck className="h-4 w-4 shrink-0 text-good" aria-hidden />}
              {chosen && !o.correct && o.id === chosen && <CircleX className="h-4 w-4 shrink-0 text-bad" aria-hidden />}
              <span>{o.text}</span>
            </button>
          )
        })}
      </div>
      {chosen && (
        <Feedback correct={!!chosenOpt?.correct}>
          {chosenOpt && !chosenOpt.correct && chosenOpt.ifChosen && <p className="font-medium">{chosenOpt.ifChosen}</p>}
          <p className={clsx(chosenOpt && !chosenOpt.correct && chosenOpt.ifChosen && 'mt-1 opacity-90')}>{item.explanation}</p>
        </Feedback>
      )}
    </div>
  )
}

function OrderingView({ item, onAnswer }: { item: OrderingItem; onAnswer: (r: QuizRecord) => void }) {
  const correctOrder = useMemo(() => item.items.map((x) => x.id), [item])
  const [order, setOrder] = useState<string[]>(() => shuffleSeeded(correctOrder, item.id))
  const [checked, setChecked] = useState(false)
  const labelOf = (id: string) => item.items.find((x) => x.id === id)!.text
  const move = (idx: number, dir: -1 | 1) => {
    if (checked) return
    const j = idx + dir
    if (j < 0 || j >= order.length) return
    setOrder((o) => {
      const a = [...o]
      ;[a[idx], a[j]] = [a[j], a[idx]]
      return a
    })
  }
  const correct = order.every((id, idx) => id === correctOrder[idx])
  return (
    <div>
      <p className="text-[15px] font-medium text-ink">{item.prompt}</p>
      <ol className="mt-3 space-y-2">
        {order.map((id, idx) => (
          <li
            key={id}
            className={clsx(
              'flex items-center justify-between rounded-lg border px-3 py-2 text-sm',
              !checked && 'border-line',
              checked && id === correctOrder[idx] && 'border-emerald-300 bg-emerald-50',
              checked && id !== correctOrder[idx] && 'border-amber-300 bg-amber-50',
            )}
          >
            <span>
              <span className="mr-2 text-muted">{idx + 1}.</span>
              {labelOf(id)}
            </span>
            {!checked && (
              <span className="flex gap-1">
                <button onClick={() => move(idx, -1)} className="rounded p-1 hover:bg-canvas" aria-label="Move up">
                  <ArrowUp className="h-4 w-4" />
                </button>
                <button onClick={() => move(idx, 1)} className="rounded p-1 hover:bg-canvas" aria-label="Move down">
                  <ArrowDown className="h-4 w-4" />
                </button>
              </span>
            )}
          </li>
        ))}
      </ol>
      {!checked ? (
        <button
          onClick={() => {
            setChecked(true)
            onAnswer({ quizItemId: item.id, correct })
          }}
          className="mt-3 rounded-lg bg-accent-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-600"
        >
          Check order
        </button>
      ) : (
        <Feedback correct={correct}>
          <p>{item.explanation}</p>
        </Feedback>
      )}
    </div>
  )
}

function ShortAnswerView({ item, onAnswer }: { item: ShortAnswerItem; onAnswer: (r: QuizRecord) => void }) {
  const [text, setText] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const correct = useMemo(() => gradeShortAnswer(text, item.rubricKeywords), [text, item.rubricKeywords])
  return (
    <div>
      <p className="text-[15px] font-medium text-ink">{item.prompt}</p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={submitted}
        rows={3}
        className="mt-3 w-full rounded-lg border border-line bg-canvas p-2 text-sm outline-none focus:border-accent-400"
        placeholder="Type your answer, then check it against the model answer…"
      />
      {!submitted ? (
        <button
          onClick={() => {
            setSubmitted(true)
            onAnswer({ quizItemId: item.id, correct })
          }}
          disabled={!text.trim()}
          className="mt-2 rounded-lg bg-accent-500 px-3 py-1.5 text-sm font-medium text-white enabled:hover:bg-accent-600 disabled:opacity-40"
        >
          Reveal model answer
        </button>
      ) : (
        <Feedback correct={correct}>
          <p className="font-medium">Model answer</p>
          <p className="mt-1">{item.modelAnswer}</p>
        </Feedback>
      )}
    </div>
  )
}

function SpotBugView({ item, onAnswer }: { item: SpotBugItem; onAnswer: (r: QuizRecord) => void }) {
  const [picked, setPicked] = useState<number | null>(null)
  const choose = (lineNo: number) => {
    if (picked != null) return
    setPicked(lineNo)
    const correct = lineNo === item.buggyLine
    onAnswer({
      quizItemId: item.id,
      correct,
      misconceptionId: !correct && item.misconception ? item.misconception.id : undefined,
      targetMisconceptionId: item.misconception?.id,
    })
  }
  return (
    <div>
      <p className="text-[15px] font-medium text-ink">{item.prompt}</p>
      <p className="mt-1 text-xs text-muted">Click the line you think contains the bug.</p>
      <div className="mt-3 overflow-hidden rounded-xl border border-line bg-[#1b1b22] py-2 font-mono text-[12.5px] leading-relaxed text-[#e7e7ef]">
        {item.lines.map((ln, idx) => {
          const lineNo = idx + 1
          const isBug = lineNo === item.buggyLine
          const state = picked == null ? 'idle' : isBug ? 'bug' : picked === lineNo ? 'wrongpick' : 'dim'
          return (
            <button
              key={idx}
              onClick={() => choose(lineNo)}
              disabled={picked != null}
              className={clsx(
                'flex w-full items-start gap-3 px-3 text-left transition-colors',
                state === 'idle' && 'hover:bg-white/10',
                state === 'bug' && 'bg-emerald-500/25',
                state === 'wrongpick' && 'bg-red-500/30',
                state === 'dim' && 'opacity-60',
              )}
            >
              <span className="w-6 shrink-0 select-none text-right text-white/30">{lineNo}</span>
              <span className="whitespace-pre">{ln || ' '}</span>
            </button>
          )
        })}
      </div>
      {picked != null && (
        <Feedback correct={picked === item.buggyLine}>
          {picked !== item.buggyLine && <p className="font-medium">Not quite — the bug is on line {item.buggyLine}.</p>}
          <p className={clsx(picked !== item.buggyLine && 'mt-1 opacity-90')}>{item.explanation}</p>
          {item.fix && <p className="mt-1"><span className="font-semibold">Fix:</span> {item.fix}</p>}
        </Feedback>
      )}
    </div>
  )
}
