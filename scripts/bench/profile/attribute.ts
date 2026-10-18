import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"

import {
  GREATEST_LOWER_BOUND,
  LEAST_UPPER_BOUND,
  originalPositionFor,
  TraceMap,
} from "@jridgewell/trace-mapping"

import type { Attribution, Frame, Group, ScriptKind } from "./trace.ts"

// What a frame of the UI's script is, read through the source maps of the very build the app
// runs (main.ts checks the files match): a position in a bundle maps to its original source,
// to React's build, which keeps its function names, or to xterm's bundle, whose own map leads
// on to xterm's sources.

// React's work loop: rendering, components included, and committing, effects included.
const reactRender = new Set([
  "renderRootSync",
  "renderRootConcurrent",
  "workLoopSync",
  "workLoopConcurrent",
  "workLoopConcurrentByScheduler",
  "performUnitOfWork",
  "beginWork",
  "completeWork",
  "completeUnitOfWork",
])
const reactCommit = new Set([
  "commitRoot",
  "commitRootImpl",
  "flushMutationEffects",
  "flushLayoutEffects",
  "flushPassiveEffects",
  "flushPendingEffects",
  "flushSpawnedWork",
])

// React's side of a store's change: useSyncExternalStore's listener checks whether the
// snapshot it reads, through its selector, changed, before it schedules a render.
const reactStore = new Set(["checkIfSnapshotChanged", "subscribeToStore", "forceStoreRerender"])

// The UI's stores: their dispatch with the reducers it runs, their updates, and the
// listeners they wake.
const store = /\/application\/ui\/src\/core\/store\.ts$/

// The transport: oRPC, the wire library, the protocol's client side of it, and the UI's
// handling of a terminal's events as they arrive.
const transport =
  /\/@orpc\/|\/libraries\/wire\/(?:src|dist)\/|\/application\/protocol\/(?:src|dist)\/(?:client|runner|desktop|bridge|schemas|errors|contract)\.[jt]s$|\/libraries\/terminal\/(?:src|dist)\/view\/follow\.[jt]s$/

/**
 * Where a frame's function is: `file`, the source the UI's build bundled (a package's own
 * bundle, as xterm's, or a source as it is), and `source`, the original source that file's
 * own map leads on to, or the file itself; with the function's name there, if known.
 */
export type Original = {
  readonly file: string
  readonly source: string
  readonly name: string | undefined
}

/** The package `file` comes from, by the folder under its last node_modules. */
const packageOf = (file: string): string | undefined =>
  file.match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)\/(?:(?!\/node_modules\/).)*$/)?.[1]

// xterm's parser, with what applies what it parses to the buffer and its write buffer, and
// its renderer: the DOM one, the service and debouncers that schedule it, the viewport it
// keeps in step, the decorations' renderers, and the WebGL addon.
const xtermParser = /\/src\/common\/(?:parser\/|InputHandler\.ts$|input\/WriteBuffer\.ts$)/
const xtermRenderer =
  /\/src\/browser\/(?:renderer\/|services\/RenderService\.ts$|RenderDebouncer\.ts$|TimeBasedDebouncer\.ts$|Viewport\.ts$|decorations\/\w*Renderer\.ts$)/

/** Which of xterm's parts a function is in, if it is in xterm's parser or renderer. */
const xtermPart = ({ file, source }: Original): "parser" | "renderer" | undefined => {
  const found = packageOf(file)
  if (found === "@xterm/addon-webgl") return "renderer"
  if (found !== "@xterm/xterm") return undefined
  if (xtermParser.test(source)) return "parser"
  if (xtermRenderer.test(source)) return "renderer"
  return undefined
}

/** What a function in the original sources is, by where it is and its name. */
export const kindOf = (original: Original): ScriptKind | undefined => {
  const part = xtermPart(original)
  if (part === "parser") return "xtermParsing"
  if (part === "renderer") return "xtermRendering"
  const { source, name } = original
  if (/\/react-dom\/cjs\/react-dom[\w.-]*\.js$/.test(source) && name !== undefined) {
    if (reactRender.has(name)) return "reactRender"
    if (reactCommit.has(name)) return "reactCommit"
    if (reactStore.has(name)) return "store"
  }
  if (store.test(source)) return "store"
  if (transport.test(source)) return "transport"
  return undefined
}

