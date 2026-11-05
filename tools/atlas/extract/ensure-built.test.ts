import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterAll, expect, test } from "vitest"

import { withLock } from "./ensure-built.ts"

const dir = mkdtempSync(join(tmpdir(), "atlas-lock-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// The pid of no process: past the largest a pid can be on Linux, macOS and Windows.
const gone = "4194304"

// Both start at a lock a process left behind, which only one of them may take over.
test("two processes take turns: one builds while the other waits", async () => {
  const lock = join(dir, "turns.lock")
  const log = join(dir, "turns.log")
  writeFileSync(lock, gone)
  const child = `
    import { appendFileSync } from "node:fs"
    import { withLock } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "ensure-built.ts")).href)}
    await withLock(${JSON.stringify(lock)}, () => {
      appendFileSync(${JSON.stringify(log)}, "start\\n")
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
      appendFileSync(${JSON.stringify(log)}, "end\\n")
    })
  `
  const run = () =>
    new Promise<number | null>((resolve) =>
      spawn(process.execPath, ["--input-type=module", "-e", child], { stdio: "inherit" }).on(
        "exit",
        resolve,
      ),
    )
  expect(await Promise.all([run(), run()])).toEqual([0, 0])
  expect(readFileSync(log, "utf8")).toBe("start\nend\nstart\nend\n")
  expect(existsSync(lock)).toBe(false)
}, 20_000)

test("takes over a lock its process left behind, and lets go when the build fails", async () => {
  const lock = join(dir, "left.lock")
  writeFileSync(lock, gone)
  await expect(
    withLock(lock, () => {
      throw new Error("build failed")
    }),
  ).rejects.toThrow("build failed")
  expect(existsSync(lock)).toBe(false)
})

test("gives up on a lock a running process holds", async () => {
  const lock = join(dir, "held.lock")
  writeFileSync(lock, String(process.pid))
  await expect(withLock(lock, () => {}, { wait: 300 })).rejects.toThrow("another build holds")
  expect(readFileSync(lock, "utf8")).toBe(String(process.pid))
})
