import { readFile } from "node:fs/promises"
import { join } from "node:path"

import type { Manifest } from "vite"

import { context, describe, expect, it } from "./test"

const output = join(process.cwd(), "dist")
const read = (path: string): Promise<string> => readFile(join(output, path), "utf8")

describe("compiled frontend", () => {
  context("when loaded from a packaged directory", () => {
    it("references its assets with relative paths", async () => {
      const html = await read("index.html")
      const paths = [...html.matchAll(/(?:href|src)="(\.\/assets\/[^"]+)"/g)].flatMap((match) =>
        match[1] ? [match[1]] : [],
      )

      expect(paths.some((path) => path.endsWith(".js"))).toBe(true)
      expect(paths.some((path) => path.endsWith(".css"))).toBe(true)
      await expect(
        Promise.all(paths.map((path) => read(path.replace(/^\.\//, "")))),
      ).resolves.toHaveLength(paths.length)
    })

    it("sets the theme with a same-origin script before the app's module loads", async () => {
      const html = await read("index.html")
      const head = html.slice(0, html.indexOf("</head>"))
      const boot = /<script src="\.\/theme-boot\.js"><\/script>/.exec(head)
      const module = /<script type="module"[^>]*src="\.\/assets\/[^"]+\.js"/.exec(html)

      expect(boot).not.toBeNull()
      expect(module).not.toBeNull()
      expect(boot!.index).toBeLessThan(module!.index)
      expect(await read("theme-boot.js")).toContain("novadeck.theme-boot")
    })

    it("ships its fonts as files, which the Content Security Policy allows", async () => {
      const html = await read("index.html")
      const sheets = [...html.matchAll(/href="\.\/(assets\/[^"]+\.css)"/g)].flatMap((match) =>
        match[1] ? [match[1]] : [],
      )
      expect(sheets.length).toBeGreaterThan(0)
      const css = (await Promise.all(sheets.map(read))).join("\n")

      expect(css).toMatch(/url\(\.?\/?[^)]*\.woff2\)/)
      expect(css).not.toContain("url(data:font")
    })

    it("ships every deferred view and its assets alongside the entry point", async () => {
      const manifest: Manifest = JSON.parse(await read(".vite/manifest.json"))
      const chunks = Object.values(manifest)
      const deferred = chunks.filter((chunk) => chunk.isDynamicEntry)
      expect(deferred.length).toBeGreaterThanOrEqual(4)

      const assets = new Set(
        chunks.flatMap((chunk) => [chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? [])]),
      )
      await Promise.all(
        [...assets].map(async (path) => {
          expect(path.startsWith("assets/")).toBe(true)
          expect(await read(path)).not.toBe("")
        }),
      )

      const initial = new Set<string>()
      const visit = (key: string): void => {
        if (initial.has(key)) return
        initial.add(key)
        for (const imported of manifest[key]?.imports ?? []) visit(imported)
      }
      for (const [key, chunk] of Object.entries(manifest)) if (chunk.isEntry) visit(key)
      for (const [key, chunk] of Object.entries(manifest)) {
        if (chunk.isDynamicEntry) expect(initial.has(key)).toBe(false)
      }
    })

    it("contains a production Content Security Policy", async () => {
      const html = await read("index.html")

      expect(html).toContain("script-src 'self';")
      expect(html).toContain("connect-src 'self' http://127.0.0.1:*")
      expect(html).not.toContain("__NOVADECK_CONNECT_SOURCES__")
      expect(html).not.toContain("ws:")
    })
  })
})
