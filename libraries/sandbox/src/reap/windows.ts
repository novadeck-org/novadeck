import { execFile } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { pidRunning, waitWhile, type Process, type Scope, type Table } from "./process.js"

/**
 * A process of a tree on Windows: its pid and its start, which together name it alone.
 * The shape `@novadeck/terminal/pty`'s tree reader gives.
 */
export type Member = { readonly pid: number; readonly startedAt: number }

/**
 * How a process's tree is read and ended on Windows, where a recorded parent pid may name an
 * unrelated process that an ended parent's pid was given to: a reader that counts a process
 * as a child only if it started no earlier than its parent, and ends each only as the
 * process it was read as.
 */
export type Trees = {
  /** The process and every one under it, root first; undefined where it can't be read. */
  readonly read: (pid: number) => Promise<readonly Member[] | undefined>
  /** Ends each of them that is still the process read. */
  readonly end: (members: readonly Member[]) => Promise<void>
}

const systemRoot = (): string => process.env.SystemRoot ?? "C:\\Windows"

// The lister (lister.cs), compiled once by its source into the system's temporary folder,
// with the C# compiler every Windows has in its .NET Framework: one quick process a
// listing, where starting PowerShell for each took most of a minute's test on a CI runner.
// Each compiled program is named by its own hash too, checked before it is run: one there
// that isn't what its name says, as a half-written one, is passed over, and a run that
// compiles another, as two at once may, never makes one already there wrong.
const source = readFileSync(new URL("lister.cs", import.meta.url), "utf8")
const listerName = `sandbox-reap-${createHash("sha256").update(source).digest("hex").slice(0, 16)}`

const hashOf = (file: string): string =>
  createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16)

// A program of this source there, as its name says, if any.
const intact = (): string | undefined => {
  const named = new RegExp(`^${listerName}-([0-9a-f]{16})\\.exe$`)
  for (const name of readdirSync(tmpdir())) {
    const hash = named.exec(name)?.[1]
    if (!hash) continue
    try {
      if (hashOf(join(tmpdir(), name)) === hash) return join(tmpdir(), name)
    } catch {
      // Gone meanwhile, or not readable: another.
    }
  }
  return undefined
}

// Removes the listers of other sources, as earlier versions of this one compiled: a run of
// one may still use it, which leaves it there.
const sweep = (): void => {
  const others = /^sandbox-reap-[0-9a-f]{16}(-[0-9a-f]{16})?\.exe$/
  for (const name of readdirSync(tmpdir()))
    if (others.test(name) && !name.startsWith(`${listerName}-`))
      try {
        rmSync(join(tmpdir(), name), { force: true })
      } catch {
        // In use.
      }
}

// Why the lister can't be run, with what usually causes it on a developer's machine: a
// program that reads every process's memory is what an antivirus quarantines.
const blocked = (program: string, cause: unknown): Error =>
  new Error(
    `The sandbox's process lister (${program}) could not run: ${
      cause instanceof Error ? cause.message : String(cause)
    }. Windows Defender or another antivirus may have quarantined it, as it reads other processes' memory; allow it, or exclude ${join(tmpdir(), "sandbox-reap-*.exe")}, and run again.`,
    { cause },
  )

let compiled: Promise<string> | undefined
const compiledLister = (): Promise<string> =>
  (compiled ??= (async () => {
    const there = intact()
    if (there) return there
    const csc = join(systemRoot(), "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe")
    const staging = join(tmpdir(), `${listerName}.${randomBytes(6).toString("hex")}`)
    writeFileSync(`${staging}.cs`, source)
    try {
      await promisify(execFile)(
        csc,
        ["/nologo", "/target:exe", "/optimize", `/out:${staging}.exe`, `${staging}.cs`],
        { windowsHide: true, timeout: 120_000 },
      )
      const program = join(tmpdir(), `${listerName}-${hashOf(`${staging}.exe`)}.exe`)
      renameSync(`${staging}.exe`, program)
      sweep()
      return program
    } catch (cause) {
      compiled = undefined
      throw blocked(join(tmpdir(), `${listerName}-*.exe`), cause)
    } finally {
      rmSync(`${staging}.cs`, { force: true })
      rmSync(`${staging}.exe`, { force: true })
    }
  })())

