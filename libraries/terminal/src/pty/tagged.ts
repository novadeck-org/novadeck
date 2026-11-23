import { unscoped, type Scope, type ScopeMember, type Scopes } from "./scopes.js"
import { relayMs, runRelay, type RunRelay } from "./trees.js"

/** A process the relay found started with the variable, and the value it had. */
export type TaggedProcess = ScopeMember & { readonly startedMs: number; readonly value: string }

/**
 * The relay's `tagged` lines, `{"pid","startedUs","value"}` each, with the start in
 * milliseconds; a line that isn't one is left out.
 */
export const parseTagged = (output: string): TaggedProcess[] =>
  output.split("\n").flatMap((line) => {
    if (line.trim() === "") return []
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return []
    }
    const { pid, startedUs, value } = (parsed ?? {}) as Record<string, unknown>
    if (
      typeof pid !== "number" ||
      !Number.isSafeInteger(pid) ||
      pid <= 1 ||
      typeof startedUs !== "number" ||
      !Number.isFinite(startedUs) ||
      typeof value !== "string"
    )
      return []
    return [{ pid, startedMs: startedUs / 1000, value }]
  })

/**
 * macOS's scopes. macOS has no cgroup to keep a terminal's processes together, but each
 * shell starts with its terminal named in its environment (`variable`, as the runner's
 * `NOVADECK_TERMINAL_ID`), and every process keeps the environment it started with through
 * `setsid`, `nohup` and a double fork, and passes it on to what it starts. So a terminal's
 * members are the user's processes that started with its value, as the relay reads them
 * (`tagged`), each with its start to the microsecond, among the app's own resource
 * coalition, which a process keeps however it detached.
 *
 * Not members, as on Linux what left the scope isn't: what launchd started, in a coalition of
 * its own, as an app an agent opens (`open` passes it the caller's environment, the terminal's
 * value in it) or a launchd job; what started with the variable gone or changed (`env -i`);
 * and what macOS keeps the environment of from other processes (every Apple program, and apps
 * with restricted entitlements) or that wrote over its own (redis's and postgres's
 * `setproctitle`).
 *
 * Programs aren't moved, so a shell waits for nothing (`active`), and there is no weight or
 * cause to give. Every terminal that asks while a read is under way, as each does at a quit,
 * shares it. Where the relay can't run or read, members are unknown.
 */
export class TaggedScopes implements Scopes {
  private reading: Promise<readonly TaggedProcess[] | undefined> | undefined

  constructor(
    private readonly relay: () => Promise<string | undefined>,
    private readonly variable: string,
    private readonly run: RunRelay = runRelay,
  ) {}

  active(): boolean {
    return false
  }

  contain(_pid: number, env?: NodeJS.ProcessEnv): Scope {
    const value = env?.[this.variable]
    if (!value) return unscoped
    return {
      ...unscoped,
      members: async () =>
        (await this.read())
          ?.filter((each) => each.value === value)
          .map(({ pid, startedMs }) => ({ pid, startedMs })),
    }
  }

  private read(): Promise<readonly TaggedProcess[] | undefined> {
    this.reading ??= (async () => {
      const relay = await this.relay()
      if (relay === undefined) return undefined
      return parseTagged(await this.run(relay, ["tagged", this.variable], relayMs))
    })()
      .catch(() => undefined)
      .finally(() => {
        this.reading = undefined
      })
    return this.reading
  }
}

/** Scopes by `variable` (`TaggedScopes`) on macOS, through `relay`; elsewhere none. */
export const taggedScopes = (
  relay: () => Promise<string | undefined>,
  variable: string,
  platform: NodeJS.Platform = process.platform,
): Scopes | undefined => (platform === "darwin" ? new TaggedScopes(relay, variable) : undefined)
