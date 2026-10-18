import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { Anchor, AnchorRef, BrokenAnchor } from "../src/atlas.ts"

export type Anchors = {
  // Resolve a curated pointer; `where` names who asked, for the broken list.
  resolve: (ref: AnchorRef, where: string) => Anchor
  // The line of the first match of `text` in `file`, or null.
  find: (file: string, text: string) => number | null
  read: (file: string) => string | null
  // The line of the first match of `marker` in `file`; when it is gone, record `where` as
  // broken (the extractor cannot find what it depends on) and return null.
  expect: (file: string, marker: string | RegExp, where: string) => number | null
  // Record that an extractor found less than it must (`reason`), or a structure is missing.
  report: (where: string, file: string, reason: string) => void
  broken: () => BrokenAnchor[]
}

export const createAnchors = (repo: string): Anchors => {
  const files = new Map<string, string | null>()
  const broken: BrokenAnchor[] = []

  // Sources are read with LF endings, so a checkout with CRLF traces the same as one without.
  const read = (file: string): string | null => {
    if (!files.has(file)) {
      try {
        files.set(file, readFileSync(join(repo, file), "utf8").replaceAll("\r\n", "\n"))
      } catch {
        files.set(file, null)
      }
    }
    return files.get(file) ?? null
  }

  const find = (file: string, text: string): number | null => {
    const source = read(file)
    if (source === null) return null
    const index = source.indexOf(text)
    if (index === -1) return null
    return source.slice(0, index).split("\n").length
  }

  const resolve = (ref: AnchorRef, where: string): Anchor => {
    const line =
      ref.text === undefined ? (read(ref.file) === null ? null : 1) : find(ref.file, ref.text)
    if (line === null) broken.push({ where, file: ref.file, text: ref.text ?? "" })
    return { file: ref.file, line }
  }

  const report = (where: string, file: string, reason: string): void => {
    if (!broken.some((each) => each.where === where && each.file === file && each.text === reason))
      broken.push({ where, file, text: reason, reason })
  }

  const expect = (file: string, marker: string | RegExp, where: string): number | null => {
    const source = read(file)
    const index =
      source === null
        ? -1
        : typeof marker === "string"
          ? source.indexOf(marker)
          : source.search(marker)
    if (source === null || index === -1) {
      report(where, file, `expected ${typeof marker === "string" ? `"${marker}"` : String(marker)}`)
      return null
    }
    return source.slice(0, index).split("\n").length
  }

  return { resolve, find, read, expect, report, broken: () => broken }
}
