import { randomBytes } from "node:crypto"

import { describe, expect, it } from "vitest"

import {
  budgetViolations,
  bundleChecks,
  firstChunkGaps,
  firstChunkViolations,
  frontendUtilities,
  missingScreenStyles,
  missingUtilities,
  type Budgets,
  type BuiltChunk,
  type ScannedUtility,
  type WeighedChunk,
} from "./bundle-checks.ts"

const app = "/work/ui/src/app/App.tsx"

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

  it("fail a build whose only mention of the screen's host is another sheet's rule", () => {
    for (const other of [".terminal-xterm{background:red}", ".terminal-xterm-frame .xterm{}"])
      expect(missingScreenStyles({ "a.css": sheet(other) }), other).toBe(true)
  })
})

describe("the folders Tailwind scans", () => {
  const utilities: readonly ScannedUtility[] = [
    { folder: "frontend/demo-debug/", utility: "h-[min(760px,calc(100vh-80px))]" },
  ]
  const sheet = (source: string) => ({ type: "asset", fileName: "assets/index.css", source })
  const rule = ".h-\\[min\\(760px\\,calc\\(100vh-80px\\)\\)\\]{height:min(760px,100vh - 80px)}"

  it("passes a build whose CSS holds a utility from each, as text or as bytes", () => {
    expect(missingUtilities({ "assets/index.css": sheet(`.flex{}${rule}`) }, utilities)).toEqual([])
    const bytes = { type: "asset", fileName: "a.css", source: new TextEncoder().encode(rule) }
    expect(missingUtilities({ "a.css": bytes }, utilities)).toEqual([])
  })

  it("names the folder whose utility the CSS lost", () => {
    const lost = [`${utilities[0]!.utility} from ${utilities[0]!.folder}`]
    expect(missingUtilities({ "assets/index.css": sheet(".flex{}") }, utilities)).toEqual(lost)
    expect(missingUtilities({}, utilities)).toEqual(lost)
    // Another utility that starts with the guard's is not the guard's.
    const near = { type: "asset", fileName: "assets/index.css", source: ".underline-offset-2{}" }
    expect(
      missingUtilities({ "a.css": near }, [{ folder: "frontend/demo/", utility: "underline" }]),
    ).toEqual(["underline from frontend/demo/"])
    const exact = { type: "asset", fileName: "assets/index.css", source: ".a,.underline{}" }
    expect(
      missingUtilities({ "a.css": exact }, [{ folder: "frontend/demo/", utility: "underline" }]),
    ).toEqual([])
    // The class named in a script is not the rule in a stylesheet.
    const script = { type: "chunk", fileName: "assets/index.js", code: rule }
    expect(missingUtilities({ "assets/index.js": script }, utilities)).toEqual(lost)
  })
})

describe("a build's budgets", () => {
  // Budgets of this test's own: the numbers are arbitrary, not an app's.
  const visitorBudgets: Budgets = {
    first: 1_100_000,
    demo: 190_000,
    demoModule: "/frontend/demo/src/visitor/connect.ts",
  }
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
      facadeModuleId: "/work/frontend/demo/src/visitor/connect.ts",
      imports: ["shared.js", "emulator.js"],
    }),
    "emulator.js": chunk(""),
  })

  it("passes a build within them, weighing what it shares with the page once", () => {
    expect(
      budgetViolations(visitorBudgets, built(visitorBudgets.first, visitorBudgets.demo), weigh),
    ).toEqual([])
  })

  it("fails a build whose first or demo chunks weigh more", () => {
    expect(
      budgetViolations(visitorBudgets, built(visitorBudgets.first + 1, 0), weigh),
    ).toHaveLength(1)
    expect(budgetViolations(visitorBudgets, built(0, visitorBudgets.demo + 1), weigh)).toHaveLength(
      1,
    )
  })

  it("fails a build with no demo chunk to weigh", () => {
    expect(
      budgetViolations(visitorBudgets, { "index.js": chunk("", { isEntry: true }) }, weigh),
    ).toEqual(["no demo chunk found for /frontend/demo/src/visitor/connect.ts"])
    // A demo chunk moved or renamed is no demo chunk.
    expect(
      budgetViolations(
        visitorBudgets,
        {
          "index.js": chunk("", { isEntry: true }),
          "connect.js": chunk("", { facadeModuleId: "/work/demo/visitor/connect.ts" }),
        },
        weigh,
      ),
    ).toHaveLength(1)
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
    expect(budgetViolations(visitorBudgets, styled(5_000), weigh)).toEqual([])
    expect(budgetViolations(visitorBudgets, styled(20_000), weigh)).toHaveLength(1)
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
    expect(budgetViolations(visitorBudgets, fonted, weigh)).toHaveLength(1)
  })

  it("counts a font declared with a query or a fragment after its file", () => {
    for (const url of ["./mono.woff2?v=3", '"./mono.woff2#iefix"']) {
      const declared = {
        ...built(visitorBudgets.first - 10_000, 0),
        "index.js": chunk("x".repeat(visitorBudgets.first - 10_000), {
          isEntry: true,
          imports: ["shared.js"],
          viteMetadata: { importedCss: new Set(["assets/index.css"]) },
        }),
        "assets/index.css": {
          type: "asset",
          fileName: "assets/index.css",
          source: `@font-face{src:url(${url})}`,
        },
        "assets/mono.woff2": {
          type: "asset",
          fileName: "assets/mono.woff2",
          source: new Uint8Array(20_000),
        },
      }
      expect(budgetViolations(visitorBudgets, declared, weigh), url).toHaveLength(1)
    }
  })
})

