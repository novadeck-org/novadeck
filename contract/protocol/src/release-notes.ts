import { z } from "zod"

/**
 * The notes of a release, as the release pipeline writes them and the app reads them back to
 * show a once-only "New in" card after an update. They travel inside the release's body as an
 * HTML comment (`notesBlock`), so the one record serves the page people read on GitHub and the
 * app, and nothing else has to be hosted. Nothing here imports from the rest of the protocol:
 * the pipeline's scripts read this file's source directly, with no package built first.
 */

/**
 * The areas a line belongs to, in the order the notes list them. Fixed, so the card groups the
 * same way every time and a model can't coin a heading.
 */
export const noteAreas = [
  "Agents",
  "Terminals",
  "Inbox & notifications",
  "Projects & pins",
  "Voice",
  "Updates & install",
  "Look & feel",
  "Fixes & speedups",
] as const
export const noteArea = z.enum(noteAreas)
export type NoteArea = z.infer<typeof noteArea>

// Generous bounds: they keep a hand-edited block from becoming a megabyte, while the pipeline's
// own checks (scripts/release-notes/check.ts) hold the tighter limits its output keeps to.
const prs = z.array(z.number().int().positive()).max(32)
const text = (max: number) => z.string().trim().min(1).max(max)

export const releaseNotes = z.strictObject({
  /** The version, without the `v`. */
  version: text(64),
  /** A prerelease's own notes, or the notes of a promotion, which cover every release since the last stable one. */
  kind: z.enum(["release", "promote"]),
  /** What to lead with: up to two in a prerelease's own notes, four in a promotion's. */
  highlights: z.array(z.strictObject({ title: text(80), line: text(240), prs })).max(4),
  changes: z.array(z.strictObject({ area: noteArea, line: text(240), prs })).max(200),
  /** How many smaller fixes and speedups the lines above leave unnamed. */
  fixes: z.number().int().min(0).max(10_000),
})
export type ReleaseNotes = z.infer<typeof releaseNotes>

const marker = "novadeck:notes"

/**
 * The notes as the hidden block that goes in the release's body. `--` is escaped (`-` is
 * `-` to JSON), so no text of the notes can close the comment early or open another.
 */
export const notesBlock = (notes: ReleaseNotes): string =>
  `<!-- ${marker} ${JSON.stringify(releaseNotes.parse(notes)).replaceAll("--", "\\u002d\\u002d")} -->`

// What the reader accepts. A block lives in a body that outlasts the code that wrote it, and
// a later pipeline may add fields or areas, so the reader keeps what it knows and ignores the
// rest: unknown keys are stripped, and a change in an area it doesn't know is dropped (the
// app has no heading for it). What would break the writer's bounds is clamped so the value
// returned is always a valid `ReleaseNotes`: an item with a too long title or line or bad
// pull request numbers is dropped, extra highlights and changes are cut, a bad `fixes` is 0.
// A block whose shape it can't make sense of, or whose `kind` is new, reads as no block.
const lenient = z.object({
  version: z.unknown(),
  kind: z.enum(["release", "promote"]),
  highlights: z.array(z.unknown()),
  changes: z.array(z.unknown()),
  fixes: z.unknown(),
})
const highlight = z.object({ title: text(80), line: text(240), prs })
const change = z.object({ area: noteArea, line: text(240), prs })
const keep = <T>(items: unknown[], schema: z.ZodType<T>, max: number): T[] =>
  items
    .flatMap((item) => {
      const result = schema.safeParse(item)
      return result.success ? [result.data] : []
    })
    .slice(0, max)

/**
 * The notes in a release's body, or `undefined` when it has no block or the block is not
 * notes: a body is hand-editable, so nothing about it can be trusted to be there or whole.
 */
export const readNotesBlock = (body: string): ReleaseNotes | undefined => {
  const found = new RegExp(`<!-- ${marker} (\\{.*?\\}) -->`, "s").exec(body)
  if (!found?.[1]) return undefined
  try {
    const parsed = lenient.safeParse(JSON.parse(found[1]))
    const version = text(64).safeParse(parsed.data?.version)
    if (!parsed.success || !version.success) return undefined
    const fixes = z.number().int().min(0).max(10_000).safeParse(parsed.data.fixes)
    return {
      version: version.data,
      kind: parsed.data.kind,
      highlights: keep(parsed.data.highlights, highlight, 4),
      changes: keep(parsed.data.changes, change, 200),
      fixes: fixes.success ? fixes.data : 0,
    }
  } catch {
    return undefined
  }
}
