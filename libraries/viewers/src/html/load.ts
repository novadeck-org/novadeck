import { pageNames, type PageFile } from "./page.js"
import { cssNames, folderOf, isStyle } from "./refs.js"

// A page's files, read for it: the page's text names some, its stylesheets name more, and each
// is asked for by its name from the page's folder, which the app has the runner read. The most
// the runner reads for a page (protocol's `pageLimits`) is kept to here too.
export const pageLimits = { file: 16 * 1024 * 1024, files: 64, bytes: 32 * 1024 * 1024 } as const

/** Reads one file by its name from the page's folder: undefined where it can't be read. */
export type ReadPageFile = (name: string) => Promise<Uint8Array<ArrayBuffer> | undefined>

// How many files are asked for at once, and how many stylesheets deep the names go.
const together = 6
const levels = 8

/**
 * Every file a page draws with: those its text names, then those the stylesheets among them
 * name, and so on, each once. One that can't be read is left out, as is any past the limits;
 * the page draws without it. `undefined` once `signal` says to stop.
 */
export const loadPage = async ({
  html,
  read,
  signal,
}: {
  readonly html: string
  readonly read: ReadPageFile
  readonly signal: AbortSignal
}): Promise<readonly PageFile[] | undefined> => {
  const files: PageFile[] = []
  const seen = new Set<string>()
  let total = 0
  let level = pageNames(html)
  for (let depth = 0; depth < levels && level.length > 0; depth += 1) {
    const next: string[] = []
    const wanted = level.filter((name) => !seen.has(name)).slice(0, pageLimits.files - files.length)
    for (const name of wanted) seen.add(name)
    for (let from = 0; from < wanted.length; from += together) {
      // eslint-disable-next-line no-await-in-loop -- A few at a time, as the runner is asked.
      const batch = await Promise.all(
        wanted
          .slice(from, from + together)
          .map(async (name) => ({ name, bytes: await read(name) })),
      )
      if (signal.aborted) return undefined
      for (const { name, bytes } of batch) {
        if (!bytes || bytes.length > pageLimits.file || total + bytes.length > pageLimits.bytes)
          continue
        total += bytes.length
        files.push({ name, bytes })
        if (isStyle(name)) next.push(...cssNames(new TextDecoder().decode(bytes), folderOf(name)))
      }
    }
    level = next
  }
  return files
}

/**
 * What a page and its files are as a whole, by a digest of their text and bytes: a page read
 * again that comes out the same needs no new drawing.
 */
export const pageKey = (html: string, files: readonly PageFile[]): string => {
  // cyrb53, over each unit of text and each byte.
  let one = 0xdeadbeef
  let two = 0x41c6ce57
  const feed = (unit: number): void => {
    one = Math.imul(one ^ unit, 2654435761)
    two = Math.imul(two ^ unit, 1597334677)
  }
  for (let at = 0; at < html.length; at += 1) feed(html.charCodeAt(at))
  for (const file of files) {
    feed(-1)
    for (let at = 0; at < file.name.length; at += 1) feed(file.name.charCodeAt(at))
    feed(-2)
    for (const byte of file.bytes) feed(byte)
  }
  one = Math.imul(one ^ (one >>> 16), 2246822507) ^ Math.imul(two ^ (two >>> 13), 3266489909)
  two = Math.imul(two ^ (two >>> 16), 2246822507) ^ Math.imul(one ^ (one >>> 13), 3266489909)
  return `${html.length}:${files.length}:${(4294967296 * (2097151 & two) + (one >>> 0)).toString(36)}`
}
