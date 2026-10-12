import { describe, expect, it } from "../test.js"
import { agy } from "./agents/agy.js"
import { harnessLogins } from "./credentials.js"

const antigravity = { service: "gemini", account: "antigravity" }
const targets = () => ["gemini:antigravity", "git:https://github.com"]
// A Keychain that can't be asked, as a locked one over SSH answers.
const locked = () => {
  throw new Error("User interaction is not allowed")
}

describe("a harness's login in Windows' Credential Manager", () => {
  it("is a target its credentials name, and no other", () => {
    expect(harnessLogins([agy], "win32", { targets })).toEqual(["gemini:antigravity"])
    expect(harnessLogins([agy], "win32", { targets: () => ["git:https://github.com"] })).toEqual([])
  })
})

describe("a harness's login in the macOS Keychain", () => {
  it("is each item its setup names that the Keychain holds, named as Windows names it", () => {
    const asked: unknown[] = []
    const holds = (item: unknown) => {
      asked.push(item)
      return true
    }

    expect(harnessLogins([agy], "darwin", { holds })).toEqual(["gemini:antigravity"])
    expect(asked).toEqual([antigravity])
  })

  it("counts an item the Keychain holds whatever Windows' patterns say", () => {
    const setup = { keychain: [{ service: "other", account: "login" }], credentials: [] }

    expect(harnessLogins([setup], "darwin", { holds: () => true })).toEqual(["other:login"])
  })

  it("is none while the Keychain doesn't hold it, nor for a harness that names none", () => {
    expect(harnessLogins([agy], "darwin", { holds: () => false })).toEqual([])
    expect(harnessLogins([{}], "darwin", { holds: () => true })).toEqual([])
  })

  it("fails the run where the Keychain can't be asked, rather than read as no login", () => {
    expect(() => harnessLogins([agy], "darwin", { holds: locked })).toThrow(
      "User interaction is not allowed",
    )
  })
})

describe("a harness's login elsewhere", () => {
  it("is never looked for", () => {
    expect(harnessLogins([agy], "linux", { holds: () => true, targets: () => ["x"] })).toEqual([])
  })
})
