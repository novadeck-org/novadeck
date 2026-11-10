import { spawn } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"

import { gitEnv, gitPath } from "../git.js"
import { killTree } from "../programs.js"

/**
 * What the agents listing says of a checkout beyond its branch: whether its head is detached;
 * how many commits its branch is ahead of its upstream, null without one it can compare to;
 * whether it names an upstream that is gone, as once a merged branch is deleted on its
 * remote; and whether anything in it is changed and not committed, untracked files included.
 */
export type GitState = {
  readonly detached: boolean
  readonly ahead: number | null
  readonly gone: boolean
  readonly dirty: boolean
}

/** How long one `git status` may run, in milliseconds, before it is ended. */
const runMs = 5_000
/** How much of its output is read: past it, the checkout is changed for certain. */
const capBytes = 256 * 1024

/**
 * A checkout's state from `git status --porcelain=v2 --branch`: `# branch.head (detached)`
 * says its head is detached; `# branch.upstream` names its upstream, and `# branch.ab +A -B`
 * says how far ahead of it it is, absent when that upstream is gone; any line that isn't a
 * header is a changed or untracked file. Output cut short counts as changed.
 */
export const parseStatus = (output: string, cut = false): GitState => {
  let detached = false
  let upstream = false
  let ahead: number | null = null
  let dirty = cut
  for (const line of output.split("\n")) {
    const ab = /^# branch\.ab \+(\d+) -\d+/.exec(line)
    if (ab) ahead = Number(ab[1])
    else if (line === "# branch.head (detached)") detached = true
    else if (line.startsWith("# branch.upstream ")) upstream = true
    else if (line !== "" && !line.startsWith("# ")) dirty = true
  }
  return { detached, ahead, gone: upstream && ahead === null, dirty }
}

/**
 * Runs `git status` in a checkout as the person's own git would, with optional locks off
 * (see `gitEnv`), no file monitor program the repository could name, submodules not walked,
 * no shell, and a time limit; null without git, outside a checkout, or when it fails or
 * takes too long. Agents run as the person, so what a repository's config runs here is
 * nothing its agent couldn't run itself.
 */
export const readGitState = (top: string): Promise<GitState | null> =>
  new Promise((done) => {
    const program = gitPath()
    if (!program) return done(null)
    let settled = false
    const finish = (state: GitState | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(state)
    }
    const child = spawn(
      program,
      [
        "-c",
        "core.fsmonitor=false",
        "status",
        "--porcelain=v2",
        "--branch",
        // Submodules aren't walked: no other repository's config is read, and it stays quick.
        "--ignore-submodules=all",
      ],
      {
        cwd: top,
        env: gitEnv(),
        // Its own group, so the time limit ends what it started too.
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    )
    const chunks: Buffer[] = []
    let size = 0
    let cut = false
    const timer = setTimeout(() => {
      killTree(child.pid)
      finish(null)
    }, runMs)
    child.stdout.on("data", (chunk: Buffer) => {
      if (cut) return
      size += chunk.length
      chunks.push(chunk)
      if (size <= capBytes) return
      cut = true
      killTree(child.pid)
      finish(parseStatus(Buffer.concat(chunks).toString("utf8"), true))
    })
    child.on("error", () => finish(null))
    child.on("close", (code) =>
      finish(code === 0 ? parseStatus(Buffer.concat(chunks).toString("utf8")) : null),
    )
  })

/** One checkout's state as last read, and when (null before a read finished); and the read under way. */
type Known = {
  state: GitState | null
  at: number | null
  reading: Promise<GitState | null> | undefined
}

/**
 * Each checkout's `GitState`, read by `git status` at most every few seconds. A state read
 * before is answered at once, and read again in the background once old, so a listing never
 * waits on a slow repository; a checkout never read is waited for only a moment, and is
 * unknown (null) past that until its read finishes.
 */
export class GitStates {
  private readonly known = new Map<string, Known>()

  constructor(
    private readonly read: (top: string) => Promise<GitState | null> = readGitState,
    private readonly now: () => number = Date.now,
    private readonly freshMs = 5_000,
    private readonly waitMs = 800,
  ) {}

  async of(top: string): Promise<GitState | null> {
    const known = this.known.get(top)
    // Read before: answered at once, and read again in the background once old.
    if (known && known.at !== null) {
      if (!known.reading && this.now() - known.at >= this.freshMs) this.refresh(top, known)
      return known.state
    }
    // Never read: every caller waits a moment on the one first read.
    const reading = known?.reading ?? this.refresh(top, known)
    const timeout = new AbortController()
    try {
      return await Promise.race([reading, sleep(this.waitMs, null, { signal: timeout.signal })])
    } catch {
      return null
    } finally {
      timeout.abort()
    }
  }

  private refresh(top: string, known: Known | undefined): Promise<GitState | null> {
    if (this.known.size > 256 && !known) this.known.clear()
    const entry: Known = known ?? { state: null, at: null, reading: undefined }
    const reading = this.read(top)
      .catch(() => null)
      .then((state) => {
        entry.state = state
        entry.at = this.now()
        entry.reading = undefined
        return state
      })
    entry.reading = reading
    this.known.set(top, entry)
    return reading
  }
}
