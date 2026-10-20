import {
  noteAreas,
  notesBlock,
  type NoteArea,
  type ReleaseNotes,
} from "../../contract/protocol/src/release-notes.ts"

const summaryOfOriginal = "All commits"
const compareLabel = "[Compare on GitHub]"

/** The links to the pull requests a line comes from. */
const links = (prs: readonly number[], repo: string): string =>
  prs.length === 0
    ? ""
    : ` (${prs.map((pr) => `[#${pr}](https://github.com/${repo}/pull/${pr})`).join(", ")})`

// A terminal's word handle (@moth) is written in a code span, so GitHub mentions nobody by it.
const plain = (text: string): string => text.replace(/(?<![\w`])@([\w-]+)/g, "`@$1`")

const bullet = (line: string, prs: readonly number[], repo: string): string =>
  `- ${plain(line)}${links(prs, repo)}`

/** The lines of each area that has any, areas in their fixed order. */
const byArea = (changes: ReleaseNotes["changes"]) =>
  noteAreas
    .map((area: NoteArea) => ({ area, lines: changes.filter((change) => change.area === area) }))
    .filter(({ lines }) => lines.length > 0)

/**
 * The release's whole body: the notes people read, the hidden block the app reads, and the
 * changelog release-it wrote, folded away so nothing is lost. `original` is that changelog.
 */
export const renderBody = (
  notes: ReleaseNotes,
  original: string,
  repo: string,
  compare?: string,
): string => {
  const sections: string[] = []
  // When there is a "Fixes & speedups" area, the count of the smaller ones closes it.
  const fixesIn = byArea(notes.changes).some(({ area }) => area === "Fixes & speedups")
  const areas = byArea(notes.changes).map(
    ({ area, lines }) =>
      `### ${area}\n\n${lines.map((change) => bullet(change.line, change.prs, repo)).join("\n")}${
        area === "Fixes & speedups" && notes.fixes > 0
          ? `\n\nPlus ${notes.fixes} smaller ${notes.fixes === 1 ? "fix or speedup" : "fixes and speedups"}.`
          : ""
      }`,
  )
  if (notes.kind === "promote") {
    if (notes.highlights.length > 0)
      sections.push(
        `## Highlights\n\n${notes.highlights
          .map(
            (highlight) =>
              `- **${plain(highlight.title)}**: ${plain(highlight.line)}${links(highlight.prs, repo)}`,
          )
          .join("\n")}`,
      )
    if (areas.length > 0) sections.push(`## What's new\n\n${areas.join("\n\n")}`)
    if (notes.fixes > 0 && !fixesIn)
      sections.push(
        `## Fixes and speedups\n\n${notes.fixes} smaller ${notes.fixes === 1 ? "fix or speedup" : "fixes and speedups"}${notes.highlights.length + areas.length > 0 ? " besides the ones above" : ""}.`,
      )
    if (sections.length === 0)
      sections.push("Nothing in this build changes what you see in the app.")
  } else {
    sections.push(...areas)
    if (notes.fixes > 0 && !fixesIn)
      sections.push(
        `${areas.length > 0 ? "Plus " : ""}${notes.fixes} smaller ${notes.fixes === 1 ? "fix or speedup" : "fixes and speedups"}.`,
      )
    if (sections.length === 0)
      sections.push("Nothing in this build changes what you see in the app.")
  }
  sections.push(notesBlock(notes))
  const kept = [compare ? `${compareLabel}(${compare})` : "", original.trim()].filter(Boolean)
  if (kept.length > 0)
    sections.push(
      `<details><summary>${summaryOfOriginal}</summary>\n\n${kept.join("\n\n")}\n\n</details>`,
    )
  return `${sections.join("\n\n")}\n`
}

/**
 * The changelog inside a body this tool wrote, or the body itself when it didn't: running
 * again on a release already rewritten keeps release-it's text and not our own on top of it
 * (nor the promotion's link to the range, which the new run writes again).
 */
export const originalOf = (body: string | undefined): string => {
  if (!body) return ""
  const start = `<details><summary>${summaryOfOriginal}</summary>`
  const from = body.lastIndexOf(start)
  if (from >= 0 && body.trimEnd().endsWith("</details>"))
    return body
      .slice(from + start.length)
      .replace(/<\/details>\s*$/, "")
      .trim()
      .replace(/^\[Compare on GitHub\]\([^)\n]*\)\s*/, "")
  return body.trim()
}

/** GitHub refuses a release body past 125,000 characters; this leaves some room. */
export const maxBody = 120_000

const cut = "\n\n(The rest of the changelog is cut for length.)"

/**
 * The rendered body within `limit`: the changelog is shortened first, with a note, and the
 * notes themselves are never cut. `undefined` when they alone are too long.
 */
export const fitBody = (
  notes: ReleaseNotes,
  original: string,
  repo: string,
  compare: string | undefined,
  limit = maxBody,
): string | undefined => {
  const whole = renderBody(notes, original, repo, compare)
  if (whole.length <= limit) return whole
  const bare = renderBody(notes, "", repo, compare)
  const room = limit - bare.length - cut.length - 200
  if (room <= 0 || bare.length > limit) return undefined
  const body = renderBody(notes, `${original.slice(0, room).trimEnd()}${cut}`, repo, compare)
  return body.length <= limit ? body : undefined
}
