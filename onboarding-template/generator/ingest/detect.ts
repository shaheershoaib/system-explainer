/**
 * Maps one CLI argument to a format-level SourceKind. Detection knows file extensions, directories,
 * http(s) URLs and git remote shapes; it knows no service. Anything that is neither an existing
 * path nor a URL is a "reference" (e.g. "the Q3 planning doc") for the access agent, unless it is
 * shaped like a path, in which case it is a missing path.
 */
import { existsSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SourceKind, SourceSpec } from './types'

const EXTENSIONS: Record<string, SourceKind> = {
  md: 'markdown',
  markdown: 'markdown',
  txt: 'text',
  rst: 'text',
  org: 'text',
  adoc: 'text',
  html: 'html',
  htm: 'html',
  vtt: 'transcript',
  srt: 'transcript',
  pdf: 'pdf',
  docx: 'word',
  pptx: 'slides',
  xlsx: 'spreadsheet',
  xls: 'spreadsheet',
  numbers: 'spreadsheet',
  ods: 'spreadsheet',
  csv: 'csv',
  tsv: 'csv',
  json: 'json',
  eml: 'email',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  mp3: 'audio-video',
  m4a: 'audio-video',
  wav: 'audio-video',
  aac: 'audio-video',
  ogg: 'audio-video',
  flac: 'audio-video',
  mp4: 'audio-video',
  m4v: 'audio-video',
  mov: 'audio-video',
  webm: 'audio-video',
  mkv: 'audio-video',
  avi: 'audio-video',
}

/** Kind for a file name by its extension; an unknown extension is 'text' (sniffed when read). */
export function kindForFile(file: string): SourceKind {
  const ext = path.extname(file).slice(1).toLowerCase()
  return EXTENSIONS[ext] ?? 'text'
}

/** True when the extension is one the format layer knows (unknown ones are sniffed as text). */
export const knownExtension = (file: string) => path.extname(file).slice(1).toLowerCase() in EXTENSIONS

/** scp-like `user@host:path` or an ssh:// URL. Never starts with "-", so it cannot be read as a git option. */
export function isSshGitUrl(s: string): boolean {
  if (/^ssh:\/\/[A-Za-z0-9._~%-]+(?:@[A-Za-z0-9.-]+)?(?::\d+)?\/[A-Za-z0-9._~\/-]+$/.test(s)) return true
  return /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~][A-Za-z0-9._~\/-]*$/.test(s)
}

/** Shaped like a file path: explicit prefix, or no spaces and a separator or an extension. */
export function looksLikePath(s: string): boolean {
  if (/^(?:\.{1,2}[\\/]|[\\/]|~(?:[\\/]|$)|[A-Za-z]:[\\/])/.test(s)) return true
  return !/\s/.test(s) && !s.includes(':') && (/[\\/]/.test(s) || /\.[A-Za-z0-9]{1,5}$/.test(s))
}

/** A non-path, non-URL argument (target is not absolute): handed to the access agent. */
export const isReference = (spec: SourceSpec) => spec.kind === 'unknown' && !path.isAbsolute(spec.target)

const BARE_URL = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S*$/i

export function detectSource(raw: string, cwd: string): SourceSpec {
  const s = raw.trim()
  if (/^https?:\/\//i.test(s)) {
    try {
      return { raw, kind: 'web', target: new URL(s).href }
    } catch {
      return { raw, kind: 'unknown', target: s }
    }
  }
  if (isSshGitUrl(s)) return { raw, kind: 'git-remote', target: s }
  if (/^file:\/\//i.test(s)) {
    try {
      return local(raw, fileURLToPath(s), s)
    } catch {
      return { raw, kind: 'unknown', target: s }
    }
  }
  const abs = path.resolve(cwd, s.replace(/^~(?=$|[\\/])/, os.homedir()))
  if (!existsSync(abs) && BARE_URL.test(s) && !/^\.{0,2}[\\/]/.test(s)) return { raw, kind: 'web', target: new URL(`https://${s}`).href }
  return local(raw, abs, s)
}

function local(raw: string, abs: string, s: string): SourceSpec {
  let st
  try {
    st = statSync(abs)
  } catch {
    return { raw, kind: 'unknown', target: looksLikePath(s) ? abs : s }
  }
  if (st.isDirectory()) return { raw, kind: existsSync(path.join(abs, '.git')) ? 'repo' : 'folder', target: abs }
  return { raw, kind: kindForFile(abs), target: abs }
}
