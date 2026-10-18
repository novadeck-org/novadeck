import { describe, expect, it } from "vitest"

import { headersFile, hostingHeaders } from "./hosting-headers.ts"

const rules = [
  { path: "/*", headers: { "X-Robots-Tag": "noindex", "X-Frame": "deny" } },
  { path: "/assets/*", headers: { "Cache-Control": "immutable" } },
]

describe("headersFile", () => {
  it("lists each path, then its headers indented beneath, ending in a newline", () => {
    expect(headersFile(rules)).toBe(
      "/*\n  X-Robots-Tag: noindex\n  X-Frame: deny\n/assets/*\n  Cache-Control: immutable\n",
    )
  })
})

describe("hostingHeaders", () => {
  // The files the plugin emits for a build in `mode`.
  const emitted = (mode: string) => {
    const plugin = hostingHeaders({ rules: (each) => (each === "try" ? rules : undefined) })
    ;(plugin.configResolved as (config: { mode: string }) => void)({ mode })
    const files: { fileName: string; source: string }[] = []
    ;(plugin.generateBundle as (this: unknown) => void).call({
      emitFile: (file: { fileName: string; source: string }) => files.push(file),
    })
    return files
  }

  it("emits a build's _headers where its rules have any", () => {
    expect(emitted("try")).toEqual([
      expect.objectContaining({ fileName: "_headers", source: headersFile(rules) }),
    ])
  })

  it("emits nothing for a build without rules", () => {
    expect(emitted("production")).toEqual([])
  })

  it("runs only in builds", () => {
    expect(hostingHeaders({ rules: () => rules }).apply).toBe("build")
  })
})
