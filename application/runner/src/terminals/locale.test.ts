import { describe, expect, it } from "../test.js"
import { withLocale } from "./locale.js"

const installed = (locale: string) => ["en_US.UTF-8", "pl_PL.UTF-8"].includes(locale)

describe("a shell's locale on macOS", () => {
  it("is the system region's UTF-8 locale when the app was given none", () => {
    const env = withLocale({ PATH: "/bin" }, "darwin", () => "pl_PL", installed)
    expect(env).toEqual({ PATH: "/bin", LANG: "pl_PL.UTF-8" })
  })

  it("leaves out the region's options, as in en_US@rg=plzzzz", () => {
    expect(withLocale({}, "darwin", () => "en_US@rg=plzzzz", installed).LANG).toBe("en_US.UTF-8")
  })

  it("falls back to en_US.UTF-8 for a region the system has no locale for", () => {
    expect(withLocale({}, "darwin", () => "en_PL", installed).LANG).toBe("en_US.UTF-8")
  })

  it("falls back to en_US.UTF-8 when the region can't be read", () => {
    expect(withLocale({}, "darwin", () => undefined, installed).LANG).toBe("en_US.UTF-8")
  })

  it("keeps any locale the app was given", () => {
    for (const env of [{ LANG: "C" }, { LC_ALL: "de_DE.UTF-8" }, { LC_CTYPE: "UTF-8" }])
      expect(withLocale(env, "darwin", () => "pl_PL", installed)).toBe(env)
  })
})

describe("a shell's locale elsewhere", () => {
  it("is left to the system", () => {
    const env = { PATH: "/bin" }
    expect(withLocale(env, "linux", () => "pl_PL", installed)).toBe(env)
  })
})
