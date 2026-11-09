import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { setTimeout as sleep } from "node:timers/promises"

// Electron 45 has no postinstall: the binary downloads the first time something loads the
// `electron` package. Each test file that does loads it in its own worker, so on a fresh
// install several workers raced to download and unpack one binary into one folder, and a
// file failed with "Electron failed to install correctly" (#784). It's fetched here once,
// before any worker starts, and a failed download from GitHub (a 504 on 2026-11-08) is
// tried again before the tests give up. Its own install script returns at once when the
// binary is already there.
const waits = [0, 10_000, 30_000]

export default async function setup(): Promise<void> {
  const install = createRequire(import.meta.url).resolve("electron/install.js")
  let output = ""
  for (const wait of waits) {
    // eslint-disable-next-line no-await-in-loop -- Each try waits for the one before it.
    await sleep(wait)
    const result = spawnSync(process.execPath, [install], { encoding: "utf8" })
    if (result.status === 0) return
    output = `${result.stdout}${result.stderr}${result.error?.message ?? ""}`
  }
  throw new Error(`Electron's binary didn't install after ${waits.length} tries:\n${output}`)
}
