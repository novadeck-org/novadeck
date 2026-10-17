import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import { generatedPositionFor, LEAST_UPPER_BOUND, TraceMap } from "@jridgewell/trace-mapping"
import { build } from "esbuild"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { declared, groupOf, kindOf, sourceMapped } from "./attribute.ts"

// Where a function is, in a source the UI's build bundled as it is.
const at = (file: string, name?: string) => ({ file, source: file, name })

// xterm's bundle, and the source in it its own map leads to.
const xterm = "/r/node_modules/.pnpm/@xterm+xterm@6.0.0/node_modules/@xterm/xterm/lib/xterm.mjs"
const inXterm = (source: string) => ({
  file: xterm,
  source: `/r/node_modules/.pnpm/@xterm+xterm@6.0.0/node_modules/@xterm/xterm/src/${source}`,
  name: undefined,
})
// The WebGL addon's bundle, whose map leads to sources outside any package.
const webgl =
  "/r/node_modules/.pnpm/@xterm+addon-webgl@0.19.0/node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs"

describe("kindOf", () => {
  it("names xterm's parsing and rendering by its sources, and React's work by its functions", () => {
    expect(kindOf(inXterm("common/parser/EscapeSequenceParser.ts"))).toBe("xtermParsing")
    expect(kindOf(inXterm("common/InputHandler.ts"))).toBe("xtermParsing")
    expect(kindOf(inXterm("browser/renderer/dom/DomRenderer.ts"))).toBe("xtermRendering")
    expect(kindOf(inXterm("browser/services/RenderService.ts"))).toBe("xtermRendering")
    expect(kindOf(inXterm("browser/Viewport.ts"))).toBe("xtermRendering")
    expect(kindOf(inXterm("browser/decorations/OverviewRulerRenderer.ts"))).toBe("xtermRendering")
    expect(kindOf(inXterm("browser/Terminal.ts"))).toBeUndefined()
    expect(
      kindOf({
        file: webgl,
        source: "/r/node_modules/.pnpm/x/node_modules/src/common/Color.ts",
        name: "a",
      }),
    ).toBe("xtermRendering")
    const react = "/x/react-dom/cjs/react-dom-client.production.js"
    expect(kindOf(at(react, "renderRootSync"))).toBe("reactRender")
    expect(kindOf(at(react, "commitRoot"))).toBe("reactCommit")
    expect(kindOf(at(react, "performWorkOnRoot"))).toBeUndefined()
    // A store's listener checks its snapshot, through its selector, before any render.
    expect(kindOf(at(react, "checkIfSnapshotChanged"))).toBe("store")
    expect(kindOf(at("/r/application/ui/src/model/store.ts", "notify"))).toBe("store")
    expect(kindOf(at("/r/application/ui/src/model/state.ts", "workspaceReducer"))).toBeUndefined()
    expect(kindOf(at("/x/app/renderRootSync.js", "renderRootSync"))).toBeUndefined()
  })

  it("names the transport: oRPC, the wire library, the protocol's client side, and the UI's following of a terminal", () => {
    expect(kindOf(at("/x/node_modules/@orpc/client/dist/index.mjs"))).toBe("transport")
    expect(kindOf(at("/r/libraries/wire/dist/client.js"))).toBe("transport")
    expect(kindOf(at("/r/libraries/wire/src/channel.ts"))).toBe("transport")
    expect(kindOf(at("/r/application/protocol/src/client.ts"))).toBe("transport")
    expect(kindOf(at("/r/application/protocol/dist/text.js"))).toBeUndefined()
    expect(kindOf(at("/r/application/ui/src/backend/runner/follow.ts"))).toBe("transport")
  })
})

describe("groupOf", () => {
  it("names the package a function is in, by the folder under its bundle's last node_modules", () => {
    const store = "/r/node_modules/.pnpm/react-dom@19.3.0_react@19.3.0/node_modules"
    expect(groupOf(at(`${store}/react-dom/cjs/react-dom-client.production.js`))).toBe("react")
    expect(
      groupOf(at("/r/node_modules/.pnpm/scheduler@0.28.0/node_modules/scheduler/index.js")),
    ).toBe("react")
    expect(groupOf(inXterm("common/InputHandler.ts"))).toBe("xtermParser")
    expect(groupOf(inXterm("browser/renderer/dom/DomRenderer.ts"))).toBe("xtermRenderer")
    expect(groupOf(inXterm("common/buffer/Buffer.ts"))).toBe("xterm")
    expect(
      groupOf({ file: webgl, source: "/r/elsewhere/src/common/Color.ts", name: undefined }),
    ).toBe("xtermRenderer")
    expect(
      groupOf(
        at("/r/node_modules/.pnpm/@orpc+client@1.15.5/node_modules/@orpc/client/dist/index.mjs"),
      ),
    ).toBe("protocol")
    expect(groupOf(at("/r/node_modules/.pnpm/zod@4.6.5/node_modules/zod/v4/core/util.js"))).toBe(
      "packages",
    )
    expect(groupOf(at("/r/application/protocol/dist/runner.js"))).toBe("protocol")
    expect(groupOf(at("/r/libraries/wire/src/client.ts"))).toBe("protocol")
    expect(groupOf(at("/r/application/ui/src/App.tsx"))).toBe("app")
    expect(groupOf(undefined)).toBe("unmapped")
  })

  it("reads a function's name from the line declaring it", () => {
    expect(declared("a\nfunction workLoopSync() {\n}", 2)).toBe("workLoopSync")
    expect(declared("const a = () => {}", 1)).toBeUndefined()
    expect(declared(undefined, 1)).toBeUndefined()
  })
})

