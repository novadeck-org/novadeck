import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach } from "vitest"

import { captureFolder } from "../shell/capture.js"
import { describe, expect, it } from "../test.js"
import { Captures, commandTexts, holds, matchCapture, readCaptures } from "./captures.js"

let temporary = ""
let folder = ""
beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), "novadeck-captures-"))
  folder = captureFolder("t1", temporary)
  await mkdir(folder, { recursive: true })
})
afterEach(async () => {
  await rm(temporary, { recursive: true, force: true })
})

const quoted = (command: string) => command.replaceAll("'", "'\\''")
// What Codex's shell snapshot gives a shell: a script that ends in the command's exec.
const wrapper = (command: string) =>
  `# Snapshot file\nexport PATH=/usr/bin\nunset -f foo\nexec '/bin/bash' -c '${quoted(command)}'\n`

// Writes a Linux or macOS capture whose record was written at `at`.
const posix = async (id: string, script: string, at: number, log = "out\n") => {
  await writeFile(join(folder, `out-${id}.command`), script)
  await writeFile(join(folder, `out-${id}.log`), log)
  await utimes(join(folder, `out-${id}.command`), at / 1000, at / 1000)
}
// Writes a Windows capture.
const windows = async (id: string, command: string, started: number) => {
  const commandLine = `-Command "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n${command.replaceAll('"', '\\"')}"`
  await writeFile(
    join(folder, `out-${id}.json`),
    JSON.stringify({
      commandLine,
      shell: "pwsh",
      folder,
      started,
      captured: true,
      exit: null,
    }),
  )
  await writeFile(join(folder, `out-${id}.log`), "")
}

const fast = { pollMs: 10, polls: 5 }
const log = (id: string) => join(folder, `out-${id}.log`)

describe("the texts a capture's record may hold a command in", () => {
  it("are the script as given, and the command out of Codex's wrapper with its quotes undone", () => {
    const command = `echo 'it''s' && echo "x"`
    expect(commandTexts(wrapper(command))).toContain(command)
    expect(commandTexts("sleep 5")).toEqual(["sleep 5"])
    expect(holds(commandTexts(wrapper("sleep 30 # it's")), "sleep 30 # it's")).toBe(true)
    expect(holds(commandTexts(wrapper("sleep 30")), "sleep 31")).toBe(false)
  })
})

describe("finding the capture of a shell", () => {
  it("matches a command run bare, and one run through the shell snapshot's wrapper", async () => {
    await posix("a", "npm run dev", 10_000)
    await posix("b", wrapper("python -m http.server 8000"), 10_050)
    const captures = await readCaptures(folder)
    const none = new Set<string>()
    expect(matchCapture(captures, "npm run dev", 10_000, none)?.log).toBe(log("a"))
    expect(matchCapture(captures, "python -m http.server 8000", 10_000, none)?.log).toBe(log("b"))
  })

  it("matches a Windows capture by its command line, with its quotes and start", async () => {
    await windows("w", 'node -e "setTimeout(()=>{},9e4)"', 50_000)
    const [capture] = await readCaptures(folder)
    expect(capture!.started).toBe(50_000)
    expect(
      matchCapture([capture!], 'node -e "setTimeout(()=>{},9e4)"', 50_500, new Set())?.log,
    ).toBe(log("w"))
    expect(matchCapture([capture!], "node other", 50_500, new Set())).toBeUndefined()
  })

  it("gives two identical commands each its own, the nearest in time first", async () => {
    await posix("a", "sleep 60", 10_000)
    await posix("b", "sleep 60", 12_000)
    const captures = await readCaptures(folder)
    const first = matchCapture(captures, "sleep 60", 11_800, new Set())
    expect(first?.log).toBe(log("b"))
    const second = matchCapture(captures, "sleep 60", 11_900, new Set([first!.log]))
    expect(second?.log).toBe(log("a"))
  })

  it("turns away a record started outside the window around the call", async () => {
    await posix("old", "sleep 60", 1_000)
    await posix("late", "sleep 60", 60_000)
    expect(matchCapture(await readCaptures(folder), "sleep 60", 30_000, new Set())).toBeUndefined()
  })

  it("waits for a record written after the rollout line", async () => {
    const captures = new Captures({ temporary, ...fast })
    const found: string[] = []
    const looking = captures.find(
      "t1",
      { command: "sleep 9", since: 5000 },
      () => new Set(),
      (path) => found.push(path),
    )
    await new Promise((resolve) => setTimeout(resolve, 25))
    await posix("late", "sleep 9", 5100)
    await looking
    expect(found).toEqual([log("late")])
  })

  it("finds nothing, and does not throw, where the folder is missing or nothing matches", async () => {
    const captures = new Captures({ temporary, ...fast })
    const found: string[] = []
    const take = (path: string) => found.push(path)
    await captures.find("nobody", { command: "x", since: 1 }, () => new Set(), take)
    await captures.find("t1", { command: "x", since: 1 }, () => new Set(), take)
    expect(found).toEqual([])
  })

  it("does not give two simultaneous looks the same record", async () => {
    await posix("a", "sleep 60", 10_000)
    const captures = new Captures({ temporary, ...fast })
    const found: string[] = []
    const one = captures.find(
      "t1",
      { command: "sleep 60", since: 10_000 },
      () => new Set(),
      (p) => found.push(p),
    )
    const two = captures.find(
      "t1",
      { command: "sleep 60", since: 10_000 },
      () => new Set(found),
      (p) => found.push(p),
    )
    await Promise.all([one, two])
    expect(found).toEqual([log("a")])
  })
})

describe("clearing captures", () => {
  const long = (id: string, ago: number) =>
    utimes(log(id), (Date.now() - ago) / 1000, (Date.now() - ago) / 1000)

  it("removes those no shell uses that have not changed for a while, and keeps the rest", async () => {
    const now = Date.now()
    await posix("claimed", "a", now - 600_000)
    await posix("stale", "b", now - 600_000)
    await posix("fresh", "c", now)
    await posix("busy", "d", now - 600_000)
    await long("claimed", 600_000)
    await long("stale", 600_000)
    await long("busy", 1000)
    const captures = new Captures({ temporary, idleMs: 120_000 })
    await captures.tend("t1", new Set([log("claimed")]), now)
    expect(existsSync(log("claimed"))).toBe(true)
    expect(existsSync(log("stale"))).toBe(false)
    expect(existsSync(join(folder, "out-stale.command"))).toBe(false)
    expect(existsSync(log("fresh"))).toBe(true)
    // Its command's record is old but its log is still written to.
    expect(existsSync(log("busy"))).toBe(true)
  })

  it("looks at a terminal's folder only every so often", async () => {
    const now = Date.now()
    const captures = new Captures({ temporary, idleMs: 0, sweepMs: 30_000 })
    await captures.tend("t1", new Set(), now)
    await posix("later", "a", now - 1000)
    await captures.tend("t1", new Set(), now + 1000)
    expect(existsSync(log("later"))).toBe(true)
    await captures.tend("t1", new Set(), now + 31_000)
    expect(existsSync(log("later"))).toBe(false)
  })

  it("removes the whole folder when its terminal closes, and none is a failure", async () => {
    await posix("a", "a", Date.now())
    const captures = new Captures({ temporary })
    await captures.closed("t1")
    expect(existsSync(folder)).toBe(false)
    await expect(captures.closed("t1")).resolves.toBeUndefined()
  })
})
