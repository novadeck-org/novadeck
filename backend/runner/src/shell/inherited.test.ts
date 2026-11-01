import { describe, expect, it } from "vitest"

import { stripInherited, withoutInherited } from "./inherited.js"

describe("withoutInherited", () => {
  it("drops the names exactly as spelt on Linux and macOS, and keeps other cases", () => {
    const env = { NOVADECK_TOKEN: "a", novadeck_token: "b", PATH: "/bin" }
    expect(withoutInherited(env, "linux")).toEqual({ novadeck_token: "b", PATH: "/bin" })
    expect(withoutInherited(env, "darwin")).toEqual({ novadeck_token: "b", PATH: "/bin" })
  })

  it("drops them in any case on Windows, where names have none", () => {
    const env = { Novadeck_Token: "a", novadeck_terminal_id: "b", claudecode: "1", Path: "C:\\" }
    expect(withoutInherited(env, "win32")).toEqual({ Path: "C:\\" })
  })

  it("leaves the env it was given as it was", () => {
    const env = { NOVADECK_TOKEN: "a" }
    withoutInherited(env, "win32")
    expect(env).toEqual({ NOVADECK_TOKEN: "a" })
  })
})

describe("stripInherited", () => {
  it("strips the env in place", () => {
    const env: NodeJS.ProcessEnv = { novadeck_hook: "x", HOME: "/h" }
    stripInherited(env, "win32")
    expect(env).toEqual({ HOME: "/h" })
  })
})
