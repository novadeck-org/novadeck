import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { transform } from "esbuild"
import { afterEach, describe, expect, it } from "vitest"

import { storeSpansPatch, webglPatch } from "./patches.ts"
import { storeSpan } from "./trace.ts"

// A store module shaped as model/store.ts is once step 1.3a has added its hook.
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

const storeId = "/r/application/ui/src/model/store.ts"

describe("storeSpansPatch", () => {
  let folder: string | undefined
  afterEach(() => {
    if (folder) rmSync(folder, { recursive: true, force: true })
    folder = undefined
    performance.clearMeasures(storeSpan)
  })

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
    expect(storeSpansPatch.transform(store, "/r/application/ui/src/model/state.ts")).toBeNull()
    expect(() =>
      storeSpansPatch.transform(
        "export const countListenersWoken = (run: () => void): number => 0\n",
        storeId,
      ),
    ).toThrow(/isn't the hook/)
  })
})

describe("webglPatch", () => {
  const id = "/r/application/ui/src/backend/runner/screens.ts"
  const screens =
    'import { Terminal } from "@novadeck/emulator/browser"\nconst a = 1\n    xterm.open(element)\nconst b = 2\n'

  it("loads the addon where a screen opens, moving no line", () => {
    const patched = webglPatch.transform(screens, id)!.code
    expect(patched.split("\n")).toHaveLength(screens.split("\n").length)
    expect(patched.split("\n")[0]).toMatch(
      /^import \{ WebglAddon \} from "@novadeck\/emulator\/browser"; /,
    )
    expect(patched.split("\n")[2]).toMatch(
      /^ {4}xterm\.open\(element\); const webgl = new WebglAddon\(\);/,
    )
    expect(patched.split("\n")[3]).toBe("const b = 2")
  })

  it("fails where screens.ts no longer opens a screen once, and leaves other files", () => {
    expect(() => webglPatch.transform("const a = 1\n", id)).toThrow(/WebGL patch/)
    expect(webglPatch.transform(screens, "/r/application/ui/src/App.tsx")).toBeNull()
  })
})
