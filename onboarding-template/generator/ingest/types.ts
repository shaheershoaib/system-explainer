/**
 * The corpus contract: every source a course is built from (a meeting note, a PDF, a Notion page,
 * a transcript, a web page) is normalized into a markdown file under one corpus directory, with
 * front matter saying where it came from. The course loop, the grounding gate, the proof harness
 * and reverify then read the corpus exactly as they read a repository. "Works with anything" means
 * "anything that can become a text file with a stable path"; what cannot is refused loudly with a fix.
 *
 * A code repository is the one source that is NOT copied: it stays where it is and is the grounding
 * root, with the corpus beside it at <repo>/.system-explainer/corpus (mixed mode).
 */

/** What a source is. Detection maps a CLI argument to one of these; the registry says how to reach it. */
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
  | 'spreadsheet' // .xlsx (refused with a fix: export CSV)
  | 'csv'
  | 'json'
  | 'email' // .eml
  | 'image' // needs --transcribe
  | 'audio-video' // refused with a fix: pass the transcript instead
  // remote, reachable from the CLI with a documented API or public export
  | 'web'
  | 'notion'
  | 'granola'
  | 'google-doc'
  | 'google-slides'
  | 'google-sheet'
  | 'github'
  // recognized, not reachable from the CLI: refused with the connector or export that works
  | 'slack'
  | 'loom'
  | 'confluence'
  | 'google-drive'
  | 'meeting-recording'
  | 'unknown'

/** One CLI argument after detection. `target` is the normalized path, URL or id the adapter reads. */
export interface SourceSpec {
  raw: string
  kind: SourceKind
  target: string
}

/** One normalized document in the corpus. */
export interface CorpusDoc {
  /** Corpus-relative POSIX path, e.g. "granola-weekly-sync-2026-09-16/notes.md". Slug characters only. */
  path: string
  /** Stable id of the source this doc came from (one source can yield several docs: a folder, a Notion tree, a Granola note + its transcript). */
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
}

/** Why a source could not be read, and what the user can do about it. Rendered loudly, never swallowed. */
export interface SourceProblem {
  /** The argument exactly as the user typed it. */
  source: string
  kind: SourceKind
  /** One plain sentence: what failed. Example: "NOTION_TOKEN is not set, so the Notion API cannot be called." */
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

/** Directories under <workspace>/.system-explainer that hold the run's own output. Hidden from the agents' sandbox in mixed mode so they read only code + corpus. */
export const RUN_OUTPUT_DIRS = ['auto-course', 'bundles', 'proof-runs', 'site', 'transcripts', 'sources'] as const
