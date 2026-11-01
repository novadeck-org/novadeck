import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { matchCall, type GrantScope } from "@novadeck/harness-core/grants"
import { describe, expect, it } from "vitest"

import { fsLookups } from "./fs-lookups.js"
import { gitLookups } from "./git-lookups.js"

const scope: GrantScope = {
  presets: ["pr"],
  commands: [],
  repos: [{ url: "github.com/acme/app", defaultBranch: "main" }],
}

const folder = (): { root: string; outside: string; done: () => void } => {
  // The real long path: a Windows runner's temp folder is an 8.3 name (`RUNNER~1`), which the
  // dialect refuses for its `~`.
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-fs-lookups-")))
  const root = join(base, "project")
  const outside = join(base, "outside")
  mkdirSync(root)
  mkdirSync(outside)
  return { root, outside, done: () => rmSync(base, { recursive: true, force: true }) }
}

// Windows makes a symlink only for a user allowed to; without that the test has nothing to read.
const makeLink = (target: string, path: string, skip: (reason: string) => never): void => {
  try {
    symlinkSync(target, path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") skip("this user may not create symlinks")
    throw error
  }
}

describe("the disk lookups", () => {
  it("tell a regular file from a directory, and follow a symlink to its real path", async ({
    skip,
  }) => {
    const { root, outside, done } = folder()
    try {
      writeFileSync(join(outside, "secret.md"), "x")
      writeFileSync(join(root, "note.md"), "x")
      makeLink(join(outside, "secret.md"), join(root, "link.md"), skip)
      expect((await fsLookups.real(join(root, "note.md")))?.file).toBe(true)
      expect((await fsLookups.real(root))?.file).toBe(false)
      const link = await fsLookups.real(join(root, "link.md"))
      expect(link?.file).toBe(true)
      expect(link?.path.startsWith(root)).toBe(false)
      expect(link?.path.endsWith("secret.md")).toBe(true)
      expect(await fsLookups.real(join(root, "missing.md"))).toBeUndefined()
      expect(await fsLookups.names(root)).toEqual(["link.md", "note.md"])
      expect(await fsLookups.names(join(root, "missing"))).toEqual([])
      expect(await fsLookups.names(join(root, "note.md"))).toEqual([])
    } finally {
      done()
    }
  })

  it("read what Codex's rollout records of a call: its workdir and its turn's mode, and read no other file", async () => {
    const { root, done } = folder()
    try {
      const line = (id: string, cmd: string, workdir: string) =>
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({ cmd, workdir }),
            call_id: id,
            internal_chat_message_metadata_passthrough: { turn_id: "t-1" },
          },
        })
      const started = JSON.stringify({
        type: "event_msg",
        payload: { type: "task_started", turn_id: "t-1", collaboration_mode_kind: "default" },
      })
      const body = `${started}\n${line("a", "git status", "/w/a")}\n${line("b", "touch x", "/w/b")}\n`
      const rollout = join(root, "rollout-2026-11-01T20-34-16-abc.jsonl")
      writeFileSync(rollout, body)
      writeFileSync(join(root, "notes.jsonl"), body)
      expect(await fsLookups.codexCall({ path: rollout, turn: "t-1" }, "touch x")).toEqual({
        workdir: "/w/b",
        planning: false,
      })
      // The older call isn't the newest, and another turn has no mode on disk.
      expect(await fsLookups.codexCall({ path: rollout, turn: "t-1" }, "git status")).toMatchObject(
        {
          workdir: undefined,
        },
      )
      expect(await fsLookups.codexCall({ path: rollout, turn: "t-2" }, "touch x")).toEqual({
        workdir: undefined,
        planning: undefined,
      })
      expect(
        await fsLookups.codexCall({ path: join(root, "notes.jsonl"), turn: "t-1" }, "touch x"),
      ).toBeUndefined()
      expect(
        await fsLookups.codexCall(
          { path: join(root, "rollout-gone.jsonl"), turn: "t-1" },
          "touch x",
        ),
      ).toBeUndefined()
    } finally {
      done()
    }
  })

  it("keep a pull request's body file from being a symlink inside the project that points outside", async ({
    skip,
  }) => {
    const { root, outside, done } = folder()
    try {
      writeFileSync(join(outside, "secret.md"), "x")
      writeFileSync(join(root, "note.md"), "x")
      makeLink(join(outside, "secret.md"), join(root, "link.md"), skip)
      const ask = (file: string) =>
        matchCall(
          {
            command: `gh pr comment 5 -R acme/app --body-file ${join(root, file)}`,
            cwd: null,
            // Windows paths have backslashes, which only its dialect reads whole.
            ...(process.platform === "win32" && { dialect: "windows-quote-free" as const }),
          },
          [scope],
          gitLookups,
          root,
          fsLookups,
        )
      expect(await ask("note.md")).not.toBeNull()
      expect(await ask("link.md")).toBeNull()
      expect(await ask("missing.md")).toBeNull()
    } finally {
      done()
    }
  })
})
