import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { sign } from "../scripts/sign-windows.mjs"
import { describe, expect, it } from "./test"

const app = fileURLToPath(new URL("..", import.meta.url))
const workflow = readFileSync(join(app, "../../.github/workflows/package.yml"), "utf8")
const config = readFileSync(join(app, "electron-builder.yml"), "utf8")

// A signed Windows release signs the app's files through the hook, with the tools pinned
// by checksum that the engines are signed with. electron-builder's own Azure signing
// (`azureSignOptions`) installs the newest signing module there is, so nothing may name it.
describe("signing the Windows app", () => {
  it("goes through the hook the Package workflow names, which is there", () => {
    const named = /"-c\.win\.signtoolOptions\.sign=\.\/(\S+)"/.exec(workflow)?.[1]
    expect(named).toBe("scripts/sign-windows.mjs")
    expect(existsSync(join(app, named!))).toBe(true)
    expect(workflow).toContain('"-c.win.signtoolOptions.publisherName=$AZURE_SIGNING_PUBLISHER"')
  })

  it("never goes through electron-builder's own Azure signing", () => {
    expect(workflow).not.toContain("azureSignOptions")
    expect(config).not.toContain("azureSignOptions")
  })

  it("asks the hook for one SHA-256 signature for each file", () => {
    // Any line ending: a Windows checkout reads the config with \r\n.
    expect(config).toMatch(/signtoolOptions:\s+signingHashAlgorithms:\s+- sha256\s/)
  })

  it("stops a release that names the hook but no account, rather than leave a file unsigned", async () => {
    const saved = { ...process.env }
    for (const name of Object.keys(process.env)) {
      if (name.toUpperCase().startsWith("AZURE_SIGNING_")) delete process.env[name]
    }
    try {
      await expect(sign({ path: "novadeck.exe" })).rejects.toThrow(
        "Signing the app needs AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT and AZURE_SIGNING_PROFILE.",
      )
    } finally {
      Object.assign(process.env, saved)
    }
  })
})
