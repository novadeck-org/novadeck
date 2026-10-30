import { dirname, posix } from "node:path"

import type { Anchor, Api } from "../../src/atlas.ts"
import type { Anchors } from "../anchors.ts"
import { sourceFiles } from "../files.ts"
import type { LensInput } from "../lens-input.ts"

// The UI's source, indexed for the scans of the UI lens: a light function index (named
// functions, arrow bindings and object members, with their line ranges found by
// indentation) of every file the lens reads.

export const ui = "frontend/ui/src"
export const core = "frontend/core/src"
export const adapterSrc = "frontend/runner-adapter/src"
const views = "frontend/terminal-views/src"
export const stateFile = `${core}/state.ts`
export const portFile = `${core}/port.ts`
export const adapterDir = `${adapterSrc}/`
export const backendFile = `${adapterDir}backend.ts`
// The backends: the adapters the UI is drawn over, apart from the app.
export const isBackend = (file: string) =>
  file.startsWith(adapterDir) || file.startsWith(`${views}/`)

// Tests are already left out by `sourceFiles`.
const isNoise = (file: string) => file.includes("/demo/") || file.endsWith(".d.ts")

export const indentOf = (line: string) => line.length - line.trimStart().length
export const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line)
export const blank = (line: string) => line.trim() === ""

export type Fn = {
  name: string
  file: string
  // 1-based, inclusive.
  start: number
  end: number
  indent: number
  member: boolean
  // `const x = createY(...)`: an object the factory built, not something to call.
  built?: boolean
}

export type Source = { file: string; lines: string[]; fns: Fn[] }

const keywords = new Set(["if", "for", "while", "switch", "catch", "function", "return", "else"])

export const definitionOf = (line: string): { name: string; member: boolean } | null => {
  let match = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+(\w+)/.exec(line)
  if (match) return { name: match[1]!, member: false }
  match =
    /^\s*(?:export\s+)?(?:const|let)\s+(\w+)\b[^=]*=\s*(?:async\s*)?(?:\(|<|\w+\s*=>|function\b|create\w+)/.exec(
      line,
    )
  if (match) return { name: match[1]!, member: false }
  match = /^\s*(?:async\s+)?(\w+)\s*:\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::\s*[^=]+)?=>/.exec(
    line,
  )
  if (match) return { name: match[1]!, member: true }
  match = /^\s*(\w+):\s*(?:async\s*)?\($/.exec(line)
  if (match) return { name: match[1]!, member: true }
  match = /^\s*(?:async\s+)?(\w+)\([^)]*\)(?:\s*:\s*[^{;]+)?\s*\{$/.exec(line)
  if (match && !keywords.has(match[1]!)) return { name: match[1]!, member: true }
  return null
}

// The last line of the block that opens at `from` (0-based): until indentation returns.
export const blockEnd = (lines: string[], from: number): number => {
  const indent = indentOf(lines[from]!)
  for (let i = from + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (blank(line)) continue
    const at = indentOf(line)
    if (at > indent) continue
    const text = line.trim()
    if (at === indent && text.startsWith(")") && (text.includes("=>") || text.endsWith("{")))
      continue
    return /^[)}\]]/.test(text) ? i : i - 1
  }
  return lines.length - 1
}

const indexSource = (file: string, text: string): Source => {
  const lines = text.split("\n")
  const fns: Fn[] = []
  lines.forEach((line, i) => {
    if (isComment(line)) return
    const found = definitionOf(line)
    if (!found) return
    fns.push({
      ...found,
      built: !found.member && /=\s*create\w+/.test(line) && !/=>/.test(line),
      file,
      start: i + 1,
      end: blockEnd(lines, i) + 1,
      indent: indentOf(line),
    })
  })
  return { file, lines, fns }
}

// The functions of a file that hold `line`, innermost first.
export const enclosing = (source: Source, line: number): Fn[] =>
  source.fns
    .filter((fn) => fn.start <= line && line <= fn.end)
    .toSorted((a, b) => b.start - a.start || a.end - b.end)

export const at = (file: string, line: number): Anchor => ({ file, line })

// What every scan of the UI lens reads from.
export type UiScan = {
  anchors: Anchors
  api: Api
  // The area of a file, `frontend/ui` where none owns it.
  area: (file: string) => string
  // The files the lens reads.
  files: string[]
  sources: Map<string, Source>
  allSources: Source[]
  source: (file: string) => Source | null
  // The files a file imports from by relative path, by imported name.
  importsOf: (file: string) => Map<string, string>
}

export const scanUi = (input: LensInput): UiScan => {
  const { repo, anchors, api } = input
  const files = [ui, core, adapterSrc, views]
    .flatMap((dir) => sourceFiles(repo, dir))
    .filter((file) => !isNoise(file))
  const sources = new Map<string, Source>()
  const source = (file: string): Source | null => {
    const cached = sources.get(file)
    if (cached) return cached
    const text = anchors.read(file)
    if (text === null) return null
    const made = indexSource(file, text)
    sources.set(file, made)
    return made
  }
  for (const file of files) source(file)

  const importsCache = new Map<string, Map<string, string>>()
  const importsOf = (file: string): Map<string, string> => {
    const cached = importsCache.get(file)
    if (cached) return cached
    const map = new Map<string, string>()
    const text = anchors.read(file) ?? ""
    for (const match of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"(\.[^"]*)"/g)) {
      const base = posix.normalize(posix.join(dirname(file), match[2]!))
      const target = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((each) =>
        sources.has(each),
      )
      if (!target) continue
      for (const name of match[1]!.split(",")) {
        const clean = name
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)
          .pop()!
          .trim()
        if (clean) map.set(clean, target)
      }
    }
    importsCache.set(file, map)
    return map
  }

  return {
    anchors,
    api,
    area: (file) => input.areaOf(file) ?? "frontend/ui",
    files,
    sources,
    allSources: [...sources.values()],
    source,
    importsOf,
  }
}
