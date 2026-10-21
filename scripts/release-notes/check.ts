import { noteAreas, type NoteArea } from "../../contract/protocol/src/release-notes.ts"
import { chat, demo } from "./commits.ts"
import { type ModelOutput } from "./model.ts"

export const maxTitle = 40
export const maxLine = 110
// The most the notes' schema holds (contract/protocol/src/release-notes.ts): an answer past
// these would pass here and throw when the block is written.
export const maxHighlights = 4
// A prerelease's card leads with fewer, early builds coming several a day. Past these the
// highlights are dropped, not the answer.
export const releaseHighlights = 2
export const maxChanges = 200
export const maxPrs = 32

// Signs the model was steered by a commit or a pull request description: a link, an image, a
// URL or an HTML tag. They fail the whole answer. (`@` is not here: terminals' word handles
// such as @moth are a feature's name, and the rendered body puts them in code spans so
// GitHub mentions nobody.)
const steered: readonly [RegExp, string][] = [
  [/\]\(/, "a Markdown link"],
  [/!\[/, "a Markdown image"],
  [/https?:/i, "a URL"],
  [/\bwww\./i, "a URL"],
  [/<[a-z/!]/i, "an HTML tag"],
]

// Markup a plain line has no use for. A slip drops that line and the rest stands.
const markup = /[*~\\`[<>]/
// An address or an issue number GitHub would turn into a link, and a line that would open as a heading or a list.
const autolinked = /\S+@\S+\.\w+|#\d+/
const structural = /^\s*(?:#|\d+\. )/

// What is not for the notes: the chat view ships behind a flag, early builds are for
// contributors and never offered to people, and the demo, the website and the pipeline are
// not the app. A line that mentions one is dropped, the rest stands.
const excluded: readonly RegExp[] = [
  chat,
  /\b(?:early|beta|nightly|canary)\s+(?:access\s+)?(?:builds?|channels?|releases?|updates?|versions?)\b/i,
  /\bupdate channels?\b/i,
  /\bprereleases?\b/i,
  demo,
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
      /** Why each dropped line was dropped, never the line: logs and summaries are public. */
      readonly dropped: readonly string[]
    }
  | { readonly ok: false; readonly reason: string }

const fail = (reason: string): Checked => ({ ok: false, reason })

/**
 * Whether the model's answer can be published, and what of it. A whole-answer failure is a
 * size the notes can't hold or a sign of steering (links, URLs, HTML). A line that breaks a
 * softer rule (a citation the notes can't hold or a pull request that was not given, too long,
 * markup, an excluded topic, an unknown area, a release's highlight past `releaseHighlights`)
 * is dropped, and `dropped` says why. `allowed` holds the pull requests the model was given.
 */
export const checkOutput = (
  output: ModelOutput,
  kind: "release" | "promote",
  allowed: ReadonlySet<number>,
): Checked => {
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
    const text = [title, line].join("\n")
    const steer = steered.find(([pattern]) => pattern.test(text))
    if (steer) return fail(`A line holds ${steer[1]}, which plain text doesn't`)
    const topic = excluded.find((pattern) => pattern.test(text))
    // A citation the notes can't hold, or one the model wasn't given, costs that line only.
    const reason =
      item.prs.length === 0 || item.prs.length > maxPrs
        ? `a line citing no pull request or more than ${maxPrs}`
        : item.prs.some((pr) => !allowed.has(pr))
          ? "a line citing a pull request that was not given"
          : (title !== undefined && (!title || title.length > maxTitle)) ||
              !line ||
              line.length > maxLine
            ? `a title or line outside 1 to ${maxTitle}/${maxLine} characters`
            : markup.test(text) ||
                autolinked.test(text) ||
                [title, line].some((part) => part !== undefined && structural.test(part))
              ? "a markup character"
              : topic
                ? `an excluded topic ${topic}`
                : title === undefined && !isArea("area" in item ? item.area : "")
                  ? "an area that is not one of ours"
                  : undefined
    if (reason) {
      dropped.push(reason)
      continue
    }
    if (title !== undefined && kind === "release" && highlights.length === releaseHighlights)
      dropped.push(`a highlight past the ${releaseHighlights} a release leads with`)
    else if (title !== undefined) highlights.push({ title, line, prs: item.prs })
    else changes.push({ area: (item as { area: NoteArea }).area, line, prs: item.prs })
  }
  return { ok: true, output: { highlights, changes }, dropped }
}