describe("sourceMapped", () => {
  let folder: string
  let assets: string
  let bundle: TraceMap
  let xtermMap: TraceMap
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(folder, path)), { recursive: true })
    writeFileSync(join(folder, path), text)
  }

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), "profile-attribute-"))
    write(
      "node_modules/react-dom/cjs/react-dom-client.production.js",
      [
        "function renderRootSync(work) {",
        "  return work() + 1",
        "}",
        "function commitRoot(work) {",
        "  return work() + 2",
        "}",
        "export const render = (work) => renderRootSync(work)",
        "export const commit = (work) => commitRoot(work)",
        "",
      ].join("\n"),
    )
    // xterm ships a bundle with its own map, which the UI's build doesn't follow.
    write(
      "node_modules/@xterm/xterm/src/common/InputHandler.ts",
      "export function parse(data: string): number {\n  return data.length * 3\n}\n",
    )
    await build({
      entryPoints: [join(folder, "node_modules/@xterm/xterm/src/common/InputHandler.ts")],
      outfile: join(folder, "node_modules/@xterm/xterm/lib/xterm.mjs"),
      bundle: true,
      format: "esm",
      minify: true,
      sourcemap: "external",
    })
    write(
      "app.js",
      [
        'import { render, commit } from "./node_modules/react-dom/cjs/react-dom-client.production.js"',
        'import { parse } from "./node_modules/@xterm/xterm/lib/xterm.mjs"',
        "export function own(data) {",
        "  return render(() => parse(data)) + commit(() => data.length)",
        "}",
        "",
      ].join("\n"),
    )
    assets = join(folder, "out", "assets")
    await build({
      entryPoints: [join(folder, "app.js")],
      outfile: join(assets, "index.js"),
      bundle: true,
      format: "esm",
      minify: true,
      sourcemap: "external",
    })
    bundle = new TraceMap(readFileSync(join(assets, "index.js.map"), "utf8"))
    xtermMap = new TraceMap(
      readFileSync(join(folder, "node_modules/@xterm/xterm/lib/xterm.mjs.map"), "utf8"),
    )
  })

  afterAll(() => rmSync(folder, { recursive: true, force: true }))

  /** Where the code at `line` (1-based) of `source` ended up in what `map` maps. */
  const position = (map: TraceMap, source: string, line: number) =>
    generatedPositionFor(map, {
      source: map.resolvedSources.find((each) => each.endsWith(source))!,
      line,
      column: 0,
      // The first code on the line, past its indentation.
      bias: LEAST_UPPER_BOUND,
    })

  /** The frame V8 reports for code at `where` in the bundle. */
  const inBundle = (where: { line: number | null; column: number | null }) => ({
    functionName: "x",
    url: pathToFileURL(join(assets, "index.js")).href,
    lineNumber: where.line! - 1,
    columnNumber: where.column!,
  })

  it("follows the bundle's map to React's functions", () => {
    const { kind } = sourceMapped(assets)
    const react = "react-dom-client.production.js"
    // V8 places a frame at its function's start, the line declaring it.
    expect(kind(inBundle(position(bundle, react, 1)))).toBe("reactRender")
    expect(kind(inBundle(position(bundle, react, 4)))).toBe("reactCommit")
    expect(sourceMapped(assets).group(inBundle(position(bundle, react, 4)))).toBe("react")
    expect(sourceMapped(assets).group(inBundle(position(bundle, "app.js", 3)))).toBe("app")
    expect(kind(inBundle(position(bundle, "app.js", 3)))).toBeUndefined()
  })

  it("follows a bundled package's own map on to its sources", () => {
    const inner = position(xtermMap, "InputHandler.ts", 2)
    const outer = generatedPositionFor(bundle, {
      source: bundle.resolvedSources.find((each) => each.endsWith("xterm.mjs"))!,
      line: inner.line!,
      column: inner.column!,
    })
    const attribution = sourceMapped(assets)
    expect(attribution.kind(inBundle(outer))).toBe("xtermParsing")
    expect(attribution.group(inBundle(outer))).toBe("xtermParser")
  })

  it("classifies nothing it has no map or position for", () => {
    const { kind } = sourceMapped(assets)
    expect(kind({ functionName: "x" })).toBeUndefined()
    expect(
      kind({
        functionName: "x",
        url: "file:///elsewhere/other.js",
        lineNumber: 0,
        columnNumber: 0,
      }),
    ).toBeUndefined()
  })
})
