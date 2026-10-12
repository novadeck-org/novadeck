import { execFile } from "node:child_process"
import { join } from "node:path"
import { promisify } from "node:util"

/** A process of a terminal's tree: its pid and its start, which together name it alone. */
export type Member = { readonly pid: number; readonly startedAt: number }

/**
 * Runs Novadeck's relay with `args`, for its output, within `timeoutMs`; rejects where it
 * can't run.
 */
export type RunRelay = (
  relay: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<string>

/** A run's bound unless its callers ask for less, as the runner shutting down does. */
export const relayMs = 4_000

const runRelay: RunRelay = async (relay, args, timeoutMs) =>
  (await promisify(execFile)(relay, [...args], { windowsHide: true, timeout: timeoutMs })).stdout

/** How a tree is named to the relay: a process by its pid, or one read before by its start too. */
const rootName = (root: number | Member): string =>
  typeof root === "number" ? String(root) : `${root.pid}:${root.startedAt}`

/** One relay run's worth of asks, made in the same tick. */
type Batch<Ask, Answer> = {
  readonly asks: Ask[]
  /** The shortest bound its asks gave. */
  timeoutMs: number
  readonly done: Promise<Answer>
}

/**
 * A terminal's process tree on Windows, read and ended through Novadeck's relay
 * (`novadeck-relay tree` and `end`, see application/relay/src/processes.rs): Windows has
 * no process group, and keeps a process's parent pid after that parent ends, when
 * another process may get it. The relay counts a process as a child only if it started no
 * earlier than its recorded parent, and ends a process only if it started when the tree
 * was read. Calls in the same tick share one run, as a runner ending every terminal as it
 * shuts down makes them. Undefined, or nothing ended, where the relay can't run.
 */
export class Trees {
  private reading: Batch<string, Map<string, readonly Member[]> | undefined> | undefined
  private ending: Batch<Member, void> | undefined
  /** The subcommands whose failure was logged, once each. */
  private readonly failed = new Set<string>()

  constructor(
    private readonly relay: () => Promise<string | undefined>,
    private readonly run: RunRelay = runRelay,
  ) {}

  /**
   * The process `root` and every one under it, root first; undefined where unknown. A
   * root read before, named by its start, is walked from even once it has ended, so what
   * it started since, or left behind, is found too.
   */
  async read(root: number | Member, timeoutMs = relayMs): Promise<readonly Member[] | undefined> {
    const batch = (this.reading ??= this.batch((roots, ms) => this.readAll(roots, ms), "reading"))
    const name = rootName(root)
    batch.asks.push(name)
    batch.timeoutMs = Math.min(batch.timeoutMs, timeoutMs)
    return (await batch.done)?.get(name)
  }

  /** Ends each of `members` still running as the process it was; done once all are. */
  async end(members: readonly Member[], timeoutMs = relayMs): Promise<void> {
    if (members.length === 0) return
    const batch = (this.ending ??= this.batch((all, ms) => this.endAll(all, ms), "ending"))
    batch.asks.push(...members)
    batch.timeoutMs = Math.min(batch.timeoutMs, timeoutMs)
    await batch.done
  }

  private batch<Ask, Answer>(
    flush: (asks: readonly Ask[], timeoutMs: number) => Promise<Answer>,
    field: "reading" | "ending",
  ): Batch<Ask, Answer> {
    const asks: Ask[] = []
    const batch: Batch<Ask, Answer> = {
      asks,
      timeoutMs: relayMs,
      done: new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
        this[field] = undefined
        return flush(asks, batch.timeoutMs)
      }),
    }
    return batch
  }

  private async readAll(
    roots: readonly string[],
    timeoutMs: number,
  ): Promise<Map<string, readonly Member[]> | undefined> {
    const relay = await this.relay()
    if (relay === undefined) return undefined
    try {
      return trees(await this.run(relay, ["tree", ...new Set(roots)], timeoutMs))
    } catch (error) {
      this.unavailable("tree", error)
      return undefined
    }
  }

  private async endAll(members: readonly Member[], timeoutMs: number): Promise<void> {
    const relay = await this.relay()
    if (relay === undefined) return
    const named = [...new Set(members.map(rootName))]
    await this.run(relay, ["end", ...named], timeoutMs).catch((error: unknown) =>
      this.unavailable("end", error),
    )
  }

  // Each caller falls back where the relay fails, as taskkill; once a subcommand has failed,
  // it says so, so a stale or blocked relay shows.
  private unavailable(subcommand: string, error: unknown): void {
    if (this.failed.has(subcommand)) return
    this.failed.add(subcommand)
    console.error(
      `Novadeck's relay couldn't run "${subcommand}"; Novadeck falls back without it:`,
      error,
    )
  }
}

/** The relay's trees, by root as it was named, from its lines; one it couldn't read is left out. */
export const trees = (output: string): Map<string, readonly Member[]> => {
  const found = new Map<string, readonly Member[]>()
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const { root, processes } = JSON.parse(line) as { root?: unknown; processes?: unknown }
      if (typeof root !== "string" || !Array.isArray(processes)) continue
      found.set(
        root,
        processes.filter(
          (each): each is Member =>
            typeof each === "object" &&
            each !== null &&
            Number.isSafeInteger((each as Member).pid) &&
            Number.isSafeInteger((each as Member).startedAt),
        ),
      )
    } catch {
      // Not a line of the relay's.
    }
  }
  return found
}

/**
 * Ends a Windows process and every program it started, with taskkill, where the relay
 * can't read the tree: by recorded parent pids, which may name an unrelated process
 * whose pid an ended parent left.
 */
export const taskkillTree = async (pid: number, timeoutMs = 5_000): Promise<void> => {
  const windows = process.env.SystemRoot ?? "C:\\Windows"
  await promisify(execFile)(
    join(windows, "System32", "taskkill.exe"),
    ["/T", "/F", "/PID", String(pid)],
    { windowsHide: true, timeout: timeoutMs },
  )
}

/** Whether any of `members` may still run, by its pid alone: a check made again and again. */
export const anyRunning = (members: readonly Member[]): boolean =>
  members.some(({ pid }) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM"
    }
  })
