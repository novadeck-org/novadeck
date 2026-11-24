import { describe, expect, it } from "vitest"

import { hooksTrusted } from "./trust.js"

const where = (argv?: readonly string[]) => ({
  env: {},
  home: "/home/me",
  platform: "linux" as const,
  plugin: "/data/plugins/pi",
  ...(argv !== undefined && { argv }),
})

describe("whether Novadeck's extension is loaded in a pi", () => {
  it("is, where the shim added it with -e or --extension", async () => {
    const extension = "/data/shell/plugins/pi/novadeck.mjs"
    expect(await hooksTrusted(where(["node", "/pi/cli.js", "-e", extension]), "/p")).toBe(true)
    expect(await hooksTrusted(where(["pi", "--extension", extension, "hello"]), "/p")).toBe(true)
    expect(await hooksTrusted(where(["pi", `--extension=${extension}`]), "/p")).toBe(true)
    expect(await hooksTrusted(where(["pi", "-e", "C:\\n\\plugins\\pi\\novadeck.mjs"]), "/p")).toBe(
      true,
    )
  })

  it("is not, where pi runs past the shim, or with another extension", async () => {
    expect(await hooksTrusted(where(["pi"]), "/p")).toBe(false)
    expect(await hooksTrusted(where(["node", "/pi/cli.js", "hello"]), "/p")).toBe(false)
    expect(await hooksTrusted(where(["pi", "-e", "/mine/own.ts"]), "/p")).toBe(false)
  })

  it("isn't told where the platform shows no arguments", async () => {
    expect(await hooksTrusted(where(), "/p")).toBeUndefined()
  })
})
