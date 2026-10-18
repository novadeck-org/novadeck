import {
  boundaryViolations,
  firstChunkViolations,
  missingScreenStyles,
  type BuiltChunk,
} from "./bundle-boundary"
import { context, describe, expect, it } from "./test"

const demo = "/work/ui/src/backend/demo/index.ts"
const debug = "/work/ui/src/backend/demo/debug/connect.ts"
const runner = "/work/ui/src/backend/runner/index.ts"
const app = "/work/ui/src/app/App.tsx"

describe("bundle boundary", () => {
  context("for a build that connects to a runner", () => {
    it("rejects any demo module", () => {
      expect(boundaryViolations("production", [app, runner, demo, debug])).toEqual([demo, debug])
    })

    it("reads Windows-style module ids", () => {
      const id = "C:\\work\\ui\\src\\backend\\demo\\index.ts"
      expect(boundaryViolations("production", [id])).toEqual([id])
    })
  })

  context("for the visitor build", () => {
    it("rejects the runner client and the debug layer but not the demo", () => {
      expect(boundaryViolations("try", [app, demo, runner, debug])).toEqual([runner, debug])
    })
  })

  context("for the content preview", () => {
    it("allows the demo and its debug layer, but not the runner client", () => {
      expect(boundaryViolations("content-preview", [demo, debug, runner])).toEqual([runner])
    })
  })
})

describe("the first chunk", () => {
  const xterm =
    "/work/node_modules/.pnpm/@xterm+xterm@6.0.0/node_modules/@xterm/xterm/lib/xterm.mjs"
  const emulator = "/work/libraries/emulator/src/view.ts"
  const chunk = (
    modules: readonly string[],
    imports: readonly string[] = [],
    isEntry = false,
  ): BuiltChunk => ({
    type: "chunk",
    isEntry,
    imports,
    modules: Object.fromEntries(modules.map((id) => [id, {}])),
  })

  it("passes when the emulator loads later, from a chunk the entry only imports dynamically", () => {
    expect(
      firstChunkViolations({
        "index.js": chunk([app], ["vendor.js"], true),
        "vendor.js": chunk(["/work/node_modules/react/index.js"]),
        "emulator.js": chunk([xterm, emulator]),
      }),
    ).toEqual([])
  })

  it("rejects the emulator in the entry chunk or in a chunk it imports", () => {
    expect(firstChunkViolations({ "index.js": chunk([app, emulator], [], true) })).toEqual([
      emulator,
    ])
    expect(
      firstChunkViolations({
        "index.js": chunk([app], ["shared.js"], true),
        "shared.js": chunk(["/work/other.ts"], ["deeper.js"]),
        "deeper.js": chunk([xterm]),
      }),
    ).toEqual([xterm])
  })

  it("reads Windows-style module ids", () => {
    const id = "C:\\work\\node_modules\\@xterm\\xterm\\lib\\xterm.mjs"
    expect(firstChunkViolations({ "index.js": chunk([id], [], true) })).toEqual([id])
  })

  it("ignores assets and imports it has no chunk for", () => {
    expect(
      firstChunkViolations({
        "index.js": chunk([app], ["missing.js", "style.css"], true),
        "style.css": { type: "asset" },
      }),
    ).toEqual([])
  })
})

describe("the terminal screens' styles", () => {
  const sheet = (source: string) => ({ type: "asset", fileName: "assets/connect.css", source })

  it("are in every build that draws terminals", () => {
    const styled = { "assets/connect.css": sheet(".terminal-xterm .xterm .xterm-viewport{}") }
    expect(missingScreenStyles("production", styled)).toBe(false)
    expect(missingScreenStyles("web", styled)).toBe(false)
  })

  it("fail a build that draws terminals without them", () => {
    const bare = {
      "assets/index.css": sheet(".shell{}"),
      "assets/index.js": { type: "chunk", fileName: "assets/index.js" },
    }
    expect(missingScreenStyles("production", bare)).toBe(true)
    expect(missingScreenStyles("web", bare)).toBe(true)
  })

  it("are not asked of a build that draws no terminals yet", () => {
    expect(missingScreenStyles("try", {})).toBe(false)
    expect(missingScreenStyles("content-preview", {})).toBe(false)
  })
})
