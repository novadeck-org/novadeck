import { parse } from "smol-toml"
import { describe, expect, it } from "vitest"

import { rootsSetting, theirRoots } from "./roots.js"

describe("the person's own writable roots", () => {
  it("are read from their table, its dotted key, or an inline table", () => {
    expect(theirRoots(`[sandbox_workspace_write]\nwritable_roots = ["/a", "/b"]\n`)).toEqual([
      "/a",
      "/b",
    ])
    expect(theirRoots(`sandbox_workspace_write.writable_roots = ['/a']\n`)).toEqual(["/a"])
    expect(theirRoots(`sandbox_workspace_write = { writable_roots = ["/a"] }\n`)).toEqual(["/a"])
    expect(
      theirRoots(`[sandbox_workspace_write]\nwritable_roots = [\n  "/a", # theirs\n  "/b",\n]\n`),
    ).toEqual(["/a", "/b"])
  })

  it("are none where the config sets none, doesn't read as TOML, or isn't there", () => {
    expect(theirRoots("")).toEqual([])
    expect(theirRoots(`model = "o3"\n[sandbox_workspace_write]\nnetwork_access = true\n`)).toEqual(
      [],
    )
    expect(theirRoots(`[sandbox_workspace_write\nwritable_roots = ["/a"]`)).toEqual([])
    expect(theirRoots(`[sandbox_workspace_write]\nwritable_roots = "/a"\n`)).toEqual([])
    // A profile's are its own, which the shim leaves standing.
    expect(theirRoots(`[profiles.x.sandbox_workspace_write]\nwritable_roots = ["/p"]\n`)).toEqual(
      [],
    )
  })
})

describe("the setting that gives a session its roots", () => {
  /** What Codex reads of the setting: its value as TOML. */
  const read = (setting: string): unknown =>
    parse(`v = ${setting.slice(setting.indexOf("=") + 1)}`).v

  it("names each folder once, as written, a Windows path's backslashes kept", () => {
    const setting = rootsSetting(["C:\\Users\\x y\\.novadeck\\worktrees", "/home/x", "/home/x"])
    expect(setting.startsWith("sandbox_workspace_write.writable_roots=[")).toBe(true)
    expect(read(setting)).toEqual(["C:\\Users\\x y\\.novadeck\\worktrees", "/home/x"])
    // No double quote, so cmd passes it whole in one.
    expect(setting).not.toContain('"')
  })

  it("names a folder holding a single quote in a basic string", () => {
    expect(read(rootsSetting(["/home/it's", "/a"]))).toEqual(["/home/it's", "/a"])
  })
})
