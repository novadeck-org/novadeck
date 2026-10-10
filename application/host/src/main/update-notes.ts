import { updateNoteLength, updateNotesLength } from "@novadeck/protocol/bridge"

// More than this of a release's notes is not read; a release's notes are far shorter.
const readLength = 50_000

const namedEntities: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  bull: "\u2022",
  middot: "\u00b7",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  times: "\u00d7",
  larr: "\u2190",
  rarr: "\u2192",
  laquo: "\u00ab",
  raquo: "\u00bb",
  deg: "\u00b0",
}

const decodeEntity = (entity: string, name: string): string => {
  if (name.startsWith("#")) {
    const hex = name[1] === "x" || name[1] === "X"
    const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10)
    // Characters outside Unicode, and the surrogates, are not text.
    if (!Number.isInteger(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return " "
    return String.fromCodePoint(code)
  }
  return namedEntities[name.toLowerCase()] ?? entity
}

// Control and format characters (which include zero-width ones, direction overrides and
// isolates, and the byte order mark) and the line and paragraph separators: nothing a
// line of notes needs, and some reorder or hide what follows.
const unwanted = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

// What ends a line of notes: the close of a block or list item, and a line break.
const blockBoundary = /<\/?(?:li|p|div|ul|ol|h[1-6]|blockquote|pre|tr|table|hr|br)\b[^>]*>/giu

/** One note, cleaned of what the page must not receive and cut to the length it may have. */
const tidy = (line: string): string => {
  const text = line.replace(unwanted, " ").replace(/\s+/gu, " ").trim()
  const characters = Array.from(text)
  if (characters.length <= updateNoteLength) return text
  return `${characters
    .slice(0, updateNoteLength - 1)
    .join("")
    .trimEnd()}…`
}

const linesOfHtml = (html: string): string[] =>
  html
    // Code that GitHub would never let through, and its content, which is not a note.
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, "\n")
    .replace(blockBoundary, "\n")
    .replace(/<!--[\s\S]*?-->/gu, "")
    // A `<` inside a tag ends the search at once, which keeps unclosed ones linear.
    .replace(/<[^<>]*>/gu, "")
    // Decoded once, after the markup is gone, so an escaped tag stays text; the angle
    // brackets that remain are dropped, as the page is promised no markup.
    .replace(/&(#[0-9]{1,8}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/gu, decodeEntity)
    .replace(/[<>]/gu, "")
    .split(/[\r\n]+/u)

/**
 * The notes of a release as plain-text lines for the page: one per list item or paragraph,
 * without markup, entities, control characters or empty lines, each at most
 * `updateNoteLength` long and at most `updateNotesLength` of them. electron-updater gives
 * what GitHub renders, HTML, or a list of `{ version, note }` when it was asked for a full
 * changelog; anything else, or notes with no text, give no lines.
 */
export const releaseNotesLines = (notes: unknown): string[] => {
  const html = (value: unknown): string =>
    typeof value === "string" ? value.slice(0, readLength) : ""
  const sources: string[] = Array.isArray(notes)
    ? notes.map((entry: unknown) =>
        typeof entry === "object" && entry !== null && "note" in entry ? html(entry.note) : "",
      )
    : [html(notes)]
  return sources
    .flatMap(linesOfHtml)
    .map(tidy)
    .filter((line) => line !== "")
    .slice(0, updateNotesLength)
}

/**
 * Whether a release's name, "Novadeck v1.2.3" as the release workflow names them, is the
 * name of `version`'s release: the name ends in the version, alone or after a space and an
 * optional "v".
 */
export const releaseNamed = (name: unknown, version: string): boolean => {
  if (typeof name !== "string") return false
  const trimmed = name.trim()
  if (!trimmed.endsWith(version)) return false
  const before = trimmed.slice(0, trimmed.length - version.length).replace(/v$/u, "")
  return before === "" || before.endsWith(" ")
}

/**
 * The notes of an update's release as lines, or none unless the update information names
 * that release. electron-updater falls back to the newest entry of the releases feed when
 * the promoted tag is not in it, whose notes belong to another version, and gives that
 * entry's title as the release name.
 */
export const updateNotesLines = (info: {
  readonly version: string
  readonly releaseName?: unknown
  readonly releaseNotes?: unknown
}): string[] =>
  releaseNamed(info.releaseName, info.version) ? releaseNotesLines(info.releaseNotes) : []
