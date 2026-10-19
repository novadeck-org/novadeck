import { gzipSync } from "node:zlib"

import type { Plugin } from "vite"

// What every app's build checks of its bundle, whichever app it is: the desktop and web
// builds, the visitor build and the content preview (each app's vite.config.ts adds this
// plugin). Which adapter a build may carry is no check of it: the package graph decides what
// an app depends on.

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

// Why the first-chunk check has nothing to read: no entry chunk, or no module of any deferred
// library in any chunk (every build carries the emulator, so a bundle that holds none has
// patterns that no longer match).
export const firstChunkGaps = (bundle: Readonly<Record<string, BuiltChunk>>): string[] => {
  const held = Object.values(bundle).flatMap((chunk) =>
    chunk.type === "chunk" ? Object.keys(chunk.modules ?? {}) : [],
  )
  const library = held.some((id) => {
    const path = id.split("\\").join("/")
    return deferredLibraries.some((name) => path.includes(name))
  })
  return [
    ...(entries(bundle).length === 0 ? ["it has no entry chunk"] : []),
    ...(library ? [] : ["it holds no module of the terminal emulator or its library"]),
  ]
}

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
// (frontend/terminal-views/src/terminal-xterm.css). A build that lost its terminal styles still draws, but
// with xterm's black viewport and its wide scrollbar, which nothing else catches.
const screenRule = ".terminal-xterm"

// The part of a built bundle's assets this checks: a stylesheet's file and its text.
export type BuiltAsset = {
  readonly type: string
  readonly fileName: string
  readonly source?: unknown
}

// A utility a build's CSS must hold, with the folder Tailwind finds it in: the `@source` lines
// of the UI's styles.css are the only thing that reaches each folder, and a scan that lost one
// would drop its looks without failing anything else. Each is written in one file of its
// folder only.
export type ScannedUtility = { readonly folder: string; readonly utility: string }

// The folders whose utility no stylesheet of the build holds.
export const missingUtilities = (
  bundle: Readonly<Record<string, BuiltAsset>>,
  scannedUtilities: readonly ScannedUtility[],
): string[] => {
  const css = Object.values(bundle)
    .filter((asset) => asset.type === "asset" && asset.fileName.endsWith(".css"))
    .map((asset) => textOf(asset.source))
  return scannedUtilities
    .filter(({ utility }) => {
      // The class itself: a selector ends at a rule's brace, a pseudo-class, a combinator or
      // a comma, so `.underline-offset-2` is not `.underline`.
      const selector = `.${utility.replace(/[^\w-]/g, "\\$&")}`.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      )
      const pattern = new RegExp(`${selector}(?=[\\s{:,>+~.[)])`)
      return !css.some((text) => pattern.test(text))
    })
    .map(({ folder, utility }) => `${utility} from ${folder}`)
}

// Whether a build lacks the terminal screens' styles, which every build draws its terminals
// with: the desktop and web apps the runner's, the visitor build and the preview the demo's.
export const missingScreenStyles = (bundle: Readonly<Record<string, BuiltAsset>>): boolean =>
  !Object.values(bundle).some(
    (asset) =>
      asset.type === "asset" &&
      asset.fileName.endsWith(".css") &&
      textOf(asset.source).includes(screenRule),
  )

// What a build may weigh: what the page loads first (its scripts and styles gzipped, and
// every woff2 font those styles declare, in bytes as they are, though a browser fetches only
// the faces the page draws with), and the demo, which loads with its connection, the terminal
// emulator among it (scripts and styles gzipped), found by the module its chunk is named for.
// The visitor build's are set from the first build with the demo drawn as terminals, 1,058 kB
// (663 kB of it the eleven fonts declared; main's first load weighed the same) and 172 kB,
// with room to grow; the website's hero waits on both.
export type Budgets = { readonly first: number; readonly demo: number; readonly demoModule: string }

// A built chunk's code, the module it stands for and the styles it brings, or an asset's
// text, as the budgets read them.
export type WeighedChunk = BuiltChunk & {
  readonly code?: string
  readonly source?: unknown
  readonly facadeModuleId?: string | null
  readonly viteMetadata?: { readonly importedCss?: ReadonlySet<string> }
}

// What a part's weight says of its budget.
const over = (budgets: Budgets, part: "first" | "demo", size: number): string[] =>
  size > budgets[part] ? [`its ${part} load weighs ${size} bytes, over ${budgets[part]}`] : []

// A built file's text, whatever form the bundle holds it in.
const textOf = (source: unknown): string =>
  typeof source === "string"
    ? source
    : ArrayBuffer.isView(source)
      ? Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString("utf8")
      : ""

