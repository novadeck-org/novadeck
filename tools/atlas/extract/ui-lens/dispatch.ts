import type { Anchor } from "../../src/atlas.ts"
import type { Dispatcher } from "../../src/ui-lens.ts"
import { adapterDir, at, enclosing, isComment, portFile, stateFile, type UiScan } from "./scan.ts"

// Who builds each action: the UI's commands, and the runner adapter dispatching back.

const reaches = (scan: UiScan, file: string, target: string, hops: number): boolean => {
  const next = new Set(scan.importsOf(file).values())
  return (
    next.has(target) ||
    (hops > 1 && [...next].some((each) => reaches(scan, each, target, hops - 1)))
  )
}

// Files that import the module `defining`, or a module that does (the app hands its
// commands around through a context), and use `name`: the name alone is too common a word
// (`add`) to count every file that mentions it.
const callersOf = (
  scan: UiScan,
  name: string,
  defining: string,
): { files: number; areas: string[] } => {
  const pattern = new RegExp(`(?:\\.${name}\\b|(?<![.\\w])${name}\\()`)
  const hits = scan.allSources.filter(
    (src) =>
      src.file !== defining &&
      !src.file.startsWith(adapterDir) &&
      reaches(scan, src.file, defining, 2) &&
      src.lines.some((line) => !isComment(line) && pattern.test(line)),
  )
  return {
    files: hits.length,
    areas: [...new Set(hits.map((hit) => scan.area(hit.file)))].toSorted(),
  }
}

export type Dispatchers = {
  fromUi: Map<string, Dispatcher[]>
  fromAdapter: Map<string, { anchor: Anchor; fn: string | null }[]>
}

export const readDispatchers = (scan: UiScan, known: Set<string>): Dispatchers => {
  const fromUi = new Map<string, Dispatcher[]>()
  const fromAdapter = new Map<string, { anchor: Anchor; fn: string | null }[]>()
  for (const src of scan.allSources) {
    if (src.file === stateFile) continue
    src.lines.forEach((line, i) => {
      if (isComment(line)) return
      for (const match of line.matchAll(/\btype:\s*"([a-z]+\/[a-z-]+)"/g)) {
        const type = match[1]!
        if (!known.has(type)) continue
        const fn = enclosing(src, i + 1)[0] ?? null
        if (src.file.startsWith(adapterDir)) {
          fromAdapter.set(type, [
            ...(fromAdapter.get(type) ?? []),
            { anchor: at(src.file, i + 1), fn: fn?.name ?? null },
          ])
        } else if (src.file !== portFile) {
          // A command is an object member or a binding; the name the callers use is its own.
          const named = enclosing(src, i + 1).find((each) => !/^(commit|dispatch)$/.test(each.name))
          fromUi.set(type, [
            ...(fromUi.get(type) ?? []),
            {
              area: scan.area(src.file),
              anchor: at(src.file, i + 1),
              fn: named?.name ?? null,
              callers: named ? callersOf(scan, named.name, src.file) : null,
            },
          ])
        }
      }
    })
  }
  return { fromUi, fromAdapter }
}