describe("the bundleChecks plugin", () => {
  // A rule for each utility, as Tailwind writes its class.
  const rules = frontendUtilities
    .map(({ utility }) => `.${utility.replace(/[^\w-]/g, "\\$&")}{}`)
    .join("")
  const screens = ".terminal-xterm .xterm .xterm-viewport{}"
  const xterm = "/work/node_modules/@xterm/xterm/lib/xterm.mjs"
  // A bundle that passes every check, with `change` made to it.
  const bundle = (change: Record<string, unknown> = {}) => ({
    "index.js": {
      type: "chunk",
      isEntry: true,
      imports: [],
      modules: { [app]: {} },
      code: "x",
      viteMetadata: { importedCss: new Set(["index.css"]) },
    },
    "connect.js": {
      type: "chunk",
      modules: { [xterm]: {} },
      code: "y",
      facadeModuleId: "/work/frontend/demo/src/visitor/connect.ts",
    },
    "index.css": { type: "asset", fileName: "index.css", source: `${rules}${screens}` },
    ...change,
  })
  const budgets: Budgets = {
    first: 1_000,
    demo: 1_000,
    demoModule: "/frontend/demo/src/visitor/connect.ts",
  }
  // What the plugin reports for a build of `bundle` in the `try` mode, through Vite's `error`.
  const errors = (built: Record<string, unknown>, options: { budgets?: Budgets } = {}) => {
    const plugin = bundleChecks({ utilities: frontendUtilities, ...options })
    ;(plugin.configResolved as (config: { mode: string }) => void)({ mode: "try" })
    const reported: string[] = []
    ;(plugin.generateBundle as (this: unknown, output: unknown, bundle: unknown) => void).call(
      { error: (message: string) => void reported.push(message) },
      {},
      built,
    )
    return reported
  }

  it("runs only in builds", () => {
    expect(bundleChecks({ utilities: frontendUtilities }).apply).toBe("build")
  })

  it("passes a bundle that holds what every check reads", () => {
    expect(errors(bundle())).toEqual([])
    expect(errors(bundle(), { budgets })).toEqual([])
  })

  it("fails a bundle each check rejects, naming the build's mode", () => {
    const cases: [string, Record<string, unknown>, { budgets?: Budgets }?][] = [
      ["holds nothing for checks to read", { "connect.js": { type: "chunk", modules: {} } }],
      [
        "loads the terminal emulator with its first chunk",
        { "index.js": { ...bundle()["index.js"], modules: { [app]: {}, [xterm]: {} } } },
      ],
      [
        "is over its budget",
        // Text gzip can't shrink below the budget, as the plugin weighs it gzipped.
        { "index.js": { ...bundle()["index.js"], code: randomBytes(5_000).toString("base64") } },
        { budgets },
      ],
      [
        "lost a folder Tailwind scans",
        { "index.css": { type: "asset", fileName: "index.css", source: screens } },
      ],
      [
        "draws terminals without their styles",
        { "index.css": { type: "asset", fileName: "index.css", source: rules } },
      ],
    ]
    for (const [what, change, options] of cases) {
      const reported = errors(bundle(change), options)
      expect(reported, what).toHaveLength(1)
      expect(reported[0], what).toContain(`The try build ${what}`)
    }
  })
})
