import { describe, expect, it } from "vitest"

import { asClassic } from "./classic.js"

const modules = import.meta.glob<string>(
  [
    "../../node_modules/pdfjs-dist/build/pdf.min.mjs",
    "../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
  ],
  { query: "?raw", import: "default" },
)

describe("a pdf.js module as a classic script", () => {
  it("puts its exports on the global it names, renamed ones by their exported names", () => {
    const text = asClassic(
      "const a=1,b=2;console.log(import.meta.url);export{a,b as Two};",
      "pdfjsLib",
    )
    expect(text).not.toMatch(/export\s*\{|import\.meta/)
    const scope = { console: { log: () => {} } } as Record<string, unknown>
    new Function("globalThis", "console", text)(scope, scope.console)
    expect(scope.pdfjsLib).toEqual({ a: 1, Two: 2 })
  })

  it("refuses a module that doesn't end in its one export list", () => {
    const refused = "pdf.js's module doesn't end in its one export list"
    expect(() => asClassic("export{a};const b=1", "pdfjsLib")).toThrow(refused)
    expect(() => asClassic("export{a};export{b}", "pdfjsLib")).toThrow(refused)
  })

  it("takes pdf.js's own two modules", async () => {
    for (const [path, load] of Object.entries(modules)) {
      // eslint-disable-next-line no-await-in-loop -- One module after another.
      const text = asClassic(await load(), path.includes("worker") ? "pdfjsWorker" : "pdfjsLib")
      expect(text, path).not.toMatch(/import\.meta|\bexport\s*\{/)
      // It parses as a classic script.
      expect(() => new Function(text), path).not.toThrow()
    }
  })
})
