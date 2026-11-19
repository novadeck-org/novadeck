import { join } from "node:path"

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

  it("are named from a conversation file's own home, a few folders under `brain`", () => {
    const home = "/a/.gemini/antigravity-cli"
    expect(agy.bookkeepingOf(`${home}/brain/c1/log.txt`)).toEqual([join(home, "brain")])
    expect(agy.bookkeepingOf(`${home}/brain/c1/.system/logs/overview.txt`)).toEqual([
      join(home, "brain"),
    ])
  })

  it("name none for a path laid out otherwise", () => {
    expect(agy.bookkeepingOf("/home/u/brain/x/y/z/w/v/log.txt")).toEqual([])
    expect(agy.bookkeepingOf("/home/u/work/brain.txt")).toEqual([])
  })
})
