import { Fragment, type ReactNode } from 'react'
import clsx from 'clsx'
import { AlertTriangle, FileText, FileX, ShieldCheck, type LucideIcon } from 'lucide-react'
import type { QuoteBlock as QuoteBlockData } from '@schema/bundle'

// `cite.kind` is either a format kind from the corpus manifest, which gets a friendly label here, or a
// free-form service label an agent wrote (a wiki or meeting-notes tool, say), which shows as written.
const KIND_LABEL = new Map<string, string>([
  ['transcript', 'Transcript'],
  ['pdf', 'PDF'],
  ['word', 'Word doc'],
  ['slides', 'Slides'],
  ['email', 'Email'],
  ['web', 'Web page'],
  ['html', 'Web page'],
  ['markdown', 'Document'],
  ['text', 'Document'],
  ['csv', 'Data'],
  ['json', 'Data'],
  ['remote', 'Online source'],
])

function kindLabel(kind?: string): string | undefined {
  const raw = kind?.trim()
  if (!raw) return undefined
  return KIND_LABEL.get(raw.toLowerCase()) ?? raw
}

/** The URL only when it is an absolute http(s) link: javascript:, data: and relative values render no link. */
function safeHttpUrl(url?: string): string | undefined {
  if (!url) return undefined
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined
  } catch {
    return undefined
  }
}

// The per-quote counterpart of the grounding pill on the home page: same pill, same colors.
const VERIFIED: Record<string, { label: string; icon: LucideIcon; cls: string; title: string }> = {
  verified: {
    label: 'Verified',
    icon: ShieldCheck,
    cls: 'bg-emerald-100 text-emerald-800',
    title: 'This quote was found word for word in the source document',
  },
  partial: {
    label: 'Partial match',
    icon: AlertTriangle,
    cls: 'bg-amber-100 text-amber-800',
    title: 'Only part of this quote was found in the source document',
  },
  drifted: {
    label: 'Drifted',
    icon: AlertTriangle,
    cls: 'bg-amber-100 text-amber-800',
    title: 'The source document no longer contains this quote as written',
  },
  'missing-file': {
    label: 'Source missing',
    icon: FileX,
    cls: 'bg-red-100 text-red-800',
    title: 'The source document could not be found, so this quote could not be checked',
  },
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

export function QuoteBlock({ block }: { block: QuoteBlockData }) {
  const { text, sourcePath, cite, caption, lineRange, verified } = block
  const href = safeHttpUrl(cite.url)
  const kind = kindLabel(cite.kind)
  const badge = verified ? VERIFIED[verified] : undefined
  const BadgeIcon = badge?.icon
  const speaker = cite.speaker?.trim()
  const date = cite.date?.trim()

  const title = <cite className="font-medium not-italic text-ink">{cite.title}</cite>
  const parts: ReactNode[] = [
    speaker ? (
      <span key="speaker" className="font-medium text-ink">
        {speaker}
      </span>
    ) : null,
    href ? (
      <a
        key="title"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent-700 underline decoration-dotted underline-offset-2 hover:text-accent-600"
        title="Open the source document"
      >
        {title}
      </a>
    ) : (
      <Fragment key="title">{title}</Fragment>
    ),
    kind ? (
      <span key="kind" className="rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] font-semibold text-muted">
        {kind}
      </span>
    ) : null,
    date ? (
      ISO_DAY.test(date) ? (
        <time key="date" dateTime={date}>
          {date}
        </time>
      ) : (
        <span key="date">{date}</span>
      )
    ) : null,
  ].filter(Boolean)

  return (
    <figure className="my-4 overflow-hidden rounded-xl border border-line">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-line bg-canvas px-3 py-1.5 text-xs text-muted">
        {caption && <span>{caption}</span>}
        <span className="ml-auto inline-flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="inline-flex items-center gap-1 font-mono text-[11px]">
            <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="break-all">{sourcePath}</span>
          </span>
          {lineRange && <span className="text-[11px]">{`lines ${lineRange.start}-${lineRange.end}`}</span>}
          {badge && BadgeIcon && (
            <span
              title={badge.title}
              className={clsx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold', badge.cls)}
            >
              <BadgeIcon className="h-3 w-3" aria-hidden />
              {badge.label}
            </span>
          )}
        </span>
      </div>
      <blockquote className="border-l-4 border-accent-400 bg-accent-50/40 px-4 py-3 text-[15px] leading-relaxed text-ink">
        <p className="whitespace-pre-line break-words">{text.replace(/\r\n?/g, '\n')}</p>
      </blockquote>
      <figcaption className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line bg-canvas px-3 py-2 text-xs text-muted">
        {parts.map((part, i) => (
          <Fragment key={i}>
            {i > 0 && (
              <span aria-hidden className="text-muted/60">
                ·
              </span>
            )}
            {part}
          </Fragment>
        ))}
      </figcaption>
    </figure>
  )
}
