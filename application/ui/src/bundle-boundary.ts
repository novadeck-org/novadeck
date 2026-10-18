// Which adapters a build may carry, by Vite mode, the name of its entry. Each entry imports its
// own (src/entries/), so the build checks the result: a build for a runner (the desktop and web
// apps) holds no demo, the visitor build, a public page, holds neither the runner client nor
// the debug panel, and the content preview holds no runner client.
const forbiddenFolders = (mode: string): readonly string[] =>
  mode === "try"
    ? ["src/backend/runner/", "src/backend/demo/debug/"]
    : mode === "content-preview"
      ? ["src/backend/runner/"]
      : ["src/backend/demo/"]

// The module ids of a bundle that a build in this mode must not carry.
export const boundaryViolations = (mode: string, moduleIds: readonly string[]): string[] => {
  const folders = forbiddenFolders(mode)
  return moduleIds.filter((id) => {
    const path = id.split("\\").join("/")
    return folders.some((folder) => path.includes(`/${folder}`))
  })
}

// What the first chunk must not carry: the terminal emulator and its library. The app opens
// them with the connection, after the page has painted its first frame, so a build that
// pulls them into the entry's static imports would make every start wait on them.
const deferredLibraries = ["/@xterm/", "/@novadeck/emulator/", "/libraries/emulator/"]

// The part of a built bundle this checks: a chunk's file, whether it is an entry, the chunks
// it imports before it runs (not the ones it loads later) and the modules it holds.
export type BuiltChunk = {
  readonly type: string
  readonly isEntry?: boolean
  readonly imports?: readonly string[]
  readonly modules?: Readonly<Record<string, unknown>>
}

// The chunks `from` and every chunk they import before they run.
const reached = (
  bundle: Readonly<Record<string, BuiltChunk>>,
  from: readonly string[],
): Set<string> => {
  const found = new Set<string>()
  const visit = (fileName: string): void => {
    if (found.has(fileName) || bundle[fileName]?.type !== "chunk") return
    found.add(fileName)
    bundle[fileName].imports?.forEach(visit)
  }
  from.forEach(visit)
  return found
}

const entries = (bundle: Readonly<Record<string, BuiltChunk>>): string[] =>
  Object.entries(bundle)
    .filter(([, chunk]) => chunk.type === "chunk" && chunk.isEntry)
    .map(([fileName]) => fileName)

// The module ids of the entry chunks and everything they import statically that belong to a
// deferred library.
export const firstChunkViolations = (bundle: Readonly<Record<string, BuiltChunk>>): string[] => {
  const first = reached(bundle, entries(bundle))
  return [...first].flatMap((fileName) =>
    Object.keys(bundle[fileName]?.modules ?? {}).filter((id) => {
      const path = id.split("\\").join("/")
      return deferredLibraries.some((library) => path.includes(library))
    }),
  )
}

// The rule every build that draws terminals must carry: where xterm draws in a screen's host
// (backend/terminal-views/terminal-xterm.css). A build that lost its terminal styles still draws, but
// with xterm's black viewport and its wide scrollbar, which nothing else catches.
const screenRule = ".terminal-xterm"

// The part of a built bundle's assets this checks: a stylesheet's file and its text.
export type BuiltAsset = {
  readonly type: string
  readonly fileName: string
  readonly source?: unknown
}

// Whether a build lacks the terminal screens' styles, which every build draws its terminals
// with: the desktop and web apps the runner's, the visitor build and the preview the demo's.
export const missingScreenStyles = (bundle: Readonly<Record<string, BuiltAsset>>): boolean =>
  !Object.values(bundle).some(
    (asset) =>
      asset.type === "asset" &&
      asset.fileName.endsWith(".css") &&
      (typeof asset.source === "string"
        ? asset.source
        : ArrayBuffer.isView(asset.source)
          ? new TextDecoder().decode(asset.source)
          : ""
      ).includes(screenRule),
  )

// What the visitor build may weigh: what the page loads first (its scripts and styles
// gzipped, and every font those styles declare, in bytes as they are, though a browser
// fetches only the faces the page draws with), and the demo, which loads with its
// connection, the terminal emulator among it (scripts and styles gzipped). Set from the first
// build with the demo drawn as terminals, 1,058 kB (663 kB of it the eleven fonts declared;
// main's first load weighed the same) and 172 kB, with room to grow; the website's hero
// waits on both.
export const visitorBudgets = { first: 1_100_000, demo: 190_000 }

// A built chunk's code, the module it stands for and the styles it brings, or an asset's
// text, as the budgets read them.
export type WeighedChunk = BuiltChunk & {
  readonly code?: string
  readonly source?: unknown
  readonly facadeModuleId?: string | null
  readonly viteMetadata?: { readonly importedCss?: ReadonlySet<string> }
}

// What a part's weight says of its budget.
const over = (part: keyof typeof visitorBudgets, size: number): string[] =>
  size > visitorBudgets[part]
    ? [`its ${part} load weighs ${size} bytes, over ${visitorBudgets[part]}`]
    : []

// A built file's text, whatever form the bundle holds it in.
const textOf = (source: unknown): string =>
  typeof source === "string"
    ? source
    : ArrayBuffer.isView(source)
      ? new TextDecoder().decode(source)
      : ""

// A built file's size in bytes, as it is served.
const bytesOf = (source: unknown): number =>
  typeof source === "string"
    ? new TextEncoder().encode(source).byteLength
    : ArrayBuffer.isView(source)
      ? source.byteLength
      : 0

// How the visitor build goes over its budgets, gzipped by `gzipped`; nothing for any other.
export const budgetViolations = (
  mode: string,
  bundle: Readonly<Record<string, WeighedChunk>>,
  gzipped: (text: string) => number,
): string[] => {
  if (mode !== "try") return []
  const first = reached(bundle, entries(bundle))
  const connect = Object.entries(bundle)
    .filter(([, chunk]) =>
      chunk.facadeModuleId?.split("\\").join("/").endsWith("/backend/demo/visitor/connect.ts"),
    )
    .map(([fileName]) => fileName)
  if (connect.length === 0) return ["it has no demo chunk to weigh"]
  const demo = [...reached(bundle, connect)].filter((fileName) => !first.has(fileName))
  const styles = (files: Iterable<string>): Set<string> =>
    new Set(
      [...files].flatMap((fileName) => [...(bundle[fileName]?.viteMetadata?.importedCss ?? [])]),
    )
  // Every font a stylesheet declares, by its file in the bundle, weighed as it is.
  const fonts = (sheets: Iterable<string>): number => {
    const named = new Set(
      [...sheets].flatMap((sheet) =>
        [...textOf(bundle[sheet]?.source).matchAll(/url\(["']?([^)"']+\.woff2)["']?\)/g)].map(
          ([, url]) => url!.split("/").at(-1)!,
        ),
      ),
    )
    return Object.entries(bundle)
      .filter(([fileName]) => named.has(fileName.split("/").at(-1)!))
      .reduce((sum, [, asset]) => sum + bytesOf(asset.source), 0)
  }
  const weight = (files: Iterable<string>, withFonts: boolean): number => {
    const sheets = styles(files)
    const scripts = [...files].reduce(
      (sum, fileName) => sum + gzipped(bundle[fileName]?.code ?? ""),
      0,
    )
    const css = [...sheets].reduce((sum, sheet) => sum + gzipped(textOf(bundle[sheet]?.source)), 0)
    return scripts + css + (withFonts ? fonts(sheets) : 0)
  }
  return [...over("first", weight(first, true)), ...over("demo", weight(demo, false))]
}
