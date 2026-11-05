import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { commands, withoutCredentials } from "./machine.ts"

const folders: string[] = []
afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true })
})

// The environment a command the build runs sees, as it wrote it out.
const seen = (options: { credentials?: boolean }): NodeJS.ProcessEnv => {
  const folder = mkdtempSync(join(tmpdir(), "ggml-build-"))
  folders.push(folder)
  const file = join(folder, "env.json")
  const env = {
    ...process.env,
    AZURE_TENANT_ID: "tenant",
    AZURE_CLIENT_ID: "client",
    AZURE_CLIENT_SECRET: "secret",
    AZURE_SIGNING_ACCOUNT: "account",
  }
  commands("voice engine", folder)(
    process.execPath,
    [
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(file)}, JSON.stringify(process.env))`,
    ],
    { env, ...options },
  )
  return JSON.parse(readFileSync(file, "utf8")) as NodeJS.ProcessEnv
}

describe("the build's commands", () => {
  it("run without the signing credentials, as CMake and git run upstream's scripts", () => {
    const env = seen({})
    expect(env.AZURE_TENANT_ID).toBeUndefined()
    expect(env.AZURE_CLIENT_ID).toBeUndefined()
    expect(env.AZURE_CLIENT_SECRET).toBeUndefined()
    // The account is no secret, and names what to sign with.
    expect(env.AZURE_SIGNING_ACCOUNT).toBe("account")
  })

  it("give the credentials to the signing call alone", () => {
    expect(seen({ credentials: true }).AZURE_CLIENT_SECRET).toBe("secret")
  })

  it("leave them out however Windows spells them", () => {
    expect(withoutCredentials({ azure_client_secret: "secret", Path: "C:\\bin" })).toEqual({
      Path: "C:\\bin",
    })
  })
})
