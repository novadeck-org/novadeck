import {
  highlightIcon,
  noteAreas,
  type HighlightIcon,
  type NoteArea,
} from "../../contract/protocol/src/release-notes.ts"
import { chat, demo } from "./commits.ts"
import { type ModelOutput } from "./model.ts"

// What the prompt asks for, and the most the check takes. The cheaper model runs past the asked
// length about a quarter of the time, by the clause that says what a change is for, and those
// are often its best lines; a line this long is still three lines on the card. Past these, the
// line is dropped. A highlight is read at a glance on the card, so its line is shorter.
export const askedTitle = 30
export const askedLine = 110
export const askedHighlightLine = 70
export const maxTitle = 36
export const maxLine = 140
export const maxHighlightLine = 90
// The most the notes' schema holds (contract/protocol/src/release-notes.ts): an answer past
// these would pass here and throw when the block is written.
export const maxHighlights = 4
// A prerelease's card leads with fewer, early builds coming several a day. A release's
// highlights repeat lines of its changes, so past these they are dropped, not the answer,
// and the changes still tell them.
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

// Text whose letters are more than `share` in a script other than Latin. A model that answers in
// another language mostly does so for the whole answer, which fails; a line of its own in one
// is dropped. A unit such as µs or a quoted 日本語 or Ελληνικά stays a few letters of an English
// line and passes. A drift into another language written in Latin letters isn't caught here.
const letters = /\p{L}/gu
const nonLatin = /(?!\p{Script=Latin})\p{L}/gu
const foreign = (text: string, share: number): boolean =>
  (text.match(nonLatin)?.length ?? 0) > (text.match(letters)?.length ?? 0) * share

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

// A highlight keeps its place when its icon is not one of ours: the notes always carry one,
// and a generic icon is a small loss next to a lost highlight.
const fallbackIcon: HighlightIcon = "sparkles"

export type Checked =
  | {
      readonly ok: true
      readonly output: {
        readonly highlights: { title: string; line: string; prs: number[]; icon: HighlightIcon }[]
        readonly changes: { area: NoteArea; line: string; prs: number[] }[]
      }
      /** Why each dropped line was dropped, never the line: logs and summaries are public. */
      readonly dropped: readonly string[]
    }
  | { readonly ok: false; readonly reason: string }

const fail = (reason: string): Checked => ({ ok: false, reason })

/**
 * Whether the model's answer can be published, and what of it. A whole-answer failure is a
 * size the notes can't hold, a sign of steering (links, URLs, HTML), or an answer mostly in a
 * script other than English's. A line that breaks a softer rule (a citation the notes can't
 * hold or a pull request that was not given, too long, markup, an excluded topic, a line mostly
 * in another script, an unknown area, a release's highlight past `releaseHighlights` or citing
 * no feature) is dropped, and `dropped` says why. A highlight whose icon is missing or not in the set keeps its place with
 * "sparkles". `allowed` holds the pull requests the model was given, and `features` those of
 * them that are `feat` changes: the cheaper model a release asks makes a highlight of nearly
 * any change, fixes too, whatever it is told, so a release's highlight has to tell a feature.
 */
export const checkOutput = (
  output: ModelOutput,
  kind: "release" | "promote",
  allowed: ReadonlySet<number>,
  features: ReadonlySet<number> = allowed,
): Checked => {
  if (kind === "promote" && output.highlights.length > maxHighlights)
    return fail(`At most ${maxHighlights} highlights, got ${output.highlights.length}`)
  if (output.changes.length > maxChanges)
    return fail(`At most ${maxChanges} changes, got ${output.changes.length}`)
  const written = [...output.highlights, ...output.changes]
    .flatMap((item) => ["title" in item ? item.title : "", item.line])
    .join("\n")
  if (foreign(written, 0.3)) return fail("The answer is not written in English")
  const dropped: string[] = []
  const highlights: { title: string; line: string; prs: number[]; icon: HighlightIcon }[] = []
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
          : title !== undefined &&
              (!title || title.length > maxTitle || !line || line.length > maxHighlightLine)
            ? `a highlight's title or line outside 1 to ${maxTitle}/${maxHighlightLine} characters`
            : !line || line.length > maxLine
              ? `a line outside 1 to ${maxLine} characters`
              : markup.test(text) ||
                  autolinked.test(text) ||
                  [title, line].some((part) => part !== undefined && structural.test(part))
                ? "a markup character"
                : topic
                  ? `an excluded topic ${topic}`
                  : foreign(text, 0.5)
                    ? "a line in another script"
                    : title === undefined && !isArea("area" in item ? item.area : "")
                      ? "an area that is not one of ours"
                      : title !== undefined &&
                          kind === "release" &&
                          !item.prs.some((pr) => features.has(pr))
                        ? "a release's highlight that tells no feature"
                        : undefined
    if (reason) {
      dropped.push(reason)
      continue
    }
    if (title !== undefined && kind === "release" && highlights.length === releaseHighlights)
      dropped.push(`a highlight past the ${releaseHighlights} a release leads with`)
    else if (title !== undefined) {
      const icon = highlightIcon.safeParse("icon" in item ? item.icon : undefined)
      highlights.push({ title, line, prs: item.prs, icon: icon.success ? icon.data : fallbackIcon })
    } else changes.push({ area: (item as { area: NoteArea }).area, line, prs: item.prs })
  }
  return { ok: true, output: { highlights, changes }, dropped }
}