/** Which part of the UI's script a function is in: its package, or the app's own. */
export const groupOf = (original: Original | undefined): Group => {
  if (original === undefined) return "unmapped"
  const found = packageOf(original.file)
  if (found === undefined)
    return /\/application\/protocol\/|\/libraries\/wire\//.test(original.file) ? "protocol" : "app"
  if (["react", "react-dom", "scheduler"].includes(found)) return "react"
  if (found.startsWith("@xterm/")) {
    const part = xtermPart(original)
    return part === "parser" ? "xtermParser" : part === "renderer" ? "xtermRenderer" : "xterm"
  }
  if (found.startsWith("@orpc/")) return "protocol"
  return "packages"
}

/** The name a function declared on `line` of `text` (1-based) has, if one is. */
export const declared = (text: string | undefined, line: number): string | undefined =>
  text?.split("\n")[line - 1]?.match(/\bfunction\s+([\w$]+)\s*\(/)?.[1]

// A path with forward slashes, as Windows' are resolved with backslashes, and the
// classifiers read sources by their folders.
const slashed = (path: string): string => path.replaceAll("\\", "/")

type Loaded = { readonly trace: TraceMap; readonly file: string }

/** Attributes frames by the maps in `maps` (one `<chunk>.js.map` per chunk the page loads). */
export const sourceMapped = (maps: string): Attribution => {
  const loaded = new Map<string, Loaded | undefined>()
  const load = (file: string): Loaded | undefined => {
    if (!loaded.has(file))
      loaded.set(
        file,
        existsSync(file) ? { trace: new TraceMap(readFileSync(file, "utf8")), file } : undefined,
      )
    return loaded.get(file)
  }
  const at = (map: Loaded, line: number, column: number) => {
    const found = originalPositionFor(map.trace, { line, column, bias: GREATEST_LOWER_BOUND })
    return found.source === null
      ? originalPositionFor(map.trace, { line, column, bias: LEAST_UPPER_BOUND })
      : found
  }
  // The text of `source`, as the position names it, which the map carries.
  const content = (map: Loaded, source: string): string | undefined => {
    const index = map.trace.resolvedSources.indexOf(source)
    return index === -1 ? undefined : (map.trace.sourcesContent?.[index] ?? undefined)
  }
  const originals = new Map<string, Original | undefined>()
  // Where the frame's function is in the original sources, and its name there.
  const original = (frame: Frame): Original | undefined => {
    if (!frame.url || frame.lineNumber === undefined || frame.columnNumber === undefined)
      return undefined
    const key = `${frame.url}:${frame.lineNumber}:${frame.columnNumber}`
    if (originals.has(key)) return originals.get(key)
    let found: Original | undefined
    // Only the bundle's name is wanted: read from the URL's path, it needs no drive, as
    // a file URL's path on Windows would.
    const bundle = basename(
      frame.url.startsWith("file:") ? decodeURIComponent(new URL(frame.url).pathname) : frame.url,
    )
    const map = load(join(maps, `${bundle}.map`))
    if (map) {
      // The profile's lines and columns count from 0; the map's lines from 1.
      const position = at(map, frame.lineNumber + 1, frame.columnNumber)
      if (position.source !== null && position.line !== null && position.column !== null) {
        const source = resolve(dirname(map.file), position.source)
        // A bundle that ships its own map, as xterm's does, leads on to its sources.
        const inner = load(`${source}.map`)
        if (inner) {
          const deeper = at(inner, position.line, position.column)
          found =
            deeper.source === null
              ? { file: slashed(source), source: slashed(source), name: undefined }
              : {
                  file: slashed(source),
                  source: slashed(resolve(dirname(inner.file), deeper.source)),
                  name: deeper.name ?? undefined,
                }
        } else
          found = {
            file: slashed(source),
            source: slashed(source),
            name:
              declared(content(map, position.source), position.line) ?? position.name ?? undefined,
          }
      }
    }
    originals.set(key, found)
    return found
  }
  return {
    kind: (frame) => {
      const found = original(frame)
      return found && kindOf(found)
    },
    group: (frame) => groupOf(original(frame)),
  }
}
