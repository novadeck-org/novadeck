import { execFile } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import { gitPath } from "../git.js"
import { describe, expect, it } from "../test.js"
import { folder } from "../testing/engines.js"
import { GitStates, parseStatus, readGitState, type GitState } from "./git-state.js"

const run = promisify(execFile)

describe("a checkout's git status", () => {
  it("reads commits ahead of its upstream, and any changed or untracked file", () => {
    expect(
      parseStatus(
        "# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n",
      ),
    ).toEqual({ ahead: 2, dirty: false })
    expect(
      parseStatus("# branch.head main\n1 .M N... 100644 100644 100644 a b src/a.ts\n"),
    ).toEqual({
      ahead: null,
      dirty: true,
    })
    expect(parseStatus("# branch.ab +0 -0\n? new.txt\n")).toEqual({ ahead: 0, dirty: true })
    // Output cut short has more than fit: changed for certain.
    expect(parseStatus("# branch.ab +0 -0\n", true)).toEqual({ ahead: 0, dirty: true })
  })

  it.skipIf(!gitPath())(
    "is read from a real repository, and is unknown outside one",
    async ({ resources }) => {
      const repo = await folder(resources)
      const git = (...args: string[]) =>
        run("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo })
      await git("init", "-q", "-b", "main")
      await writeFile(join(repo, "a.txt"), "a")
      await git("add", "a.txt")
      await git("commit", "-q", "-m", "a")
      expect(await readGitState(repo)).toEqual({ ahead: null, dirty: false })
      await writeFile(join(repo, "b.txt"), "b")
      expect(await readGitState(repo)).toEqual({ ahead: null, dirty: true })
      expect(await readGitState(await folder(resources))).toBeNull()
    },
  )
})

describe("checkouts' states as listings read them", () => {
  const clean: GitState = { ahead: 0, dirty: false }
  const changed: GitState = { ahead: 1, dirty: true }

  it("answer a state read moments ago at once, and read again once it is old", async () => {
    let time = 0
    const reads: string[] = []
    let next = clean
    const states = new GitStates(
      async (top) => {
        reads.push(top)
        return next
      },
      () => time,
      5_000,
    )
    expect(await states.of("/w")).toEqual(clean)
    next = changed
    time = 4_000
    expect(await states.of("/w")).toEqual(clean)
    expect(reads).toEqual(["/w"])
    // Old: the last state answers at once while it is read again.
    time = 6_000
    expect(await states.of("/w")).toEqual(clean)
    await Promise.resolve()
    await Promise.resolve()
    expect(reads).toEqual(["/w", "/w"])
    expect(await states.of("/w")).toEqual(changed)
  })

  it("wait only a moment for a checkout never read, unknown until its read ends", async () => {
    let finish: (state: GitState) => void = () => {}
    const states = new GitStates(() => new Promise((done) => (finish = done)), Date.now, 5_000, 10)
    expect(await states.of("/slow")).toBeNull()
    // One read at a time.
    expect(await states.of("/slow")).toBeNull()
    finish(changed)
    await new Promise((done) => setTimeout(done, 0))
    expect(await states.of("/slow")).toEqual(changed)
  })

  it("count a read that fails as unknown", async () => {
    const states = new GitStates(() => Promise.reject(new Error("no git")))
    expect(await states.of("/w")).toBeNull()
  })
})
