import { itemFixture } from "@novadeck/core/testing"

import { describe, expect, it } from "../../test"
import { answersText, completion, suggestionGroups, targetOf } from "./path-field"

describe("the path a field opens", () => {
  it("is the text trimmed and without separators at its end, the POSIX root whole", () => {
    expect(targetOf("  /tmp/render/ ")).toBe("/tmp/render")
    expect(targetOf("~/Downloads//")).toBe("~/Downloads")
    expect(targetOf("/")).toBe("/")
    expect(targetOf("")).toBe("")
  })

  it("keeps a drive's root whole, which `C:` alone is not", () => {
    expect(targetOf("C:\\")).toBe("C:\\")
    expect(targetOf("d:/")).toBe("d:/")
    expect(targetOf("C:\\\\")).toBe("C:\\")
    expect(targetOf("C:\\Users\\me\\")).toBe("C:\\Users\\me")
    expect(targetOf("C:")).toBe("C:")
  })

  it("completes into a folder with the separator its path is written with", () => {
    expect(completion("/tmp/render")).toBe("/tmp/render/")
    expect(completion("C:\\Users")).toBe("C:\\Users\\")
    expect(completion("/tmp/render/")).toBe("/tmp/render/")
  })
})

describe("a folder named for what was typed", () => {
  it("continues the text, in any case, by a name alone", () => {
    expect(answersText("/tmp/render", "/tmp/re")).toBe(true)
    expect(answersText("/tmp/Render", "/tmp/re")).toBe(true)
    expect(answersText("~/Downloads", "~")).toBe(true)
    expect(answersText("/tmp/render", "/tmp/")).toBe(true)
  })

  it("is not an answer to another prefix, or a folder deeper than the text", () => {
    expect(answersText("/tmp/release", "/tmp/ren")).toBe(false)
    expect(answersText("~/Desktop", "~/Dow")).toBe(false)
    expect(answersText("/tmp/render/frames", "/tmp/re")).toBe(false)
  })
})

describe("the suggestions under the field", () => {
  const match = (path: string, real: string) => ({ path, real, count: 1, more: false, open: false })
  const wrote = (path: string, real: string) => ({
    path,
    real,
    handle: "moth",
    harness: "Codex",
    at: 1,
  })
  const shown = (path: string) =>
    itemFixture(`id${path}`, "01", { kind: "folder", name: "x", path, shownAt: 1 })
  const named = (groups: ReturnType<typeof suggestionGroups>) =>
    groups.map(({ id, suggestions }) => [id, suggestions.map(({ path }) => path)])

  it("name a folder the matches name once, by its real path, however each list writes it", () => {
    const groups = suggestionGroups({
      matches: [match("~/.cache/probe", "/home/u/.cache/probe")],
      items: [shown("/home/u/.cache/probe"), shown("/home/u/render")],
      wrote: [wrote("~/.cache/probe", "/home/u/.cache/probe"), wrote("/tmp/x", "/tmp/x")],
      now: 2,
    })
    expect(named(groups)).toEqual([
      ["matches", ["~/.cache/probe"]],
      ["shown", ["/home/u/render"]],
      ["wrote", ["/tmp/x"]],
    ])
  })

  it("read a Windows folder's real path with either slash and in any case", () => {
    const real = "C:\\Users\\Ann\\AppData\\Local\\Temp\\render"
    const groups = suggestionGroups({
      matches: [match("C:\\Users\\Ann\\AppData\\Local\\Temp\\render", real)],
      items: [shown("c:\\users\\ann\\appdata\\local\\temp\\render\\")],
      wrote: [wrote("~/AppData/Local/Temp/render", "C:/Users/Ann/AppData/Local/Temp/render")],
      now: 2,
    })
    expect(named(groups)).toEqual([["matches", [real]]])
  })

  it("keep apart folders that differ only in case off a Windows drive", () => {
    const groups = suggestionGroups({
      matches: [match("/tmp/Render", "/tmp/Render")],
      items: [],
      wrote: [wrote("/tmp/render", "/tmp/render")],
      now: 2,
    })
    expect(named(groups)).toEqual([
      ["matches", ["/tmp/Render"]],
      ["wrote", ["/tmp/render"]],
    ])
  })
})
