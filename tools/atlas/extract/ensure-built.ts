import { execFileSync } from "node:child_process"
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

// The newest change to the source a build compiles; tests are excluded from every build.
const newest = (dir: string): number =>
  readdirSync(dir, { withFileTypes: true }).reduce((latest, entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return Math.max(latest, newest(path))
    return entry.name.endsWith(".test.ts") ? latest : Math.max(latest, statSync(path).mtimeMs)
  }, 0)

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Whether the process that wrote a lock is still running.
const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it runs, as another user.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

// Whether creating a lock failed because another holds it. On Windows a lock just deleted
// can still be pending deletion, which reads as EPERM until its last handle closes.
const held = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code
  return (
    code === "EEXIST" || (process.platform === "win32" && (code === "EPERM" || code === "EACCES"))
  )
}

// Removes a lock its holder left behind, only while it still reads `seen`: two waiters can
// find the same dead lock, and the second must not delete the lock the first took after.
// Only one waiter at a time takes over, behind a second lock of its own.
const takeOver = (file: string, seen: string): void => {
  const guard = `${file}.takeover`
  try {
    closeSync(openSync(guard, "wx"))
  } catch (error) {
    if (!held(error)) throw error
    // A takeover is a read and a delete; one older than that died on the way.
    const age = Date.now() - (statSync(guard, { throwIfNoEntry: false })?.mtimeMs ?? Date.now())
    if (age > 10_000) rmSync(guard, { force: true })
    return
  }
  try {
    if (readFileSync(file, "utf8") === seen) rmSync(file, { force: true })
  } catch {
    // released meanwhile
  } finally {
    rmSync(guard, { force: true })
  }
}

// Runs `run` holding `file` as a lock, so two briefs at once (two agents, or a brief beside
// `check`) don't both build into the same `dist`, nor one load it while the other writes.
// A lock whose process is gone is taken over, and so is one older than any build takes (its
// pid may be another process's by now). Waits two minutes at most.
export const withLock = async (
  file: string,
  run: () => void | Promise<void>,
  { wait = 120_000, stale = 600_000 } = {},
): Promise<void> => {
  mkdirSync(dirname(file), { recursive: true })
  const deadline = Date.now() + wait
  for (;;) {
    try {
      const fd = openSync(file, "wx")
      writeSync(fd, String(process.pid))
      closeSync(fd)
      break
    } catch (error) {
      if (!held(error)) throw error
    }
    let seen = ""
    let age = 0
    try {
      seen = readFileSync(file, "utf8")
      age = Date.now() - statSync(file).mtimeMs
    } catch {
      continue // released between the open and the read
    }
    const holder = Number(seen)
    // An empty lock is one being written: its writer runs.
    if ((Number.isInteger(holder) && holder > 0 && !running(holder)) || age > stale) {
      takeOver(file, seen)
      continue
    }
    if (Date.now() > deadline)
      throw new Error(`atlas: another build holds ${file}; delete it if no build is running`)
    sleep(100)
  }
  try {
    await run()
  } finally {
    rmSync(file, { force: true })
  }
}

// The extractor reads the contract from the built protocol package, which reads the built
// wire and terminal libraries, and terminal the emulator; build each, the libraries first,
// when it is missing or older than its source. It runs the package's main build,
// `tsc -p tsconfig.build.json`, with the TypeScript the package resolves, through Node: not
// through pnpm, which may first run an install, and which is a different executable on
// Windows. For terminal that is the first of its build's three steps (the view build and the
// copied test child follow it); the extractor needs only the main entry. The build's own
// output goes to stderr, so a failing build explains itself and stdout stays the caller's.
// A turbo build of the same packages beside it is outside the lock.
export const ensureBuilt = (repo: string): Promise<void> =>
  withLock(join(repo, "node_modules", ".atlas-build.lock"), async () => {
    let rebuilt = false
    // Each with a file its build writes: the emulator has no index, only its subpaths.
    for (const [name, folder, output] of [
      ["@novadeck/wire", "libraries/wire", "dist/index.js"],
      ["@novadeck/emulator", "libraries/emulator", "dist/screen.js"],
      ["@novadeck/terminal", "libraries/terminal", "dist/index.js"],
      ["@novadeck/protocol", "contract/protocol", "dist/index.js"],
    ] as const) {
      const root = join(repo, folder)
      const built = join(root, output)
      if (!rebuilt && existsSync(built) && statSync(built).mtimeMs >= newest(join(root, "src")))
        continue
      // What comes after a rebuilt package is rebuilt too, as it may depend on the one before.
      rebuilt = true
      process.stderr.write(`atlas: building ${name}…\n`)
      const typescript = createRequire(join(root, "package.json")).resolve(
        "typescript/package.json",
      )
      const tsc = join(dirname(typescript), "bin/tsc")
      // `--noEmitOnError`: a failed build leaves the old output stale, so the next call
      // rebuilds and fails again, instead of finding fresh output built from broken source.
      execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json", "--noEmitOnError"], {
        cwd: root,
        stdio: ["ignore", 2, 2],
      })
    }
    // Loaded while the lock is held, so no other brief rebuilds it under this one; the
    // extractors' own imports of it then come from Node's module cache.
    await import("@novadeck/protocol")
  })
