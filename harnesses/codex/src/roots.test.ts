import { join, resolve } from "node:path"

import { parse } from "smol-toml"
import { describe, expect, it } from "vitest"

import { rootsGiven, rootsSetting, theirRoots } from "./roots.js"

describe("the person's own writable roots", () => {
  it("are read from their table, its dotted key, or an inline table", () => {
    expect(
      theirRoots(`[sandbox_workspace_write]\nwritable_roots = ["/a", "/b"]\n`, "/home/x/.codex"),
    ).toEqual(["/a", "/b"])
    expect(
      theirRoots(`sandbox_workspace_write.writable_roots = ['/a']\n`, "/home/x/.codex"),
    ).toEqual(["/a"])
    expect(
      theirRoots(`sandbox_workspace_write = { writable_roots = ["/a"] }\n`, "/home/x/.codex"),
    ).toEqual(["/a"])
    expect(
      theirRoots(
        `[sandbox_workspace_write]\nwritable_roots = [\n  "/a", # theirs\n  "/b",\n]\n`,
        "/home/x/.codex",
      ),
    ).toEqual(["/a", "/b"])
  })

  it("are full paths, a relative one of the config's own folder", () => {
    // A full path of this system's own: on Windows, `/home/x/.codex` is of the current drive.
    const folder = resolve("/home/x/.codex")
    const full = resolve("/abs")
    expect(
      theirRoots(
        `[sandbox_workspace_write]\nwritable_roots = ["rel", ${JSON.stringify(full)}]\n`,
        folder,
      ),
    ).toEqual([join(folder, "rel"), full])
  })

  it("are none where the config sets none, doesn't read as TOML, or isn't there", () => {
    expect(theirRoots("", "/home/x/.codex")).toEqual([])
    expect(
      theirRoots(
        `model = "o3"\n[sandbox_workspace_write]\nnetwork_access = true\n`,
        "/home/x/.codex",
      ),
    ).toEqual([])
    expect(
      theirRoots(`[sandbox_workspace_write\nwritable_roots = ["/a"]`, "/home/x/.codex"),
    ).toEqual([])
    expect(
      theirRoots(`[sandbox_workspace_write]\nwritable_roots = "/a"\n`, "/home/x/.codex"),
    ).toEqual([])
    // A profile's are its own, which the shim leaves standing.
    expect(
      theirRoots(
        `[profiles.x.sandbox_workspace_write]\nwritable_roots = ["/p"]\n`,
        "/home/x/.codex",
      ),
    ).toEqual([])
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

  it("names a folder holding single quotes in a literal string that holds no double quote", () => {
    const paths = [
      "C:\\Users\\Mary O'Brien\\.novadeck\\worktrees",
      "/home/end'",
      "/home/two''",
      "/a",
    ]
    const setting = rootsSetting(paths)
    expect(read(setting)).toEqual(paths)
    // Windows' reading of a command line takes out double quotes, which the value never holds.
    expect(setting).not.toContain('"')
  })

  it("names a folder no literal string can hold in a basic one", () => {
    expect(read(rootsSetting(["/a\nb", "/x'''y"]))).toEqual(["/a\nb", "/x'''y"])
  })
})

describe("the writable roots a launch gives", () => {
  it("are read back from the setting the shim passes, as written", () => {
    const roots = ["/home/x/.novadeck/worktrees", "C:\\Users\\O'Brien", "rel"]
    expect(rootsGiven(["-c", rootsSetting(roots), "resume"])).toEqual(roots)
    expect(
      rootsGiven([`--config=${rootsSetting(["/a"])}`, "--config", rootsSetting(["/b"])]),
    ).toEqual(["/a", "/b"])
  })

  it("are read from any form of the setting a word may hold", () => {
    expect(rootsGiven(["-c", "sandbox_workspace_write={writable_roots=['/a']}"])).toEqual(["/a"])
    expect(rootsGiven(["-c", '"sandbox_workspace_write"."writable_roots"=["/a"]'])).toEqual(["/a"])
  })

  it("are none from other settings, other words or none", () => {
    expect(rootsGiven(["-c", 'model="o3"', "-c", "model=o3", "--add-dir=/a"])).toEqual([])
    expect(rootsGiven([rootsSetting(["/a"])])).toEqual([])
    expect(rootsGiven(["-c"])).toEqual([])
    expect(rootsGiven(undefined)).toEqual([])
  })
})
