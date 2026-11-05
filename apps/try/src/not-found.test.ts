// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { build, type Rollup } from "vite"
import { afterAll, describe, expect, it } from "vitest"

import { notFound, notFoundPage } from "./deploy"

// A build of an empty entry with only the 404 plugin, in a mode, and the files it writes.
const root = mkdtempSync(join(tmpdir(), "try-not-found-"))
writeFileSync(join(root, "entry.js"), "export {}\n")
afterAll(() => rmSync(root, { recursive: true, force: true }))

const built = async (mode: string): Promise<Map<string, string | Uint8Array>> => {
  const output = (await build({
    root,
    mode,
    configFile: false,
    logLevel: "silent",
    plugins: [notFound()],
    build: { write: false, minify: false, rollupOptions: { input: join(root, "entry.js") } },
  })) as Rollup.RollupOutput
  return new Map(
    output.output.map((file) => [file.fileName, file.type === "asset" ? file.source : file.code]),
  )
}

describe("the visitor build's 404 page", () => {
  it("is in the visitor build, so its host answers a missing file with a 404", async () => {
    expect((await built("try")).get("404.html")).toBe(notFoundPage)
  })

  it("is the visitor build's alone", async () => {
    expect((await built("production")).has("404.html")).toBe(false)
  })

  it("sends a person on to the demo, with no script, which the page's policy wouldn't run", () => {
    expect(notFoundPage).toContain('<meta http-equiv="refresh" content="0; url=/" />')
    expect(notFoundPage).toContain('<a href="/">')
    expect(notFoundPage).not.toMatch(/<script\b/)
  })
})
