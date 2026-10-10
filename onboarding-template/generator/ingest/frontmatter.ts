/**
 * Shared shapes and text helpers for the ingest layer: the draft every adapter produces, the error
 * an adapter throws to report a problem, and the corpus file format (front matter + normalized
 * content). Nothing here touches the filesystem or the network.
 */
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { SourceKind } from './types'

/** One document an adapter read, before it is written to the corpus. */
export interface Draft {
  kind: SourceKind
  title: string
  content: string
  origin: string
  /** Slug base for the corpus file name; may contain "/" to keep a folder's layout. */
  name: string
  via: string
  date?: string
  speakers?: string[]
  transcribedBy?: string
  service?: string
}

/** What the format layer saw when it could not read a source: handed to the access agent, or quoted in the problem. */
export interface Observation {
  /** One short line, verbatim facts ("HTTP 401 from host", "redirected to a sign-in page"). */
  summary: string
  status?: number
  finalUrl?: string
  contentType?: string
  title?: string
  /** First ~1500 characters of extracted text. */
  textPreview?: string
}

/** Thrown by an adapter when a source (or a file inside a folder) cannot be read. */
export class SourceError extends Error {
  constructor(
    readonly why: string,
    readonly fixes: string[],
    readonly observed?: string,
  ) {
    super(why)
  }
}

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
export const shortHash = (s: string) => sha256(s).slice(0, 6)

/** Lowercase [a-z0-9-] slug, at most `max` characters; "untitled" when nothing is left. */
export function slugify(s: string, max = 60): string {
  const slug = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '')
  return slug || 'untitled'
}

/** CRLF -> LF, no BOM, no trailing spaces, 3+ blank lines -> 2, one trailing newline. */
export function normalizeContent(s: string): string {
  return (
    s
      .replace(/^﻿/, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n(?:[ \t]*\n){3,}/g, '\n\n\n')
      .replace(/^\n+|\n+$/g, '') + '\n'
  )
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})/

/** YYYY-MM-DD when `s` starts with a real calendar date, else undefined. */
export function leadingDate(s: string | undefined | null): string | undefined {
  const m = ISO_DAY.exec(s ?? '')
  if (!m) return undefined
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? m[0].slice(0, 10) : undefined
}

export const dayOf = (d: Date) => d.toISOString().slice(0, 10)

/** "2026-09-16-pricing-review.vtt" -> "Pricing review". */
export function titleFromFileName(file: string): string {
  const stem = path.basename(file).replace(/\.[^.]+$/, '')
  const words = stem
    .replace(/^\d{4}-\d{2}-\d{2}[-_ ]*/, '')
    .replace(/[-_]+/g, ' ')
    .trim()
  const t = words || stem
  return t.charAt(0).toUpperCase() + t.slice(1)
}

export interface DocMeta {
  title: string
  kind: SourceKind
  origin: string
  date?: string
  speakers?: string[]
  service?: string
  via?: string
  transcribedBy?: string
  retrievedAt: string
}

/** The corpus file: a front-matter block (JSON-quoted strings), a blank line, the normalized content. */
export function renderDoc(meta: DocMeta, content: string): string {
  const q = (s: string) => JSON.stringify(s)
  const lines = ['---', `title: ${q(meta.title)}`, `source: ${meta.kind}`, `origin: ${q(meta.origin)}`]
  if (meta.date) lines.push(`date: ${meta.date}`)
  if (meta.speakers?.length) lines.push(`speakers: [${meta.speakers.map(q).join(', ')}]`)
  if (meta.service) lines.push(`service: ${q(meta.service)}`)
  if (meta.via) lines.push(`via: ${q(meta.via)}`)
  if (meta.transcribedBy) lines.push(`transcribed_by: ${q(meta.transcribedBy)}`)
  lines.push(`retrieved: ${meta.retrievedAt}`, '---', '')
  return lines.join('\n') + '\n' + normalizeContent(content)
}

/** First "# heading" of markdown, if any. */
export const firstHeading = (md: string) => /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(md)?.[1].trim()

/** Leading YAML front matter of a markdown file: its `title` and `date` keys only. */
export function readFrontMatter(md: string): { title?: string; date?: string } {
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(md)
  if (!m) return {}
  const value = (key: string) => {
    const v = new RegExp(`^${key}:[ \\t]*(.+)$`, 'm').exec(m[1])?.[1].trim()
    return v?.replace(/^(["'])(.*)\1$/, '$2')
  }
  return { title: value('title'), date: leadingDate(value('date')) }
}

/** "Attendees: Dana, Sam and Priya" -> ["Dana", "Sam", "Priya"]. */
export function attendeesLine(text: string): string[] | undefined {
  const m = /^[*_ ]*(?:attendees|participants|present)[*_ ]*:[*_ ]*(.+)$/im.exec(text)
  if (!m) return undefined
  const names = m[1]
    .split(/,|;|\band\b/)
    .map((s) => s.replace(/[*_]/g, '').trim())
    .filter((s) => s && s.length <= 60)
  return names.length ? names : undefined
}

export const unique = (xs: string[]) => [...new Set(xs.filter(Boolean))]
