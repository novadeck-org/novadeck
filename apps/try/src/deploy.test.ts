import { globSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { headersFile } from "@novadeck/build-kit/hosting-headers"
import { describe as context, describe, expect, it } from "vitest"

import { connect, headerRules, hidden } from "./deploy"

const root = join(import.meta.dirname, "../../..")

// Each entry's page, whichever app holds it, found rather than listed so that a new app's is
// read too. Builds and installed packages hold pages that aren't an app's own.
const pages = globSync("apps/**/index.html", {
  cwd: root,
  exclude: ["**/node_modules", "**/dist*", "**/out", "**/release"],
})
  .map((path) => ({
    path: path.split("\\").join("/"),
    html: readFileSync(join(root, path), "utf8"),
  }))
  .toSorted((a, b) => a.path.localeCompare(b.path))

describe("frontend Content Security Policy", () => {
  it("checks the page of every entry: the desktop and browser apps', the visitor build's and the content preview's", () => {
    expect(pages.map(({ path }) => path)).toEqual([
      "apps/desktop/renderer/index.html",
      "apps/desktop/renderer/web/index.html",
      "apps/previews/index.html",
      "apps/try/index.html",
    ])
  })

  it.each(pages)(
    "runs only same-origin script files in $path, the theme's boot script too",
    ({ html }) => {
      expect(html).toContain("script-src 'self';")
      expect(html).toContain('<script src="./theme-boot.js"></script>')
      // Every script has a source; none is inline.
      expect([...html.matchAll(/<script\b[^>]*>/g)].every(([tag]) => tag.includes(" src="))).toBe(
        true,
      )
    },
  )

  it("gives every entry's page the same document, but for the script it starts", () => {
    // The theme's boot script, the policy and the SVG filters are every app's.
    const shared = (html: string) =>
      html.replace(/<script type="module" src="[^"]*"><\/script>/, "")
    for (const page of pages) expect(shared(page.html)).toBe(shared(pages[0]!.html))
  })

  context("for a build in another mode", () => {
    it("allows the configured runner, named by its variable", () => {
      expect(
        connect({
          mode: "production",
          command: "build",
          env: { VITE_NOVADECK_RUNNER_URL: "wss://runner.example.com/api/rpc" },
        }),
      ).toEqual(["'self'", "http://127.0.0.1:*", "wss://runner.example.com"])
    })

    it("names the variable that's wrong", () => {
      expect(() =>
        connect({
          mode: "production",
          command: "build",
          env: { VITE_NOVADECK_RUNNER_URL: "https://runner.example.com" },
        }),
      ).toThrow("VITE_NOVADECK_RUNNER_URL must be an absolute ws: or wss: URL")
    })
  })

  context("for the visitor build", () => {
    it("reaches nothing but the page's own origin, whatever is configured", () => {
      expect(
        connect({
          mode: "try",
          command: "build",
          env: { VITE_NOVADECK_RUNNER_URL: "wss://runner.example.com" },
        }),
      ).toEqual(["'self'"])
    })

    it("still allows the development server's WebSocket while served", () => {
      expect(connect({ mode: "try", command: "serve", env: {} })).toContain("ws://127.0.0.1:*")
    })
  })
})

describe("search visibility", () => {
  it("keeps the visitor build out of search results, and no other", () => {
    expect(hidden("try")).toBe(true)
    expect(hidden("production")).toBe(false)
  })
})

describe("the visitor build's hosting headers", () => {
  const lines = headersFile(headerRules("try") ?? []).split("\n")

  it("is the visitor build's alone", () => {
    expect(headerRules("production")).toBeUndefined()
  })

  it("lets only the website frame the demo", () => {
    expect(lines).toContain(
      "  Content-Security-Policy: frame-ancestors 'self' https://novadeck.dev",
    )
  })

  it("keeps every file out of search results", () => {
    expect(lines.slice(0, 3)).toEqual([
      "/*",
      expect.stringContaining("frame-ancestors"),
      "  X-Robots-Tag: noindex",
    ])
  })

  it("lets browsers keep hashed assets for good", () => {
    expect(lines.slice(3, 5)).toEqual([
      "/assets/*",
      "  Cache-Control: public, max-age=31536000, immutable",
    ])
  })

  it("keeps the posters only briefly, since their names stay the same", () => {
    expect(lines.slice(5, 7)).toEqual(["/poster-*", "  Cache-Control: public, max-age=300"])
  })

  it("sets no header under two rules, which Cloudflare would join", () => {
    const names = lines.filter((line) => line.startsWith("  ")).map((line) => line.split(":")[0])
    const cached = names.filter((name) => name === "  Cache-Control")
    // /assets/* and /poster-* never match the same path, so each file has one.
    expect(cached).toHaveLength(2)
    expect(new Set(names).size).toBe(3)
  })
})
