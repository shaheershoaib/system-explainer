/**
 * The corpus contract: every source a course is built from (a meeting note, a PDF, a wiki page,
 * a transcript, a web page) is normalized into a markdown file under one corpus directory, with
 * front matter saying where it came from. The course loop, the grounding gate, the proof harness
 * and reverify then read the corpus exactly as they read a repository. "Works with anything" means
 * "anything that can become a text file with a stable path"; what cannot is refused loudly with a fix.
 *
 * A code repository is the one source that is NOT copied: it stays where it is and is the grounding
 * root, with the corpus beside it at <repo>/.system-explainer/corpus (mixed mode).
 */

/**
 * What a source is, at the level of FORMAT, never of service. The code knows how to read file formats
 * and plain URLs; it knows nothing about Notion, Granola, Slack or any other product. A source the
 * format layer cannot read goes to the access agent, which reasons from what was provided (the URL's
 * response, the credential NAMES in the environment, the tools on PATH) about how to reach it, and
 * either reaches it or explains what would unlock it. The service it reached is a free-form label on
 * the doc (`service`), never a branch in the code.
 */
export type SourceKind =
  // local files and folders
  | 'repo' // a directory with a .git: code, grounded in place, never copied
  | 'folder' // any other directory: every readable file inside is ingested
  | 'markdown'
  | 'text'
  | 'html'
  | 'transcript' // .vtt / .srt
  | 'pdf'
  | 'word' // .docx
  | 'slides' // .pptx
  | 'spreadsheet' // .xlsx and friends: no parser; the access agent or the user exports CSV
  | 'csv'
  | 'json'
  | 'email' // .eml
  | 'image' // needs --transcribe
  | 'audio-video' // no transcriber in the CLI: the user passes a transcript
  // remote
  | 'git-remote' // a URL `git ls-remote` accepts, on any host: shallow-cloned, then treated as a repo
  | 'web' // a URL read with one plain GET and parsed by content type
  | 'remote' // anything the access agent reached by reasoning (an API, an export URL, a linked file)
  | 'unknown'

/** One CLI argument after detection. `target` is the normalized path, URL or id the adapter reads. */
export interface SourceSpec {
  raw: string
  kind: SourceKind
  target: string
}

/** One normalized document in the corpus. */
export interface CorpusDoc {
  /** Corpus-relative POSIX path, e.g. "remote-weekly-sync-3f2a1c/weekly-sync-2026-09-16.md". Slug characters only. */
  path: string
  /** Stable id of the source this doc came from (one source can yield several docs: a folder, a page tree, a meeting note + its transcript). */
  sourceId: string
  title: string
  kind: SourceKind
  /** Where it came from: an absolute local path or a URL. Never a secret (tokens are not part of origins). */
  origin: string
  /** ISO date (YYYY-MM-DD) the CONTENT is from: the meeting date, the page's last edit, the file's mtime as a last resort. */
  date?: string
  /** People attributed in the content (meeting attendees, transcript speakers). */
  speakers?: string[]
  retrievedAt: string
  /** sha256 of the normalized file's bytes: reverify compares this to decide what changed. */
  sha256: string
  bytes: number
  /** Set when the text was produced by a model (a scanned PDF, an image), never by a parser: the proof report says so. */
  transcribedBy?: string
  /** Free-form name of the system the content came from, as the access agent identified it (the product name of a wiki, a meeting-notes app, a ticket tracker). A label, never a code path. */
  service?: string
  /** How the content was obtained, in plain words ("public URL", "the app's API using ACME_TOKEN", "local file"). */
  via?: string
}

/** Why a source could not be read, and what the user can do about it. Rendered loudly, never swallowed. */
export interface SourceProblem {
  /** The argument exactly as the user typed it. */
  source: string
  kind: SourceKind
  /** What the tools observed, verbatim and short ("HTTP 302 to a sign-in page", "pdftotext not on PATH"). */
  observed?: string
  /** One plain sentence: what failed and why, specific to THIS source. Written by the access agent's reasoning when it was involved. */
  why: string
  /** Ordered fixes, most direct first. Each is one complete instruction the user can follow without reading docs. */
  fixes: string[]
}

export type SourceStatus = 'ok' | 'unreachable'

export interface ManifestSource {
  raw: string
  kind: SourceKind
  status: SourceStatus
  /** Corpus paths this source produced (empty when unreachable, and for a repo). */
  docs: string[]
  problem?: SourceProblem
}

/** <corpus>/manifest.json. Docs are sorted oldest first by `date` (undated last), then by path. */
export interface CorpusManifest {
  version: 1
  createdAt: string
  sources: ManifestSource[]
  docs: CorpusDoc[]
}

/** code = one repo and nothing else; documents = no repo; mixed = one repo plus documents (code is the reality spine). */
export type CourseMode = 'code' | 'documents' | 'mixed'

/** Written to <workspace>/.system-explainer/run.json so prove / reverify / serve can re-ingest the same sources. */
export interface RunConfig {
  version: 1
  system: string
  mode: CourseMode
  /** The arguments as given to `course`, re-ingested by reverify. Never contains a token. */
  sources: string[]
  /** Absolute path of the repo when mode is code or mixed. */
  repo?: string
  /** The directory every bundle sourcePath is relative to: the repo (code, mixed) or the corpus (documents). */
  groundingRoot: string
}

/**
 * Permission to send the value of environment variable `env` to exactly one https `host`. The access
 * agent may name an env var; it never sees the value, and the value is only ever sent to a host the
 * user granted (a --grant flag, an interactive yes, or <workspace>/.system-explainer/access.json).
 * Host-binding is what stops a prompt-injected document from redirecting a token somewhere else.
 */
export interface CredentialGrant {
  env: string
  host: string
}

/** Directories under <workspace>/.system-explainer that hold the run's own output. Hidden from the agents' sandbox in mixed mode so they read only code + corpus. */
export const RUN_OUTPUT_DIRS = ['auto-course', 'bundles', 'proof-runs', 'site', 'transcripts', 'sources'] as const
