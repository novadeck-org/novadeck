import { describe, expect, it } from "vitest"

import { forgeNote, hostLine, type ForgeSwitch } from "./forge-switches"

const github: ForgeSwitch = {
  forge: "github",
  available: true,
  enabled: true,
  busy: false,
  hosts: [],
}

describe("a forge's switch note", () => {
  it("says which tool it reads with once the forge can be switched", () => {
    expect(forgeNote(github)).toEqual({ text: "Uses your signed-in gh", error: false })
    expect(forgeNote({ ...github, forge: "azure", enabled: false })?.text).toBe(
      "Uses your signed-in az",
    )
  })

  it("says it is switching, in the direction it goes", () => {
    expect(forgeNote({ ...github, busy: true })?.text).toBe("Switching off…")
    expect(forgeNote({ ...github, enabled: false, busy: true })?.text).toBe("Switching on…")
  })

  it("gives the last failure as an error, and the tool a missing forge needs", () => {
    expect(forgeNote({ ...github, error: "no token" })).toEqual({ text: "no token", error: true })
    expect(forgeNote({ ...github, forge: "gitlab", available: false, enabled: false })).toEqual({
      text: "Not installed. Needs glab",
      error: false,
    })
  })
})

describe("a host's line", () => {
  it("offers a signed-out host's command to sign in with, and shows a refused one's to read", () => {
    const fix = "glab auth login --hostname gitlab.com"
    expect(hostLine({ host: "gitlab.com", state: "signed-out", fix })).toEqual({
      host: "gitlab.com",
      words: "Signed out",
      signIn: fix,
      fix: undefined,
    })
    expect(hostLine({ host: "gitlab.com", state: "refused", fix })).toEqual({
      host: "gitlab.com",
      words: "Token refused",
      signIn: undefined,
      fix,
    })
  })

  it("has nothing to run for a signed-in host or one with no command", () => {
    expect(hostLine({ host: "github.com", state: "signed-in", fix: "gh auth login" })).toEqual({
      host: "github.com",
      words: "Signed in",
      signIn: undefined,
      fix: undefined,
    })
    expect(hostLine({ host: "x.dev", state: "signed-out" }).signIn).toBeUndefined()
  })
})