/** The sandbox's processes, as the lister finds them, each with how its recorded parent stands. */
export const list = async (sandbox: Scope): Promise<readonly Process[]> => {
  const program = await compiledLister()
  let stdout: string
  try {
    ;({ stdout } = await promisify(execFile)(
      program,
      [String(sandbox.started), sandbox.root, sandbox.home, String(process.pid)],
      { windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
    ))
  } catch (cause) {
    // One removed or changed since is compiled again next time; one still there, as one an
    // antivirus blocks but leaves, is tried again, and fails the same way, naming it.
    compiled = undefined
    throw blocked(program, cause)
  }
  const rows = JSON.parse(stdout) as {
    readonly pid: number
    readonly comm: string
    readonly start: number
    readonly parent: string
  }[]
  return rows.map(({ pid, comm, start, parent }) => ({ pid, comm, start, stopped: false, parent }))
}

/**
 * Ends a Windows process and every program it started, with taskkill: by recorded parent
 * pids, which may name an unrelated process whose pid an ended parent left.
 */
const taskkillTree = async (pid: number): Promise<void> => {
  await promisify(execFile)(
    join(systemRoot(), "System32", "taskkill.exe"),
    ["/T", "/F", "/PID", String(pid)],
    { windowsHide: true, timeout: 5_000 },
  )
}

/**
 * Ends a Windows process and what it started (see `endProcess`): the tree `trees` reads,
 * only should its root still be the process found, by its start, and waited for, so nothing
 * of it holds the sandbox's files once `reap` returns; where it can't be read, the tree
 * `kill` ends by recorded parent pids, taskkill unless a test gives another. Exported for
 * its tests, as no process on Windows outlives the first ask long enough to reach it there.
 */
export const endTree = async (
  one: { readonly pid: number; readonly start: number },
  trees: Trees,
  kill: (pid: number) => Promise<void> = taskkillTree,
): Promise<void> => {
  const tree = await trees.read(one.pid)
  // Where it can't be read, the tree is ended by recorded parents, awaited: only the root is
  // checked, just before, by its start.
  if (tree === undefined) return kill(one.pid).catch(() => {})
  if (tree[0]?.startedAt !== one.start) return
  await trees.end(tree)
  await waitWhile(() => tree.some(({ pid }) => pidRunning(pid, true)), 30_000)
}

/**
 * Ends a Windows process, as the Windows table's `end`. Windows has no signal to ask with:
 * asking ends it alone, with TerminateProcess; forcibly, its tree (see `endTree`). Without a
 * reader a forcible end takes the process alone too: taskkill's tree goes by recorded parent
 * pids, which may name an unrelated process, and what the process started is still in the
 * sandbox, for the next round to find. `terminate` is TerminateProcess unless a test gives
 * another. Exported for its tests, as no process on Windows outlives the first ask long
 * enough to reach a forcible end there.
 */
export const endProcess = async (
  one: { readonly pid: number; readonly start: number },
  forcibly: boolean,
  trees: Trees | undefined,
  terminate: (pid: number) => void = (pid) => process.kill(pid),
): Promise<void> => {
  if (forcibly && trees) return endTree(one, trees)
  try {
    terminate(one.pid)
  } catch {
    // Gone meanwhile.
  }
}

/** Windows, from the lister, ending a forcibly ended process's tree through `trees`. */
export const windows = (trees: Trees | undefined): Table => ({
  list,
  // A pid alone, between listings: a process found a moment before isn't replaced by
  // another of the same pid that soon; `current` checks its start before it is ended.
  alive: (_sandbox, one) => pidRunning(one.pid, false),
  current: async (sandbox, found) => {
    const now = await list(sandbox)
    return found.filter((one) => now.some((it) => it.pid === one.pid && it.start === one.start))
  },
  end: (one, forcibly) => endProcess(one, forcibly, trees),
})
