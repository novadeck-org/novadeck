import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"

import { describe, expect, it, vi } from "vitest"

const started: string[] = []
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>()
  return {
    ...original,
    execFile: ((program: string, ...rest: unknown[]) => {
      started.push(program)
      return (original.execFile as (...all: unknown[]) => unknown)(program, ...rest)
    }) as typeof original.execFile,
  }
})

const { gitLookups } = await import("./git-lookups.js")

describe("the git lookups' program", () => {
  it("starts git by an absolute path, never by its bare name, which Windows would look for in the agent's folder", async () => {
    const folder = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-git-program-")))
    try {
      await gitLookups.resolve(folder, "HEAD")
      await gitLookups.pushUrls(folder, "origin")
      expect(started).toHaveLength(2)
      for (const program of started) expect(isAbsolute(program)).toBe(true)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it("starts nothing where the PATH holds no git", async () => {
    const saved = process.env.PATH
    started.length = 0
    process.env.PATH = ""
    try {
      expect(await gitLookups.resolve(tmpdir(), "HEAD")).toBeUndefined()
      expect(await gitLookups.pushUrls(tmpdir(), "origin")).toBeUndefined()
      expect(started).toEqual([])
    } finally {
      process.env.PATH = saved
    }
  })
})
