import { posix, win32 } from "node:path"

import { describe, expect, it } from "vitest"

import { beside, flavourOf, samePath } from "./paths.js"

describe("the path rules", () => {
  it("are Windows' for a drive, a UNC share or a backslash anywhere, POSIX's otherwise", () => {
    for (const path of ["C:\\Work", "c:/work", "\\\\host\\share", "src\\a.ts"])
      expect(flavourOf(path)).toBe(win32)
    for (const path of ["/w/a.ts", "a.ts", "../a.ts"]) expect(flavourOf(path)).toBe(posix)
    expect(flavourOf(undefined)).toBe(posix)
    expect(flavourOf("a.ts", "C:\\Work")).toBe(win32)
  })
})

describe("two paths", () => {
  it("are the same file once normalized, never for a part of one", () => {
    expect(samePath("/w/src/../a.ts", "/w/a.ts")).toBe(true)
    for (const other of ["/w/data.ts", "/w/a.tsx", "/w/x/a.ts", "/w/..a.ts"])
      expect(samePath("/w/a.ts", other)).toBe(false)
  })

  it("compare POSIX paths with their case", () => {
    expect(samePath("/w/SRC/a.ts", "/w/src/a.ts")).toBe(false)
  })

  it("compare a Windows drive's paths across separators and case", () => {
    expect(samePath("C:\\Work\\a.ts", "c:/work/A.ts")).toBe(true)
    expect(samePath("C:\\Work\\src\\b.ts", "C:/WORK/src/b.ts")).toBe(true)
    expect(samePath("C:\\Work\\src\\b.ts", "C:\\Work\\src\\c.ts")).toBe(false)
    expect(samePath("\\\\host\\share\\a.ts", "\\\\host\\share\\a.ts")).toBe(true)
  })
})

describe("beside", () => {
  it("names a folder next to the nearest one above the path with the marker", () => {
    expect(beside("/home/a/.claude-work/projects/x/s.jsonl", "projects", "plans")).toEqual([
      "/home/a/.claude-work/plans",
    ])
    expect(beside("C:\\Users\\a\\.claude\\projects\\x\\s\\sub.jsonl", "projects", "plans")).toEqual(
      ["C:\\Users\\a\\.claude\\plans"],
    )
    expect(beside("/h/.gemini/antigravity-cli/brain/id/t.json", "brain", "brain")).toEqual([
      "/h/.gemini/antigravity-cli/brain",
    ])
    expect(beside("/h/other/s.jsonl", "projects", "plans")).toEqual([])
  })
})
