import { join, posix, win32 } from "node:path"

import { describe, expect, it } from "vitest"

import { agy } from "./index.js"

const install = (env: NodeJS.ProcessEnv = {}) => ({
  env,
  home: join("/", "h"),
  platform: "linux" as const,
  plugin: "",
})

describe("the folders Antigravity keeps for itself", () => {
  it("are its conversations' brain, not the rest of its home", () => {
    expect(agy.bookkeeping(install())).toEqual([join("/h", ".gemini", "antigravity-cli", "brain")])
  })

  // Named in the rules the file's path is written in, whatever machine reads it.
  it("are named from a conversation file's own home, a few folders under `brain`", () => {
    const home = "/a/.gemini/antigravity-cli"
    expect(agy.bookkeepingOf(`${home}/brain/c1/log.txt`)).toEqual([posix.join(home, "brain")])
    expect(agy.bookkeepingOf(`${home}/brain/c1/.system/logs/overview.txt`)).toEqual([
      posix.join(home, "brain"),
    ])
  })

  it("are named from a Windows conversation file, written with either slash", () => {
    const home = "C:\\Users\\Ann\\.gemini\\antigravity-cli"
    const brain = win32.join(home, "brain")
    expect(agy.bookkeepingOf(win32.join(brain, "c1", "log.txt"))).toEqual([brain])
    expect(agy.bookkeepingOf(win32.join(brain, "c1", ".system", "logs", "overview.txt"))).toEqual([
      brain,
    ])
    expect(agy.bookkeepingOf("C:/Users/Ann/.gemini/antigravity-cli/brain/c1/log.txt")).toEqual([
      brain,
    ])
    expect(agy.bookkeepingOf("C:\\Users\\Ann\\brain\\x\\y\\z\\w\\v\\log.txt")).toEqual([])
  })

  it("name none for a path laid out otherwise", () => {
    expect(agy.bookkeepingOf("/home/u/brain/x/y/z/w/v/log.txt")).toEqual([])
    expect(agy.bookkeepingOf("/home/u/work/brain.txt")).toEqual([])
  })
})
