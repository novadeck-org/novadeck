import type { Report } from "@novadeck/harness-core/report"
import { hookReport } from "@novadeck/harness-core/testing/reports"
import { describe, expect, it } from "vitest"

import { decode } from "./decode.js"

// What a hook tells of its conversation's folder, from its `workspacePaths` and the words its
// process was started with (`Report.launch`).
const observed = (workspacePaths: unknown, launch?: readonly string[]) =>
  decode(
    hookReport(
      "agy",
      "PreInvocation",
      { conversationId: "c", invocationNum: 0, workspacePaths },
      launch === undefined ? {} : { launch },
    ),
  ).find(({ type }) => type === "session-observed")

const cwdOf = (workspacePaths: unknown, launch?: readonly string[]) => {
  const fact = observed(workspacePaths, launch)
  return fact && "cwd" in fact ? fact.cwd : undefined
}

const root = "/home/a/.novadeck/worktrees"
const tour = "/home/a/.novadeck/tour"

describe("an Antigravity conversation's folder, from its hooks", () => {
  it("is its lone workspace", () => {
    expect(cwdOf([tour])).toBe(tour)
    expect(cwdOf([tour], ["--model", "m"])).toBe(tour)
  })

  it("leaves out the folder of agents' worktrees its shim added, wherever 1.5.9 lists it", () => {
    // As probed 2026-11-17: its hooks name the added folder beside its own, in order of path,
    // so ahead of a project in the home.
    const project = "/home/a/Workspace/app"
    expect(cwdOf([root, project], [`--add-dir=${root}`, "--settings", "/s.json"])).toBe(project)
    expect(cwdOf([root, project], ["--add-dir", root])).toBe(project)
    expect(cwdOf([tour, root], [`--add-dir=${root}`])).toBe(tour)
    // The same on Windows, where the paths may differ in case and separators.
    expect(
      cwdOf(
        ["C:\\Users\\a\\.novadeck\\worktrees", "C:\\Users\\a\\.novadeck\\tour"],
        ["--add-dir=c:/users/a/.novadeck/worktrees"],
      ),
    ).toBe("C:\\Users\\a\\.novadeck\\tour")
  })

  it("claims none where only the added folder is listed, as when it works inside that folder", () => {
    // In a worktree below the folder of agents' worktrees, or in that folder itself: which,
    // its hooks may not tell, and its status line does.
    expect(cwdOf([root], [`--add-dir=${root}`])).toBeUndefined()
    // Given with a trailing separator, the folder is still the one listed.
    expect(cwdOf([root, tour], [`--add-dir=${root}/`])).toBe(tour)
  })

  it("claims none where several remain, nor where the words its process started with are unknown", () => {
    // The person's own several workspaces: which is its own, its hooks don't tell.
    expect(cwdOf(["/w/a", "/w/b"], [])).toBeUndefined()
    expect(cwdOf([root, tour])).toBeUndefined()
    expect(cwdOf([root, "/w/a", "/w/b"], [`--add-dir=${root}`])).toBeUndefined()
    expect(observed([root, tour])).toMatchObject({ type: "session-observed", sessionId: "c" })
  })

  it("names no folder for a command that names none of its own, where its workspace is unclear", () => {
    const ran = (workspacePaths: unknown, launch?: readonly string[]) =>
      decode(
        hookReport(
          "agy",
          "PreToolUse",
          {
            conversationId: "c",
            workspacePaths,
            toolCall: { name: "run_command", args: { CommandLine: "npm test" } },
          },
          launch === undefined ? {} : ({ launch } satisfies Partial<Report>),
        ),
      ).find(({ type }) => type === "tool-called")
    expect(ran([root, tour], [`--add-dir=${root}`])).toMatchObject({ folder: tour })
    expect(ran([root, tour])).not.toHaveProperty("folder")
  })
})
