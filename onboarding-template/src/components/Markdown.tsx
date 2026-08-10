import { useMemo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import clsx from 'clsx'
import { useBundleState } from '../lib/useBundle'

/**
 * Term → definition map, built from the bundle's entities + glossary. Powers inline
 * glossary tooltips: any backticked term in prose that names an entity/glossary term
 * gets a hover definition, with zero extra authoring cost (the data already exists).
 */
function useTermMap(): Map<string, string> {
  const s = useBundleState()
  return useMemo(() => {
    const m = new Map<string, string>()
    if (s.status !== 'ready') return m
    for (const e of s.bundle.entities) {
      m.set(e.name.toLowerCase(), e.definition)
      m.set(e.id.toLowerCase(), e.definition)
    }
    for (const g of s.bundle.glossary ?? []) m.set(g.term.toLowerCase(), g.definition)
    return m
  }, [s])
}

// Tailwind v4 has no typography plugin here, so we style the rendered elements
// explicitly. Kept small — bundle prose is short, concept-first copy.
export function Markdown({ children }: { children: string }) {
  const terms = useTermMap()
  const components = useMemo<Components>(
    () => ({
      p: ({ children }) => <p className="my-2 leading-relaxed text-ink/90">{children}</p>,
      ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 text-ink/90">{children}</ul>,
      ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5 text-ink/90">{children}</ol>,
      li: ({ children }) => <li className="leading-relaxed">{children}</li>,
      strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
      em: ({ children }) => <em className="italic">{children}</em>,
      a: ({ children, href }) => (
        <a href={href} target="_blank" rel="noreferrer" className="text-accent-600 underline underline-offset-2">
          {children}
        </a>
      ),
      code: ({ children }) => {
        const text = typeof children === 'string' ? children : Array.isArray(children) ? children.join('') : ''
        const def = !text.includes('\n') ? terms.get(text.toLowerCase().trim()) : undefined
        return (
          <code
            title={def}
            className={clsx(
              'rounded bg-accent-50 px-1 py-0.5 font-mono text-[0.85em] text-accent-700',
              def && 'cursor-help underline decoration-dotted decoration-accent-400 underline-offset-2',
            )}
          >
            {children}
          </code>
        )
      },
      h2: ({ children }) => <h2 className="mt-4 mb-1 text-lg font-semibold text-ink">{children}</h2>,
      h3: ({ children }) => <h3 className="mt-3 mb-1 text-base font-semibold text-ink">{children}</h3>,
      blockquote: ({ children }) => (
        <blockquote className="my-2 border-l-2 border-accent-200 pl-3 text-muted">{children}</blockquote>
      ),
    }),
    [terms],
  )

  return (
    <div className="text-[15px]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
