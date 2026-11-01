import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createHarnesses } from "../harnesses/service.js"
import { savePlan } from "./content.js"
import { planSaveFolders } from "./plan-folders.js"
import type { ItemRecord } from "./records.js"

const roots: string[] = []
const root = (): string => {
  const made = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-plan-folders-")))
  roots.push(made)
  return made
}
afterEach(() => {
  for (const made of roots.splice(0)) rmSync(made, { recursive: true, force: true })
})

const itemOf = (agent: "claude" | "agy", path: string): ItemRecord =>
  ({
    sessionId: "s",
    terminalId: null,
    from: { terminalId: "t", handle: "moth" },
    path,
    plan: { agent, session: "a", actor: null, format: "file" },
  }) as ItemRecord

const write = (path: string): string => {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, "# Plan\n")
  return path
}

// The runner as wired, but for the project and terminal: the real harness service, with
// no shell files yet (as just after the start) or with them.
const wired = (
  home: string,
  place: Parameters<typeof planSaveFolders>[1]["place"] = () => undefined,
) => {
  const agents = createHarnesses(() => Promise.resolve(undefined), {
    home,
    env: { HOME: home },
    login: false,
  })
  return (item: ItemRecord, project?: string) =>
    planSaveFolders(item, {
      projectFolder: () => project,
      place,
      planFolders: (agent) => agents.planFolders(agent),
    })
}

const saves = async (item: ItemRecord, folders: readonly string[]) =>
  savePlan(item, "# Edited\n", "", folders).then(
    () => "saved",
    (error: { data?: { reason?: string } }) => error.data?.reason ?? "failed",
  )

describe("the folders a plan may be saved under", () => {
  it("let Claude Code's default plans and Antigravity's through, before the shell files are known", async () => {
    const home = root()
    const folders = wired(home)
    const claude = itemOf("claude", write(join(home, ".claude", "plans", "x.md")))
    const agy = itemOf(
      "agy",
      write(join(home, ".gemini", "antigravity-cli", "brain", "id", "plan.md")),
    )
    // Stale stamps: the save is judged on its folder first, and then on the file.
    expect(await saves(claude, await folders(claude))).not.toBe("outside")
    expect(await saves(agy, await folders(agy))).not.toBe("outside")
    const stray = itemOf("claude", write(join(home, "elsewhere", "x.md")))
    expect(await saves(stray, await folders(stray))).toBe("outside")
  })

  it("add the project, the terminal's folder and its session's own home", async () => {
    const home = root()
    const project = join(home, "shop")
    const sibling = join(home, "shop-worktree")
    const second = join(home, ".claude-work")
    const folders = wired(home, () => ({
      terminalId: "t",
      sessionId: "s",
      handle: "moth",
      cwd: sibling,
      project,
      transcript: join(second, "projects", "-shop", "abc.jsonl"),
    }))
    const inSibling = itemOf("claude", write(join(sibling, ".claude", "plans", "x.md")))
    const inSecond = itemOf("claude", write(join(second, "plans", "x.md")))
    const inProject = itemOf("claude", write(join(project, "plan.md")))
    for (const item of [inSibling, inSecond, inProject])
      // eslint-disable-next-line no-await-in-loop -- Each step waits for the one before.
      expect(await saves(item, await folders(item, project))).not.toBe("outside")
    const stray = itemOf("claude", write(join(home, "elsewhere", "x.md")))
    expect(await saves(stray, await folders(stray, project))).toBe("outside")
  })

  it("leave out a filesystem root", async () => {
    const folders = wired(root(), () => ({
      terminalId: "t",
      sessionId: "s",
      handle: "moth",
      cwd: "/",
      project: undefined,
    }))
    expect(await folders(itemOf("claude", "/x.md"))).not.toContain("/")
  })
})
