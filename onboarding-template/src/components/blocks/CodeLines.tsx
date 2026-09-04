import { Fragment, type ReactNode } from 'react'
import clsx from 'clsx'
import { Highlight, Prism, themes } from 'prism-react-renderer'

// Bundle language names -> the Prism grammar ids prism-react-renderer ships. `text`, anything
// unlisted, and anything whose grammar is not bundled (bash/sh in 2.x) render as plain text,
// exactly as every snippet did before highlighting existed.
const GRAMMAR: Record<string, string> = {
  typescript: 'typescript',
  ts: 'typescript',
  tsx: 'tsx',
  javascript: 'javascript',
  js: 'javascript',
  jsx: 'jsx',
  python: 'python',
  py: 'python',
  json: 'json',
  bash: 'bash',
  sh: 'bash',
  markdown: 'markdown',
  md: 'markdown',
  css: 'css',
  yaml: 'yaml',
  yml: 'yaml',
}

/** The Prism grammar id for a bundle language, or undefined when it should render plain. */
export function grammarFor(language?: string): string | undefined {
  const id = GRAMMAR[(language ?? '').trim().toLowerCase()]
  return id && Prism.languages[id] ? id : undefined
}

export type CodeLine = {
  /** 1-based line number. */
  lineNo: number
  /** The tokenized (or plain) text of the line; an empty line renders as a single space. */
  content: ReactNode
  highlighted: boolean
}

/**
 * One row per source line, syntax-highlighted when the language has a bundled grammar. The dark
 * container (`bg-[#1b1b22]`, 12.5px mono) stays with the caller; only token colors come from the
 * theme, so plain tokens inherit the container's text color and highlighted rows keep the accent
 * wash. `renderLine` replaces the whole row (gutter included) when the caller needs its own
 * wrapper, e.g. a clickable button.
 */
export function CodeLines({
  code,
  language,
  highlightLines,
  renderLine,
}: {
  code: string
  language?: string
  highlightLines?: number[]
  renderLine?: (line: CodeLine) => ReactNode
}) {
  const hl = new Set(highlightLines ?? [])
  const grammar = grammarFor(language)
  const row = (lineNo: number, content: ReactNode) => {
    const line = { lineNo, content, highlighted: hl.has(lineNo) }
    return (
      <Fragment key={lineNo}>
        {renderLine ? (
          renderLine(line)
        ) : (
          <div className={clsx('px-3', line.highlighted && 'bg-accent-500/25')}>
            <span className="mr-3 inline-block w-6 select-none text-right text-white/30">{lineNo}</span>
            {content}
          </div>
        )}
      </Fragment>
    )
  }
  if (!grammar) return <>{code.split('\n').map((ln, i) => row(i + 1, ln || ' '))}</>
  return (
    <Highlight code={code} language={grammar} theme={themes.vsDark}>
      {({ tokens, getTokenProps }) => (
        <>
          {tokens.map((line, i) =>
            row(
              i + 1,
              line.every((t) => t.empty) ? ' ' : line.map((token, j) => <span key={j} {...getTokenProps({ token })} />),
            ),
          )}
        </>
      )}
    </Highlight>
  )
}
