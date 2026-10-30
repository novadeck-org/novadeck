import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import { transform } from "esbuild"
import { afterEach, describe, expect, it } from "vitest"

import {
  addonRegistry,
  mustRunOnce,
  lostCounter,
  profileTextPatch,
  raisedCapPatch,
  softwareWebglPatch,
  storeSpansPatch,
  webglAtlasPatch,
} from "./patches.ts"
import { storeSpan } from "./trace.ts"

// A store module shaped as core/store.ts is once step 1.3a has added its hook.
const store = `let woken = (): void => {}
export const countListenersWoken = (count: () => void): (() => void) => {
  const previous = woken
  woken = count
  return () => {
    woken = previous
  }
}
export const createStore = () => {
  const listeners = new Set<() => void>()
  return {
    subscribe: (listener: () => void) => listeners.add(listener),
    notify: () =>
      listeners.forEach((listener) => {
        woken()
        listener()
      }),
  }
}
`

const storeId = "/r/frontend/core/src/store.ts"

let folder: string | undefined
afterEach(() => {
  if (folder) rmSync(folder, { recursive: true, force: true })
  folder = undefined
  performance.clearMeasures(storeSpan)
})

describe("storeSpansPatch", () => {
  it("measures one span a task's run of the listeners, through the hook", async () => {
    const patched = storeSpansPatch.transform(store, storeId)
    expect(patched).not.toBeNull()
    // No line moves: the installer goes after the last.
    expect(patched!.code.split("\n").slice(0, store.split("\n").length - 1)).toEqual(
      store.split("\n").slice(0, -1),
    )
    folder = mkdtempSync(join(tmpdir(), "profile-patches-"))
    const file = join(folder, "store.mjs")
    writeFileSync(file, (await transform(patched!.code, { loader: "ts", format: "esm" })).code)
    const { createStore } = (await import(pathToFileURL(file).href)) as {
      createStore: () => { subscribe: (listener: () => void) => void; notify: () => void }
    }
    const one = createStore()
    let heard = 0
    one.subscribe(() => (heard += 1))
    one.subscribe(() => (heard += 1))
    one.notify()
    one.notify()
    await Promise.resolve()
    expect(heard).toBe(4)
    expect(performance.getEntriesByName(storeSpan)).toHaveLength(1)
    one.notify()
    await Promise.resolve()
    expect(performance.getEntriesByName(storeSpan)).toHaveLength(2)
  })

  it("leaves a store without the hook as it is, and fails on a hook of another shape", () => {
    expect(storeSpansPatch.transform("export const createStore = () => {}\n", storeId)).toBeNull()
    expect(storeSpansPatch.transform(store, "/r/frontend/core/src/state.ts")).toBeNull()
    expect(() =>
      storeSpansPatch.transform(
        "export const countListenersWoken = (run: () => void): number => 0\n",
        storeId,
      ),
    ).toThrow(/isn't the hook/)
  })
})

describe("profileTextPatch", () => {
  const source = "/r/libraries/emulator/src/view.ts"
  const built = "/r/libraries/emulator/dist/view.js"
  const view =
    'import { Terminal } from "@xterm/xterm"\nconst a = 1\n  terminal.open(element)\nconst b = 2\n'

  it("leaves a text reader on the host where a view opens its terminal, moving no line", () => {
    const patched = profileTextPatch.transform(view, source)!.code
    expect(patched.split("\n")).toHaveLength(view.split("\n").length)
    expect(patched.split("\n")[0]).toBe('import { Terminal } from "@xterm/xterm"')
    expect(patched.split("\n")[2]).toMatch(
      /^ {2}terminal\.open\(element\); element\.profileText = \(\) => /,
    )
    expect(patched.split("\n")[3]).toBe("const b = 2")
    // It adds no renderer: whichever draws the screen, the pool's, is the product's.
    expect(patched).not.toContain("WebglAddon")
  })

  it("patches the built view too, whose open ends in a semicolon", () => {
    const patched = profileTextPatch.transform(view.replace("(element)", "(element);"), built)!.code
    expect(patched.split("\n")[2]).toMatch(/^ {2}terminal\.open\(element\); element\.profileText/)
  })

  it("fails where the view no longer opens a terminal once, and leaves other files", () => {
    expect(() => profileTextPatch.transform("const a = 1\n", source)).toThrow(/profileText patch/)
    expect(profileTextPatch.transform(view, "/r/frontend/ui/src/App.tsx")).toBeNull()
  })
})

describe("webglAtlasPatch", () => {
  const id =
    "/r/node_modules/.pnpm/@xterm+addon-webgl@0.19.0/node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs"
  const bundle =
    "var xr=class{activate(t){this.on=1}dispose(){this.on=0}get onContextLoss(){return (f)=>{this.listener=f}}};export{xr as WebglAddon};\n// the end\n"

  it("registers the addons that activate, and forgets those disposed, on one line of the bundle", async () => {
    const patched = webglAtlasPatch.transform(bundle, id)!.code
    expect(patched.split("\n")).toHaveLength(bundle.split("\n").length)
    folder = mkdtempSync(join(tmpdir(), "profile-patches-"))
    const file = join(folder, "addon.mjs")
    writeFileSync(file, patched)
    const { WebglAddon } = (await import(pathToFileURL(file).href)) as {
      WebglAddon: new () => {
        activate: (terminal: unknown) => void
        dispose: () => void
        listener: () => void
      }
    }
    const live = (globalThis as unknown as Record<string, Set<unknown>>)[addonRegistry]!
    const one = new WebglAddon()
    expect(live.size).toBe(0)
    one.activate({})
    expect(live.has(one)).toBe(true)
    one.listener()
    expect((globalThis as unknown as Record<string, number>)[lostCounter]).toBe(1)
    one.dispose()
    expect(live.size).toBe(0)
  })

  it("fails on a bundle that exports the addon otherwise, and leaves other files", () => {
    expect(() => webglAtlasPatch.transform("export{a as Other};", id)).toThrow(/exports WebglAddon/)
    expect(webglAtlasPatch.transform(bundle, "/r/frontend/ui/src/App.tsx")).toBeNull()
  })
})

describe("raisedCapPatch", () => {
  const id = "/r/frontend/terminal-views/src/renderer-pool.ts"
  const source =
    'import { webglRendererPool } from "@novadeck/emulator/browser"\nlet page\nexport const pageRendererPool = () =>\n  (page ??= webglRendererPool({\n    ...(configuredContexts !== undefined && { contexts: configuredContexts }),\n  }))\n'

  it("gives the page's pool the raised limit, moving no line", () => {
    const patched = raisedCapPatch(40).transform(source, id)!.code
    expect(patched.split("\n")).toHaveLength(source.split("\n").length)
    expect(patched).toContain("(page ??= webglRendererPool({ contexts: 40,\n")
  })

  it("fails where the pool isn't made once by webglRendererPool({, and leaves other files", () => {
    expect(() => raisedCapPatch(40).transform("export const a = 1\n", id)).toThrow(
      /webglRendererPool/,
    )
    expect(() => raisedCapPatch(40).transform(`${source}x = webglRendererPool({\n`, id)).toThrow(
      /webglRendererPool/,
    )
    expect(raisedCapPatch(40).transform(source, "/r/frontend/ui/src/App.tsx")).toBeNull()
  })
})

describe("softwareWebglPatch", () => {
  const id = "/r/libraries/emulator/src/renderer.ts"

  it("lets the pool's probe pass, in the source and in the build", () => {
    const source = "export const probeWebgl = (): boolean => {\n  return false\n}\n"
    expect(softwareWebglPatch.transform(source, id)!.code.split("\n")[0]).toBe(
      "export const probeWebgl = (): boolean => { return true;",
    )
    const built = "export const probeWebgl = () => {\n  return false\n};\n"
    expect(
      softwareWebglPatch.transform(built, "/r/libraries/emulator/dist/renderer.js")!.code,
    ).toContain("probeWebgl = () => { return true;")
  })

  it("fails on a probe of another shape, and leaves other files", () => {
    expect(() => softwareWebglPatch.transform("export const a = 1\n", id)).toThrow(/probeWebgl/)
    expect(softwareWebglPatch.transform("", "/r/frontend/ui/src/App.tsx")).toBeNull()
  })
})

describe("the patches on the real sources", () => {
  // So drift in a file a patch targets fails here, not as a flag that silently does nothing.
  const root = join(import.meta.dirname, "..", "..", "..")
  // Vite hands plugins ids with forward slashes, on Windows too.
  const idOf = (path: string) => join(root, path).replaceAll("\\", "/")
  const read = (path: string) => readFileSync(join(root, path), "utf8")
  const addon = join(
    dirname(
      createRequire(join(root, "libraries/emulator/package.json")).resolve("@xterm/addon-webgl"),
    ),
    "addon-webgl.mjs",
  )

  it("patches the view, the pool's probe, the pool's creation and the addon, each once", () => {
    const view = "libraries/emulator/src/view.ts"
    expect(profileTextPatch.transform(read(view), idOf(view))).not.toBeNull()
    const renderer = "libraries/emulator/src/renderer.ts"
    expect(softwareWebglPatch.transform(read(renderer), idOf(renderer))).not.toBeNull()
    const pool = "frontend/terminal-views/src/renderer-pool.ts"
    expect(raisedCapPatch(40).transform(read(pool), idOf(pool))).not.toBeNull()
    expect(
      webglAtlasPatch.transform(readFileSync(addon, "utf8"), addon.replaceAll("\\", "/")),
    ).not.toBeNull()
  })

  it("patches the built view and probe too, where the library is built", () => {
    const built = (
      [
        ["libraries/emulator/dist/view.js", profileTextPatch],
        ["libraries/emulator/dist/renderer.js", softwareWebglPatch],
      ] as const
    ).filter(([file]) => existsSync(idOf(file)))
    const results = built.map(([file, patch]) => patch.transform(read(file), idOf(file)))
    expect(results.every((each) => each !== null)).toBe(true)
  })

  it("fails a build whose patch ran on no file, or two", () => {
    const run = mustRunOnce(profileTextPatch)
    expect(() => run.buildEnd()).toThrow(/patched 0 files/)
    expect(() => run.buildEnd(new Error("other"))).not.toThrow()
    const view = "/r/libraries/emulator/src/view.ts"
    const source = "  terminal.open(element)\n"
    run.transform(source, view)
    expect(() => run.buildEnd()).not.toThrow()
    run.transform(source, view)
    expect(() => run.buildEnd()).toThrow(/patched 2 files/)
  })
})
