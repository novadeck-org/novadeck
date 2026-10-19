import { readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "./test"

const app = fileURLToPath(new URL("..", import.meta.url))
// The UI's themes, read where its package is: their CSS names the filters the page draws.
const themes = join(
  dirname(createRequire(join(app, "package.json")).resolve("@novadeck/ui/package.json")),
  "src",
  "theme",
)
const uncomment = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "")

describe("the desktop app's pages", () => {
  // A page's script is its entry, beside it; the desktop page names it from the root, its own
  // folder, so the two pages differ and git tells them apart.
  it.each([
    ["renderer/index.html", "/main.tsx"],
    ["renderer/web/index.html", "./main.tsx"],
  ])("%s starts the entry beside it, which reaches its runner by the adapter", (page, script) => {
    const html = readFileSync(join(app, page), "utf8")
    expect(
      [...html.matchAll(/<script type="module" src="([^"]+)"><\/script>/g)].map(
        (match) => match[1],
      ),
    ).toEqual([script])
    const entry = readFileSync(join(app, dirname(page), "main.tsx"), "utf8")
    expect(entry).toContain('import("@novadeck/runner-adapter")')
    expect(entry).not.toMatch(/@novadeck\/demo/)
  })

  // A theme's `url(#id)` that no page carries draws nothing, silently.
  it("carry every SVG filter the UI's themes apply", () => {
    for (const page of ["renderer/index.html", "renderer/web/index.html"]) {
      const carried = new Set(
        [...readFileSync(join(app, page), "utf8").matchAll(/<filter[^>]*\bid="([^"]+)"/g)].map(
          (match) => match[1],
        ),
      )
      const used = readdirSync(themes)
        .filter((file) => file.endsWith(".css"))
        .flatMap((file) =>
          [
            ...uncomment(readFileSync(join(themes, file), "utf8")).matchAll(
              /url\(\s*["']?#([^"')]+)/g,
            ),
          ].map((match) => match[1]!),
        )
      expect(used.length, "the themes apply no filter: the scan reads nothing").toBeGreaterThan(0)
      expect(
        used.filter((id) => !carried.has(id)),
        page,
      ).toEqual([])
    }
  })
})