// A built file's size in bytes, as it is served.
const bytesOf = (source: unknown): number =>
  typeof source === "string"
    ? new TextEncoder().encode(source).byteLength
    : ArrayBuffer.isView(source)
      ? source.byteLength
      : 0

// How a build goes over its budgets, gzipped by `gzipped`.
export const budgetViolations = (
  budgets: Budgets,
  bundle: Readonly<Record<string, WeighedChunk>>,
  gzipped: (text: string) => number,
): string[] => {
  const first = reached(bundle, entries(bundle))
  const connect = Object.entries(bundle)
    .filter(([, chunk]) => chunk.facadeModuleId?.split("\\").join("/").endsWith(budgets.demoModule))
    .map(([fileName]) => fileName)
  if (connect.length === 0) return [`no demo chunk found for ${budgets.demoModule}`]
  const demo = [...reached(bundle, connect)].filter((fileName) => !first.has(fileName))
  const styles = (files: Iterable<string>): Set<string> =>
    new Set(
      [...files].flatMap((fileName) => [...(bundle[fileName]?.viteMetadata?.importedCss ?? [])]),
    )
  // Every woff2 font a stylesheet declares, by its file in the bundle, weighed as it is.
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
  return [
    ...over(budgets, "first", weight(first, true)),
    ...over(budgets, "demo", weight(demo, false)),
  ]
}

// The utilities every frontend build's CSS must hold, one from each folder the UI's stylesheet
// scans (its `@source` lines): a scan that lost a folder would drop its looks without failing
// anything else. Each is a utility that only its folder writes (tailwind-guards.test.ts checks
// that no other scanned file does), and each is written here in halves: Tailwind scans no file
// of this package, but a whole copy anywhere it does scan would make the class itself, and the
// check would pass however much the scan lost. Do not quote one whole in a comment either.
// terminal-views and the runner adapter write no utility of their own, so they have no guard.
export const frontendUtilities: readonly ScannedUtility[] = [
  { folder: "frontend/demo-debug/", utility: ["h-[min(760px,", "calc(100vh-80px))]"].join("") },
  { folder: "frontend/demo/", utility: ["under", "line"].join("") },
]

/**
 * The desktop app's pages, whose config is outside the UI's folder: the UI's own utility as
 * well, the workspace header's.
 */
export const desktopUtilities: readonly ScannedUtility[] = [
  ...frontendUtilities,
  {
    folder: "frontend/ui/",
    utility: ["grid-cols-[minmax(0,1fr)_auto", "_minmax(0,1fr)]"].join(""),
  },
]

export type BundleChecks = {
  /** A utility from each folder Tailwind scans, which the build's CSS must hold. */
  readonly utilities: readonly ScannedUtility[]
  /** What the build may weigh; none for a build that has no budget. */
  readonly budgets?: Budgets
}

/**
 * Fails a build that loads the terminal emulator with its first chunk, draws terminals without
 * their styles, whose CSS lost a folder Tailwind scans, or (with `budgets`) weighs too much;
 * and a build that holds nothing for these checks to read, since they would pass on any bundle.
 */
export const bundleChecks = (options: BundleChecks): Plugin => {
  let mode = ""
  return {
    name: "build-kit-bundle-checks",
    apply: "build",
    configResolved: (config) => void (mode = config.mode),
    generateBundle(_output, bundle) {
      const gaps = firstChunkGaps(bundle)
      if (gaps.length > 0) {
        this.error(
          `The ${mode} build holds nothing for checks to read, so they would pass on any bundle: ${gaps.join("; ")}`,
        )
      }
      const early = firstChunkViolations(bundle)
      if (early.length > 0) {
        this.error(
          `The ${mode} build loads the terminal emulator with its first chunk: ${early.join(", ")}`,
        )
      }
      if (options.budgets) {
        const heavy = budgetViolations(options.budgets, bundle, (code) => gzipSync(code).length)
        if (heavy.length > 0)
          this.error(`The ${mode} build is over its budget: ${heavy.join("; ")}`)
      }
      const unstyled = missingUtilities(bundle, options.utilities)
      if (unstyled.length > 0) {
        this.error(
          `The ${mode} build lost a folder Tailwind scans (the @source lines of the UI's styles.css): its CSS lacks ${unstyled.join(", ")}`,
        )
      }
      if (missingScreenStyles(bundle)) {
        this.error(
          `The ${mode} build draws terminals without their styles (terminal-views/src/terminal-xterm.css)`,
        )
      }
    },
  }
}
