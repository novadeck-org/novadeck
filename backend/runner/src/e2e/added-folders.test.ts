import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { rootsSetting } from "@novadeck/harness-codex/roots"
import { hookReport } from "@novadeck/harness-core/testing/reports"
import { describe, expect, it } from "vitest"

import { harnesses } from "../harnesses/registry.js"
import { addedOutside, watchAddedFolders } from "./added-folders.js"

const root = join("/", "sandbox")
const inside = join(root, "home", ".novadeck", "worktrees")
const outside = join("/", "home", "dev", ".novadeck", "worktrees")

describe("the folders an e2e launch adds", () => {
  it("names those outside the sandbox only", () => {
    expect(addedOutside([`--add-dir=${inside}`], root)).toEqual([])
    expect(addedOutside([`--add-dir=${outside}`], root)).toEqual([`with --add-dir ${outside}`])
    expect(addedOutside(["--add-dir", join(root, "..", "elsewhere")], root)).toHaveLength(1)
    // A folder beside the sandbox whose name starts as its own does is still outside.
    expect(addedOutside([`--add-dir=${root}-other`], root)).toHaveLength(1)
    // A relative folder is the launch's own, within its folder.
    expect(addedOutside(["--add-dir=sub"], root)).toEqual([])
  })

  // Antigravity's Windows shim gives its hooks' folder by its short name, with its drive letter
  // in lower case, as cmd reads it unquoted and Antigravity sorts it last.
  it.runIf(process.platform === "win32")(
    "takes a folder named by its short name, or its drive in another case, as the one it names",
    () => {
      const sandbox = mkdtempSync(join(tmpdir(), "added folders "))
      // A path by its short name, as cmd gives it.
      const shortOf = (path: string): string =>
        spawnSync(
          process.env.COMSPEC ?? "cmd.exe",
          ["/d", "/s", "/c", `"for %I in ("${path}") do @echo %~sI"`],
          { encoding: "utf8", windowsVerbatimArguments: true },
        ).stdout.trim()
      try {
        const folder = join(sandbox, "data shell", "agy-hooks")
        mkdirSync(folder, { recursive: true })
        const short = shortOf(folder)
        const lower = (path: string) => path.replace(/^[A-Z]:/, (drive) => drive.toLowerCase())
        for (const given of [short, lower(short), lower(folder)])
          expect(addedOutside([`--add-dir=${given}`], sandbox), given).toEqual([])
        expect(
          addedOutside([`--add-dir=${lower(short)}`], join(sandbox, "data shell", "x")),
        ).toHaveLength(1)
        // A sandbox named by its short name, as a temporary folder may be, holds a folder in it
        // that isn't there yet, given by its long name.
        expect(addedOutside([`--add-dir=${join(sandbox, "not yet")}`], shortOf(sandbox))).toEqual(
          [],
        )
        expect(addedOutside([`--add-dir=${join(shortOf(sandbox), "not yet")}`], sandbox)).toEqual(
          [],
        )
      } finally {
        rmSync(sandbox, { recursive: true, force: true })
      }
    },
  )

  it("reads Claude Code's --settings, a file's or a JSON text's", () => {
    const folder = mkdtempSync(join(tmpdir(), "added-folders-"))
    try {
      const own = join(folder, "worktrees.json")
      const settings = (folders: readonly string[]): string =>
        JSON.stringify({ permissions: { additionalDirectories: folders } })
      writeFileSync(own, settings([outside, join(folder, "inside")]))
      expect(addedOutside(["--settings", own], folder)).toEqual([
        `with ${outside} in its --settings' additionalDirectories`,
      ])
      writeFileSync(own, settings([join(folder, "inside"), "rel"]))
      expect(addedOutside([`--settings=${own}`], folder)).toEqual([])
      expect(addedOutside(["--settings", settings([outside])], root)).toEqual([
        `with ${outside} in its --settings' additionalDirectories`,
      ])
      // The file's own place doesn't count.
      writeFileSync(own, settings([]))
      expect(addedOutside(["--settings", own], root)).toEqual([])
      // Settings that don't read can't be vouched for.
      const missing = join(folder, "missing.json")
      expect(addedOutside(["--settings", missing], folder)).toEqual([
        `with --settings ${missing}, which don't read`,
      ])
      expect(addedOutside(["--settings", "{not json"], root)).toEqual([
        "with --settings {not json, which don't read",
      ])
      expect(addedOutside(["--settings", JSON.stringify({ model: "x" })], root)).toEqual([])
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it("reads Codex's -c writable roots", () => {
    expect(addedOutside(["-c", rootsSetting([inside, outside])], root)).toEqual([
      `with ${outside} in its -c writable_roots`,
    ])
    expect(addedOutside(["-c", rootsSetting([inside, "rel"])], root)).toEqual([])
  })

  it("watches each harness's reports while it runs, and lets them go", () => {
    const original = harnesses.agy.decode
    const watching = watchAddedFolders(root)
    try {
      harnesses.agy.decode(
        hookReport("agy", "Stop", { conversationId: "c" }, { launch: [`--add-dir=${outside}`] }),
      )
      harnesses.claude.decode(
        hookReport("claude", "Stop", { session_id: "s" }, { launch: [`--add-dir=${inside}`] }),
      )
      const settings = JSON.stringify({ permissions: { additionalDirectories: [outside] } })
      harnesses.claude.decode(
        hookReport("claude", "Stop", { session_id: "s" }, { launch: ["--settings", settings] }),
      )
      harnesses.codex.decode(
        hookReport(
          "codex",
          "Stop",
          { session_id: "s" },
          { launch: ["-c", rootsSetting([outside])] },
        ),
      )
      expect(watching.outside()).toEqual([
        `agy was started with --add-dir ${outside}`,
        `claude was started with ${outside} in its --settings' additionalDirectories`,
        `codex was started with ${outside} in its -c writable_roots`,
      ])
    } finally {
      watching.stop()
    }
    expect(harnesses.agy.decode).toBe(original)
  })
})
