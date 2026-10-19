import { noteAreas, type NoteArea } from "../../contract/protocol/src/release-notes.ts"
import { type ModelOutput } from "./model.ts"

export const maxTitle = 40
export const maxLine = 110
// The most the notes' schema holds (contract/protocol/src/release-notes.ts): an answer past
// these would pass here and throw when the block is written.
export const maxHighlights = 4
export const maxChanges = 200
export const maxPrs = 32

// What a title or line must not hold. A line is plain text; a link, markup or a mention means
// the model was steered by a commit or a pull request description, so the whole answer goes.
// (`@` is not here: terminals' word handles such as @moth are a feature's name, and the
// rendered body puts them in code spans so GitHub mentions nobody.)
const steered: readonly RegExp[] = [
  /\]\(/,
  /\[/,
  /</,
  />/,
  /https?:/i,
  /\bwww\./i,
  /`/,
  /!\[/,
  /\*/,
  /~/,
  /\\/,
]

// What is not for the notes: the chat view ships behind a flag, and the demo, the website and
// the pipeline are not the app. A line that mentions one is dropped, the rest stands.
const excluded: readonly RegExp[] = [
  /\bchat\b/i,
  /\bdemo\b/i,
  /try\.novadeck/i,
  /\bwebsite\b/i,
  /\bCI\b/,
  /\bgithub actions?\b/i,
]

const isArea = (area: string): area is NoteArea => (noteAreas as readonly string[]).includes(area)

export type Checked =
  | {
      readonly ok: true
      readonly output: {
        readonly highlights: ModelOutput["highlights"]
        readonly changes: { area: NoteArea; line: string; prs: number[] }[]
      }
      readonly dropped: readonly string[]
    }
  | { readonly ok: false; readonly reason: string }

const fail = (reason: string): Checked => ({ ok: false, reason })

/**
 * Whether the model's answer can be published, and what of it. A whole-answer failure is a
 * size or shape the notes can't hold, a pull request it was not given, or markup and links; a
 * line on an excluded topic or in an unknown area is dropped and named in `dropped`. `allowed`
 * holds the pull requests the model was given.
 */
export const checkOutput = (output: ModelOutput, allowed: ReadonlySet<number>): Checked => {
  if (output.highlights.length > maxHighlights)
    return fail(`At most ${maxHighlights} highlights, got ${output.highlights.length}`)
  if (output.changes.length > maxChanges)
    return fail(`At most ${maxChanges} changes, got ${output.changes.length}`)
  const dropped: string[] = []
  const highlights: ModelOutput["highlights"] = []
  const changes: { area: NoteArea; line: string; prs: number[] }[] = []
  for (const item of [...output.highlights, ...output.changes]) {
    const title = "title" in item ? item.title.trim() : undefined
    const line = item.line.trim()
    if (title !== undefined && (!title || title.length > maxTitle))
      return fail(`Title "${title}" is not 1 to ${maxTitle} characters`)
    if (!line || line.length > maxLine)
      return fail(`Line "${line}" is not 1 to ${maxLine} characters`)
    if (item.prs.length === 0 || item.prs.length > maxPrs)
      return fail(`Line "${line}" cites ${item.prs.length} pull requests, not 1 to ${maxPrs}`)
    const stranger = item.prs.find((pr) => !allowed.has(pr))
    if (stranger !== undefined)
      return fail(`Line "${line}" cites #${stranger}, which was not given`)
    const text = [title, line].join("\n")
    const markup = steered.find((pattern) => pattern.test(text))
    if (markup) return fail(`"${line}" holds ${markup}, which plain text doesn't`)
    const topic = excluded.find((pattern) => pattern.test(text))
    if (topic) {
      dropped.push(`"${title ?? line}" mentions ${topic}`)
      continue
    }
    if (title !== undefined) {
      highlights.push({ title, line, prs: item.prs })
      continue
    }
    const area = "area" in item ? item.area : ""
    if (!isArea(area)) {
      dropped.push(`"${line}" is in the area "${area}", which is not one of ours`)
      continue
    }
    changes.push({ area, line, prs: item.prs })
  }
  return { ok: true, output: { highlights, changes }, dropped }
}
