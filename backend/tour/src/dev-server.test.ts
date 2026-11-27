import { execFileSync, spawn } from "node:child_process"
import { copyFile, mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { repositoryAssets } from "./seed.js"
import { freePort, versionOf } from "./serving.js"
import { describe, expect, findProgram, it, type Resources } from "./test.js"

// The seed's own dev servers, run for real against a small repository with worktrees: which
// copy of a file the page gets. Both servers answer the same, so each case runs on both.

const git = (folder: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-C", folder, "-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim()

// Python 3 as this computer has it, or none: the Python server's cases are skipped without it.
const python = async (): Promise<string | undefined> => {
  for (const program of ["python3", "python"]) {
    // eslint-disable-next-line no-await-in-loop -- Tried in turn: the first that runs wins.
    if ((await versionOf(findProgram)(program))?.startsWith("Python 3."))
      return findProgram(program, { env: process.env, extensions: [".exe"] })
  }
  return undefined
}

// Git spawned many times over is slow on Windows.
const patient = 120_000

for (const kind of ["node", "python"] as const) {
  describe(`the seed's dev server on ${kind}`, () => {
    // A project as the tour leaves it: committed, with the dev servers in it, served from a
    // free port. `put` writes a file with a time of its own, each later than any before and
    // than the files git writes, so "changed last" never rests on how fast the test ran.
    const served = async (resources: Resources, slowName = false) => {
      const program = kind === "node" ? process.execPath : await python()
      if (program === undefined) return undefined
      const root = await realpath(await mkdtemp(join(tmpdir(), "novadeck-dev-server-")))
      resources.defer(() => rm(root, { recursive: true, force: true }))
      const home = join(root, "game")
      const { seed } = await repositoryAssets()
      await mkdir(join(home, "src"), { recursive: true })
      for (const file of ["dev.mjs", "dev.py", ".gitattributes"])
        // eslint-disable-next-line no-await-in-loop -- Three small files.
        await copyFile(join(seed, file), join(home, file))
      let clock = Date.now() / 1000 + 1000
      const put = async (folder: string, name: string, text: string) => {
        await mkdir(join(folder, name, ".."), { recursive: true })
        await writeFile(join(folder, name), text)
        clock += 10
        await utimes(join(folder, name), clock, clock)
      }
      await put(home, "src/a.js", "a: committed\n")
      await put(home, "src/b.js", "b: committed\n")
      await put(home, ".gitignore", "build/\n")
      git(home, "init", "-q", "-b", "main")
      git(home, "add", "-A")
      git(home, "commit", "-q", "-m", "A project")
      const worktree = (name: string) => {
        const folder = join(root, name)
        git(home, "worktree", "add", "-q", "-b", name, folder)
        return folder
      }
      // A computer slow to name itself, as some are (seconds, on a Mac): Python's own server
      // asks for that name between taking its port and listening on it.
      const slow = join(root, "slow-name")
      if (slowName && kind === "python") {
        await mkdir(slow)
        await writeFile(
          join(slow, "sitecustomize.py"),
          [
            "import socket, time",
            "named = socket.getfqdn",
            "def slowly(name=''):",
            "    time.sleep(3)",
            "    return named(name)",
            "socket.getfqdn = slowly",
            "",
          ].join("\n"),
        )
      }
      const port = await freePort()
      const child = spawn(program, [kind === "node" ? "dev.mjs" : "dev.py", String(port)], {
        cwd: home,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        ...(slowName && kind === "python" && { env: { ...process.env, PYTHONPATH: slow } }),
      })
      resources.defer(
        () =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null) return resolve()
            child.once("exit", () => resolve())
            child.kill()
          }),
      )
      // What the server said, and how it ended: told with a request it didn't answer, as such
      // a failure may show on one kind of computer only.
      let said = ""
      let ended: string | undefined
      child.stdout.on("data", (chunk: Buffer) => (said += String(chunk)))
      child.stderr.on("data", (chunk: Buffer) => (said += String(chunk)))
      child.once("exit", (code, signal) => (ended = `ended (${code ?? signal})`))
      await new Promise<void>((resolve, reject) => {
        child.stdout.on("data", () => {
          if (said.includes("The game is at")) resolve()
        })
        child.once("exit", (code) => reject(new Error(`The dev server ended (${code}): ${said}`)))
      })
      const get = async (path: string) => {
        const answer = await fetch(`http://127.0.0.1:${port}/${path}`).catch((error: unknown) => {
          throw new Error(
            `No answer for ${path}: the dev server ${ended ?? "still runs"}, and said: ${said}`,
            { cause: error },
          )
        })
        return answer.ok ? answer.text() : `${answer.status}`
      }
      return { home, put, worktree, get }
    }

    it(
      "answers from the moment it says where it is, however slow the computer is to name itself",
      async ({ resources, skip }) => {
        const run = await served(resources, true)
        if (!run) return skip("No Python 3 here.")
        expect(await run.get("src/a.js")).toBe("a: committed\n")
      },
      patient,
    )

    it(
      "serves this folder's own change where no worktree touched the file",
      async ({ resources, skip }) => {
        const run = await served(resources)
        if (!run) return skip("No Python 3 here.")
        // Two worktrees made before the folder moves on: their copies are the committed ones.
        run.worktree("one")
        run.worktree("two")
        await run.put(run.home, "src/a.js", "a: this folder's\n")
        expect(await run.get("src/a.js")).toBe("a: this folder's\n")
        // And where the folder's change is committed, which their copies then lag behind.
        git(run.home, "commit", "-q", "-am", "Moves on")
        expect(await run.get("src/a.js")).toBe("a: this folder's\n")
        expect(await run.get("src/b.js")).toBe("b: committed\n")
      },
      patient,
    )

    it(
      "serves a worktree's change and its new file, committed there or not, the newest first",
      async ({ resources, skip }) => {
        const run = await served(resources)
        if (!run) return skip("No Python 3 here.")
        const one = run.worktree("one")
        const two = run.worktree("two")
        await run.put(one, "src/b.js", "b: one's\n")
        await run.put(one, "src/new.js", "new: one's\n")
        expect(await run.get("src/b.js")).toBe("b: one's\n")
        expect(await run.get("src/new.js")).toBe("new: one's\n")
        expect(await run.get("src/a.js")).toBe("a: committed\n")
        // Committed in its worktree, it is still that worktree's work, not this folder's.
        git(one, "add", "-A")
        git(one, "commit", "-q", "-m", "One's work")
        expect(await run.get("src/b.js")).toBe("b: one's\n")
        expect(await run.get("src/new.js")).toBe("new: one's\n")
        // Another worktree changes the same file later: the page shows the one changed last.
        await run.put(two, "src/b.js", "b: two's\n")
        expect(await run.get("src/b.js")).toBe("b: two's\n")
        // As it does where this folder changes it last, too.
        await run.put(run.home, "src/b.js", "b: this folder's\n")
        expect(await run.get("src/b.js")).toBe("b: this folder's\n")
      },
      patient,
    )

    it(
      "serves a file git ignores from the folder that has it, the newest first",
      async ({ resources, skip }) => {
        const run = await served(resources)
        if (!run) return skip("No Python 3 here.")
        // What a build wrote in a worktree: git carries it nowhere, so it is that worktree's own.
        const one = run.worktree("one")
        await run.put(one, "build/out.js", "out: one's\n")
        expect(await run.get("build/out.js")).toBe("out: one's\n")
        await run.put(run.home, "build/out.js", "out: this folder's\n")
        expect(await run.get("build/out.js")).toBe("out: this folder's\n")
      },
      patient,
    )

    it(
      "serves a worktree's new file beside more untracked files than a megabyte names",
      async ({ resources, skip }) => {
        // Paths this long don't fit a Windows folder.
        if (process.platform === "win32") return skip("Paths too long for Windows.")
        const run = await served(resources)
        if (!run) return skip("No Python 3 here.")
        // Installed packages nobody told git to ignore, say: 2000 names of some 620 letters.
        const one = run.worktree("one")
        const deep = join(one, "deps", "d".repeat(200), "e".repeat(200), "f".repeat(200))
        await mkdir(deep, { recursive: true })
        await Promise.all(
          Array.from({ length: 2000 }, (_, at) => writeFile(join(deep, `${at}.txt`), "")),
        )
        await run.put(one, "src/new.js", "new: one's\n")
        expect(await run.get("src/new.js")).toBe("new: one's\n")
      },
      patient,
    )

    it(
      "serves this folder's copy again once it holds a worktree's work",
      async ({ resources, skip }) => {
        const run = await served(resources)
        if (!run) return skip("No Python 3 here.")
        const one = run.worktree("one")
        await run.put(one, "src/b.js", "b: one's\n")
        git(one, "commit", "-q", "-am", "One's work")
        git(run.home, "merge", "-q", "one")
        // Merged, the file is this folder's to change: the worktree's copy is no newer work.
        await run.put(run.home, "src/b.js", "b: this folder's, after the merge\n")
        expect(await run.get("src/b.js")).toBe("b: this folder's, after the merge\n")
        expect(await run.get("src/missing.js")).toBe("404")
      },
      patient,
    )
  })
}
