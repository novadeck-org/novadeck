import {
  boundaryViolations,
  budgetViolations,
  firstChunkGaps,
  firstChunkViolations,
  missingFolders,
  missingScreenStyles,
  missingUtilities,
  scannedUtilities,
  visitorBudgets,
  type BuiltChunk,
  type WeighedChunk,
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

  context("when no module is under the folder a mode runs on", () => {
    it("asks each mode for its own adapter", () => {
      expect(missingFolders("production", [app, runner])).toEqual([])
      expect(missingFolders("web", [app, runner])).toEqual([])
      expect(missingFolders("try", [app, demo])).toEqual([])
      expect(missingFolders("content-preview", [app, demo, debug])).toEqual([])
    })

    it("names the folder a bundle holds nothing of, however it is spelled", () => {
      expect(missingFolders("production", [app, demo])).toEqual(["src/backend/runner/"])
      expect(missingFolders("try", [app, runner])).toEqual(["src/backend/demo/"])
      expect(missingFolders("content-preview", [app, demo])).toEqual(["src/backend/demo/debug/"])
      expect(missingFolders("production", [])).toEqual(["src/backend/runner/"])
      expect(
        missingFolders("production", ["C:\\work\\ui\\src\\backend\\runner\\index.ts"]),
      ).toEqual([])
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

  it("has nothing to read without an entry chunk or without the emulator in any chunk", () => {
    const emulatorChunk = chunk([xterm, emulator])
    expect(
      firstChunkGaps({ "index.js": chunk([app], [], true), "emulator.js": emulatorChunk }),
    ).toEqual([])
    expect(firstChunkGaps({ "emulator.js": emulatorChunk })).toEqual(["it has no entry chunk"])
    const none = "it holds no module of the terminal emulator or its library"
    expect(firstChunkGaps({ "index.js": chunk([app], [], true) })).toEqual([none])
    expect(firstChunkGaps({})).toEqual(["it has no entry chunk", none])
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

  it("pass a build whose stylesheets carry them, as text or as bytes", () => {
    const rule = ".terminal-xterm .xterm .xterm-viewport{}"
    expect(missingScreenStyles({ "assets/connect.css": sheet(rule) })).toBe(false)
    const bytes = { type: "asset", fileName: "a.css", source: new TextEncoder().encode(rule) }
    expect(missingScreenStyles({ "a.css": bytes })).toBe(false)
  })

  it("fail a build without them, as every build draws terminals", () => {
    const bare = {
      "assets/index.css": sheet(".shell{}"),
      "assets/index.js": { type: "chunk", fileName: "assets/index.js" },
    }
    expect(missingScreenStyles(bare)).toBe(true)
    expect(missingScreenStyles({})).toBe(true)
  })
})

describe("the folders Tailwind scans", () => {
  const sheet = (source: string) => ({ type: "asset", fileName: "assets/index.css", source })
  const rule = ".h-\\[min\\(760px\\,calc\\(100vh-80px\\)\\)\\]{height:min(760px,100vh - 80px)}"

  it("passes a build whose CSS holds a utility from each, as text or as bytes", () => {
    expect(missingUtilities({ "assets/index.css": sheet(`.flex{}${rule}`) })).toEqual([])
    const bytes = { type: "asset", fileName: "a.css", source: new TextEncoder().encode(rule) }
    expect(missingUtilities({ "a.css": bytes })).toEqual([])
  })

  it("names the folder whose utility the CSS lost", () => {
    const lost = [`${scannedUtilities[0]!.utility} from ${scannedUtilities[0]!.folder}`]
    expect(missingUtilities({ "assets/index.css": sheet(".flex{}") })).toEqual(lost)
    expect(missingUtilities({})).toEqual(lost)
    // The class named in a script is not the rule in a stylesheet.
    const script = { type: "chunk", fileName: "assets/index.js", code: rule }
    expect(missingUtilities({ "assets/index.js": script })).toEqual(lost)
  })
})

describe("the visitor build's budgets", () => {
  // Chunks as heavy as their code is long, so a test says what each weighs.
  const chunk = (code: string, fields: Partial<WeighedChunk> = {}): WeighedChunk => ({
    type: "chunk",
    code,
    ...fields,
  })
  const weigh = (code: string): number => code.length
  const built = (first: number, demoSize: number) => ({
    "index.js": chunk("x".repeat(first), { isEntry: true, imports: ["shared.js"] }),
    "shared.js": chunk(""),
    "connect.js": chunk("y".repeat(demoSize), {
      facadeModuleId: "/work/ui/src/backend/demo/visitor/connect.ts",
      imports: ["shared.js", "emulator.js"],
    }),
    "emulator.js": chunk(""),
  })

  it("passes a build within them, weighing what it shares with the page once", () => {
    expect(
      budgetViolations("try", built(visitorBudgets.first, visitorBudgets.demo), weigh),
    ).toEqual([])
  })

  it("fails a build whose first or demo chunks weigh more", () => {
    expect(budgetViolations("try", built(visitorBudgets.first + 1, 0), weigh)).toHaveLength(1)
    expect(budgetViolations("try", built(0, visitorBudgets.demo + 1), weigh)).toHaveLength(1)
  })

  it("fails a visitor build with no demo chunk to weigh, and asks nothing of the others", () => {
    expect(budgetViolations("try", { "index.js": chunk("", { isEntry: true }) }, weigh)).toEqual([
      "no demo chunk found for /backend/demo/visitor/connect.ts",
    ])
    // A demo chunk moved or renamed is no demo chunk.
    expect(
      budgetViolations(
        "try",
        {
          "index.js": chunk("", { isEntry: true }),
          "connect.js": chunk("", { facadeModuleId: "/work/demo/src/visitor/connect.ts" }),
        },
        weigh,
      ),
    ).toHaveLength(1)
    expect(
      budgetViolations(
        "production",
        built(visitorBudgets.first + 1, visitorBudgets.demo + 1),
        weigh,
      ),
    ).toEqual([])
  })

  it("counts what the first chunks' styles weigh, and every font they declare, in the first load", () => {
    const font = { type: "asset", fileName: "assets/mono.woff2", source: new Uint8Array(5000) }
    const styled = (fontSize: number) => ({
      ...built(visitorBudgets.first - 10_000, 0),
      "index.js": chunk("x".repeat(visitorBudgets.first - 10_000), {
        isEntry: true,
        imports: ["shared.js"],
        viteMetadata: { importedCss: new Set(["assets/index.css"]) },
      }),
      "assets/index.css": {
        type: "asset",
        fileName: "assets/index.css",
        source: "@font-face{src:url(./mono.woff2)}",
      },
      "assets/mono.woff2": { ...font, source: new Uint8Array(fontSize) },
    })
    expect(budgetViolations("try", styled(5_000), weigh)).toEqual([])
    expect(budgetViolations("try", styled(20_000), weigh)).toHaveLength(1)
  })

  it("weighs a font by its bytes, not as text", () => {
    // Pairs of bytes that read as one character each.
    const bytes = new Uint8Array(15_000).map((_, at) => (at % 2 === 0 ? 0xc3 : 0xa9))
    const fonted = {
      ...built(visitorBudgets.first - 10_000, 0),
      "index.js": chunk("x".repeat(visitorBudgets.first - 10_000), {
        isEntry: true,
        imports: ["shared.js"],
        viteMetadata: { importedCss: new Set(["assets/index.css"]) },
      }),
      "assets/index.css": {
        type: "asset",
        fileName: "assets/index.css",
        source: "@font-face{src:url(./mono.woff2)}",
      },
      "assets/mono.woff2": { type: "asset", fileName: "assets/mono.woff2", source: bytes },
    }
    expect(budgetViolations("try", fonted, weigh)).toHaveLength(1)
  })
})
